/**
 * The side-effecting half of "Review open tickets": ONE read-only agent run in the project's
 * repo that reads its open tickets and ends with the fenced report `@shared/boardReview`
 * parses. `boardReviewPrompt.ts` writes the prompt; this file gathers its input, starts the
 * run, and stores what came back as a `board_reviews` row.
 *
 * Nothing here applies a recommendation — the report is only stored and shown.
 *
 * - **One run per project.** A second start while one is running returns the running one; the
 *   slot is reserved before anything else happens, so a double click cannot start two.
 * - **Read-only.** The session runs in plan mode with every editing tool taken away — the same
 *   request the AI visual reviewer makes ({@link AI_REVIEW_DISALLOWED_TOOLS}).
 * - **Always settles.** A result is parsed into `done` (or `failed` with the parser's error);
 *   an exit without a result, a Stop, or a session that never started is `failed`. Every
 *   status change is pushed as `project:boardReviewChanged`.
 */
import { columnForStatus, isBoardCard } from '@shared/board';
import { parseBoardReviewReport, type BoardReviewRecord } from '@shared/boardReview';
import { hasRepo, resolveRoleEffort, resolveRoleModel, type Task } from '@shared/model';
import type { StartSessionRequest } from '@shared/session';
import { buildBoardReviewPrompt, type BoardReviewPromptInput } from './boardReviewPrompt';
import { AI_REVIEW_DISALLOWED_TOOLS } from './forge/aiVisualReviewer';
import type { Store } from './store';

/** The store reads and writes a review needs — a slice, so tests can fake it. */
export type BoardReviewerStore = Pick<
  Store,
  | 'getProject'
  | 'getSettings'
  | 'getBoardTasks'
  | 'listMilestones'
  | 'listTaskLinks'
  | 'listTicketLinks'
  | 'startBoardReview'
  | 'finishBoardReview'
>;

export interface BoardReviewerDeps {
  store: BoardReviewerStore;
  /** `Scheduler.startAuxiliarySession` — `onResult` gets the turn's `resultText`, `onExit`
   *  fires once the process is gone either way. An empty `runId` means nothing started. */
  startSession(
    projectId: string,
    request: StartSessionRequest,
    onResult: (resultText: string) => void,
    onExit?: () => void,
  ): { runId: string };
  /** `Scheduler.stopAuxiliarySession`. */
  stopSession(runId: string): void;
  now(): number;
  /** Push `project:boardReviewChanged`. */
  emit(projectId: string, review: BoardReviewRecord): void;
}

export interface BoardReviewStart {
  reviewId: string | null;
  error?: string;
}

export interface BoardReviewer {
  /** The prompt's input for the project, from the store — `null` for an unknown project. */
  collectInput(projectId: string): BoardReviewPromptInput | null;
  /** Start a review, or return the one already running. Refuses without a project or repo. */
  start(projectId: string): Promise<BoardReviewStart>;
  /** Stop the project's running review, if any; it settles as `failed`. */
  stop(projectId: string): void;
  /** Whether a review is running for the project (tests and diagnostics). */
  isRunning(projectId: string): boolean;
}

/** One review in flight. `runId` is null while its session is still being started. */
interface ActiveReview {
  id: string;
  runId: string | null;
}

export const BOARD_REVIEW_NO_PROJECT = 'No such project.';
export const BOARD_REVIEW_NO_REPO = 'This project has no repository to review.';
export const BOARD_REVIEW_NOT_STARTED = 'The review session could not start.';
export const BOARD_REVIEW_NO_RESULT = 'The review session ended without a result.';
export const BOARD_REVIEW_STOPPED = 'stopped';

/** When a finished ticket finished, as near as a card records it — newest first sorts on it. */
function finishedAt(task: Task): number {
  return task.stoppedAt ?? task.workedAt ?? 0;
}

export function createBoardReviewer(deps: BoardReviewerDeps): BoardReviewer {
  const { store } = deps;
  const active = new Map<string, ActiveReview>();

  function collectInput(projectId: string): BoardReviewPromptInput | null {
    const project = store.getProject(projectId);
    if (!project) return null;
    const cards = store.getBoardTasks(projectId).filter(isBoardCard);
    const epics = cards.filter((t) => t.issueType === 'epic');
    const tickets = cards.filter((t) => t.issueType !== 'epic');
    const ids = new Set(cards.map((t) => t.id));
    const onBoard = (l: { fromTaskId: string; toTaskId: string }) =>
      ids.has(l.fromTaskId) || ids.has(l.toTaskId);
    return {
      projectName: project.name,
      cap: project.readyLanes,
      openTickets: tickets.filter((t) => columnForStatus(t.status) !== 'done'),
      doneTickets: tickets
        .filter((t) => columnForStatus(t.status) === 'done')
        .sort((a, b) => finishedAt(b) - finishedAt(a)),
      epics,
      milestones: store.listMilestones(projectId),
      ticketLinks: store.listTicketLinks().filter(onBoard),
      taskLinks: store.listTaskLinks().filter(onBoard),
    };
  }

  /** Settle a review that is still the project's active one, and push the change. */
  function finish(
    projectId: string,
    run: ActiveReview,
    outcome: Parameters<BoardReviewerStore['finishBoardReview']>[1],
  ): void {
    if (active.get(projectId) !== run) return;
    active.delete(projectId);
    const record = store.finishBoardReview(run.id, outcome);
    if (record) deps.emit(projectId, record);
  }

  async function start(projectId: string): Promise<BoardReviewStart> {
    const running = active.get(projectId);
    if (running) return { reviewId: running.id };
    const project = store.getProject(projectId);
    if (!project) return { reviewId: null, error: BOARD_REVIEW_NO_PROJECT };
    if (!hasRepo(project)) return { reviewId: null, error: BOARD_REVIEW_NO_REPO };

    // Reserved before anything that could throw or wait, so a second start mid-way finds it.
    const record = store.startBoardReview(projectId, deps.now());
    const run: ActiveReview = { id: record.id, runId: null };
    active.set(projectId, run);
    deps.emit(projectId, record);

    try {
      const input = collectInput(projectId)!;
      const { prompt, refs } = buildBoardReviewPrompt(input);
      const { runId } = deps.startSession(
        projectId,
        {
          prompt,
          cwd: project.path,
          // The reviewer role with no card: the board is the project's, not one ticket's.
          model: resolveRoleModel('reviewer', null, project),
          effort: resolveRoleEffort('reviewer', null, project, store.getSettings()),
          permissionMode: 'plan',
          disallowedTools: AI_REVIEW_DISALLOWED_TOOLS,
        },
        (resultText) => {
          const parsed = parseBoardReviewReport(resultText, refs, input.cap);
          finish(
            projectId,
            run,
            parsed.ok
              ? { status: 'done', report: parsed.report, finishedAt: deps.now() }
              : { status: 'failed', error: parsed.error, finishedAt: deps.now() },
          );
        },
        () =>
          finish(projectId, run, {
            status: 'failed',
            error: BOARD_REVIEW_NO_RESULT,
            finishedAt: deps.now(),
          }),
      );
      if (!runId) {
        finish(projectId, run, {
          status: 'failed',
          error: BOARD_REVIEW_NOT_STARTED,
          finishedAt: deps.now(),
        });
        return { reviewId: record.id, error: BOARD_REVIEW_NOT_STARTED };
      }
      if (active.get(projectId) === run) run.runId = runId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish(projectId, run, { status: 'failed', error: message, finishedAt: deps.now() });
      return { reviewId: record.id, error: message };
    }
    return { reviewId: record.id };
  }

  return {
    collectInput,
    start,

    stop(projectId) {
      const run = active.get(projectId);
      if (!run) return;
      const { runId } = run;
      finish(projectId, run, {
        status: 'failed',
        error: BOARD_REVIEW_STOPPED,
        finishedAt: deps.now(),
      });
      if (runId) deps.stopSession(runId);
    },

    isRunning(projectId) {
      return active.has(projectId);
    },
  };
}
