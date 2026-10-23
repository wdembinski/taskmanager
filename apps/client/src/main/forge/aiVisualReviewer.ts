/**
 * The side-effecting half of "Visual sign-off by AI reviewer" — the project setting that lets
 * a fresh, read-only review session judge a UI card's shots instead of waiting for the owner's
 * Approve. `@shared/aiVisualReview` owns every decision; this file only carries them out.
 *
 * `requestAutoMerge` calls {@link AiVisualReviewer.onAwaitSignOff} whenever a UI card's
 * auto-merge is held for sign-off — on every push. The reviewer then:
 *
 * - **approve** — posts `Visual sign-off: approved (AI reviewer)` through the same path as
 *   the human's button, which arms auto-merge.
 * - **needs changes** — leaves a needs-changes note (never a `Visual sign-off:` comment, so
 *   the gate stays `pending`) and adds a fix step. The fix step re-shoots and pushes, the
 *   push reaches `await-sign-off` again, and that is the next review.
 * - **out of rounds, or no readable verdict** — leaves a note and raises the card in the
 *   Inbox, once.
 *
 * A human's own verdict always wins: {@link AiVisualReviewer.cancel} stops a review in
 * flight, and a result that lands after any `Visual sign-off:` comment is discarded.
 */
import type { TaskAttachment } from '@shared/attachments';
import {
  aiReviewGaveUpNote,
  aiReviewInboxQuestion,
  aiReviewInvalidInboxQuestion,
  aiReviewInvalidNote,
  aiReviewNeedsChangesNote,
  aiReviewNext,
  aiReviewOutcome,
  aiReviewRoundsSoFar,
  aiReviewStartedNote,
  aiReviewSuperseded,
  clampAiReviewMaxRounds,
  parseAiReviewVerdict,
  type AiReviewVerdict,
} from '@shared/aiVisualReview';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { StartSessionRequest } from '@shared/session';
import { latestVisualState, shotPairs } from '@shared/visualSignOff';
import { buildAiReviewPrompt } from '../aiReviewPrompt';

/** The tools a review session is never offered — it only looks (Read) and answers. */
export const AI_REVIEW_DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
] as const;

/** The start of every Inbox question the reviewer raises — how the human's own verdict
 *  knows the open decision is the reviewer's to withdraw. */
const AI_REVIEW_DECISION_PREFIX = 'AI visual review';

/** Whether a card's open decision was raised by the AI reviewer. */
export function isAiReviewDecision(question: string | null | undefined): boolean {
  return !!question && question.startsWith(AI_REVIEW_DECISION_PREFIX);
}

export interface AiVisualReviewerDeps {
  getTask(taskId: string): Task | undefined;
  getProject(projectId: string): Project | undefined;
  /** The card's steps, in order. */
  listSubtasks(ownerId: string): Task[];
  listAttachments(taskId: string): TaskAttachment[];
  listActivity(taskId: string): TaskActivityEntry[];
  /** An attachment's absolute path on the machine `project`'s sessions run on. */
  attachmentPath(project: Project, attachment: TaskAttachment): string;
  /** Where the review session runs — the card's worktree, or the project itself. */
  cwdFor(project: Project, owner: Task): Promise<string>;
  note(projectId: string, taskId: string, body: string): void;
  now(): number;
  /** `Scheduler.startAuxiliarySession` — `onResult` gets the turn's `resultText`, `onExit`
   *  fires once the process is gone either way. An empty `runId` means nothing started. */
  startSession(
    projectId: string,
    request: StartSessionRequest,
    onResult: (resultText: string) => void,
    onExit?: () => void,
  ): { runId: string };
  stopRun(runId: string): void;
  /** Post the AI's `Visual sign-off: approved (AI reviewer)`, then `applyVisualSignOff`. */
  signOffApproved(ownerId: string): Promise<void>;
  /** `store.addSubtask` on the OWNER — a step can never hold steps of its own. */
  addFixStep(ownerId: string, title: string, description: string): void;
  /** Start the card's next runnable step — `Scheduler.startTaskNow`. */
  runCard(ownerId: string): void;
  /** Raise an owner decision in the Inbox — `Scheduler.setDecision`. */
  raiseInbox(ownerId: string, question: string): void;
}

export interface AiVisualReviewer {
  /** A UI card's auto-merge is held for sign-off — review it, if the project says so. */
  onAwaitSignOff(projectId: string, ownerId: string): Promise<void>;
  /** A human gave their own verdict — stop any review in flight and drop its result. */
  cancel(ownerId: string): void;
  /** Whether a review is in flight for the card (tests and diagnostics). */
  isReviewing(ownerId: string): boolean;
}

/** One review in flight. `runId` is null while its session is still being started. */
interface Review {
  projectId: string;
  startedAt: number;
  runId: string | null;
  cancelled: boolean;
}

const NO_VERDICT: AiReviewVerdict = { verdict: 'needs-changes', screens: [], outOfScope: [] };

/**
 * The fix step a needs-changes review adds — the reasons, and what to do with them.
 * `uiVerifyCommand` is the project's own screenshot command; empty names it generically.
 */
export function aiReviewFixStepDescription(
  verdict: AiReviewVerdict,
  uiVerifyCommand?: string,
): string {
  const reasons = verdict.screens
    .filter((s) => s.status === 'mismatch')
    .map((s) => `- ${s.screen}: ${s.reason || 'flagged, no reason given'}`);
  const command = (uiVerifyCommand ?? '').trim();
  const retake = command
    ? `re-run \`${command}\``
    : "re-take the shots with the project's screenshot command";
  return [
    'The AI visual reviewer flagged these screens:',
    '',
    ...(reasons.length > 0 ? reasons : ['- (no screen named — see the review note)']),
    '',
    `Fix ONLY these findings; change nothing else. Then ${retake}, rewrite ` +
      '`verdicts.txt` for the new shots, and commit.',
  ].join('\n');
}

export function createAiVisualReviewer(deps: AiVisualReviewerDeps): AiVisualReviewer {
  const reviews = new Map<string, Review>();

  /** The card's own timeline project — where a note lands, as the human's button does. */
  const noteOn = (owner: Task, body: string) => deps.note(owner.projectId, owner.id, body);

  const giveUp = (owner: Task, rounds: number, verdict: AiReviewVerdict) => {
    noteOn(owner, aiReviewGaveUpNote(rounds, verdict));
    deps.raiseInbox(owner.id, aiReviewInboxQuestion(rounds));
  };

  const invalid = (owner: Task) => {
    noteOn(owner, aiReviewInvalidNote());
    deps.raiseInbox(owner.id, aiReviewInvalidInboxQuestion());
  };

  async function onResult(ownerId: string, review: Review, resultText: string): Promise<void> {
    if (reviews.get(ownerId) !== review || review.cancelled) return;
    reviews.delete(ownerId);
    const owner = deps.getTask(ownerId);
    const project = deps.getProject(review.projectId);
    if (!owner || !project) return;
    const activity = deps.listActivity(ownerId);
    if (aiReviewSuperseded(activity, review.startedAt)) return;

    const maxRounds = clampAiReviewMaxRounds(project.autoVisualSignOffMaxRounds);
    const roundsSoFar = aiReviewRoundsSoFar(activity);
    const verdict = parseAiReviewVerdict(resultText);
    const outcome = aiReviewOutcome(verdict, roundsSoFar, maxRounds);

    if (outcome === 'invalid' || !verdict) {
      invalid(owner);
      return;
    }
    if (outcome === 'approve') {
      await deps.signOffApproved(ownerId);
      return;
    }
    if (outcome === 'exhausted') {
      giveUp(owner, roundsSoFar + 1, verdict);
      return;
    }
    const round = roundsSoFar + 1;
    noteOn(owner, aiReviewNeedsChangesNote(round, maxRounds, verdict));
    deps.addFixStep(
      ownerId,
      `Fix the visual review findings (round ${round})`,
      aiReviewFixStepDescription(verdict, project.uiVerifyCommand),
    );
    deps.runCard(ownerId);
  }

  /** The session ended with no result (crashed, or stopped by the project's Stop). */
  function onExit(ownerId: string, review: Review): void {
    if (reviews.get(ownerId) !== review || review.cancelled) return;
    reviews.delete(ownerId);
    const owner = deps.getTask(ownerId);
    if (owner && !aiReviewSuperseded(deps.listActivity(ownerId), review.startedAt)) {
      invalid(owner);
    }
  }

  async function start(project: Project, owner: Task, review: Review): Promise<void> {
    const maxRounds = clampAiReviewMaxRounds(project.autoVisualSignOffMaxRounds);
    const activity = deps.listActivity(owner.id);
    const { pairs } = shotPairs(deps.listAttachments(owner.id));
    const rows = latestVisualState(
      activity,
      pairs.map((p) => p.name),
    ).rows;
    const round = aiReviewRoundsSoFar(activity) + 1;

    const prompt = buildAiReviewPrompt({
      ticketTitle: owner.title,
      ticketText: owner.externalDescription ?? owner.description ?? '',
      stepTitles: deps.listSubtasks(owner.id).map((s) => s.title),
      screens: pairs.map((p) => {
        const row = rows.get(p.name);
        return {
          name: p.name,
          realPath: deps.attachmentPath(project, p.real),
          ...(p.mockup ? { mockupPath: deps.attachmentPath(project, p.mockup) } : {}),
          builderStatus: row?.status ?? 'unknown',
          builderNote: row?.note ?? '',
        };
      }),
      round,
      maxRounds,
    });
    const cwd = await deps.cwdFor(project, owner);
    if (reviews.get(owner.id) !== review || review.cancelled) return;

    noteOn(owner, aiReviewStartedNote(round, maxRounds));
    const { runId } = deps.startSession(
      project.id,
      {
        prompt,
        cwd,
        model: project.planningModel ?? project.defaultModel,
        permissionMode: 'plan',
        disallowedTools: AI_REVIEW_DISALLOWED_TOOLS,
      },
      (resultText) => {
        void onResult(owner.id, review, resultText).catch((err) =>
          noteOn(
            owner,
            `AI visual review failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
      () => onExit(owner.id, review),
    );
    if (!runId) {
      if (reviews.get(owner.id) === review) reviews.delete(owner.id);
      return;
    }
    review.runId = runId;
  }

  return {
    async onAwaitSignOff(projectId, ownerId) {
      if (reviews.has(ownerId)) return;
      const project = deps.getProject(projectId);
      const owner = deps.getTask(ownerId);
      if (!project || !owner) return;
      const maxRounds = clampAiReviewMaxRounds(project.autoVisualSignOffMaxRounds);
      const activity = deps.listActivity(ownerId);
      const next = aiReviewNext({ enabled: project.autoVisualSignOff, maxRounds, activity });
      if (next === 'await-human') return;
      if (next === 'exhausted') {
        giveUp(owner, aiReviewRoundsSoFar(activity), NO_VERDICT);
        return;
      }
      if (shotPairs(deps.listAttachments(ownerId)).pairs.length === 0) return;

      // Reserved before the first await, so a second push mid-start cannot start a second
      // session for the same card.
      const review: Review = { projectId, startedAt: deps.now(), runId: null, cancelled: false };
      reviews.set(ownerId, review);
      try {
        await start(project, owner, review);
      } catch (err) {
        if (reviews.get(ownerId) === review) reviews.delete(ownerId);
        noteOn(
          owner,
          `AI visual review could not start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    cancel(ownerId) {
      const review = reviews.get(ownerId);
      if (!review) return;
      review.cancelled = true;
      reviews.delete(ownerId);
      if (review.runId) deps.stopRun(review.runId);
    },

    isReviewing(ownerId) {
      return reviews.has(ownerId);
    },
  };
}
