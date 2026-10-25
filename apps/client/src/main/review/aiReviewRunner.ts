/**
 * The engine that RUNS an AI review (F16.8): the queue, the refusals, the launch and the
 * settle path. Everything it needs is injected, so it is tested against a real `Scheduler`
 * with a fake session and never needs Electron.
 *
 * One review at a time per desktop. `start()` refuses, as data and before anything is spent,
 * or creates the row `queued` and pumps. The pump takes the oldest queued review when none is
 * running: a detached worktree at the pinned head, the prompt, a gated read-only session.
 *
 * The settle path, for each `result`, ignoring anything once the review has settled (memory
 * *a-park-settled-over-by-its-own-result*):
 *  1. the cost so far onto the row (live cost);
 *  2. a sign-in, then a usage-limit wall — `failed` with the detection's reason (F16.9 turns
 *     {@link AiReviewRunner.onWall} into a park);
 *  3. `parseFindings` → `validateFindings` against the diff pinned at start;
 *  4. a bad envelope earns ONE repair turn naming the errors; a second ends the run `failed`,
 *     errors and raw reply kept, no drafts;
 *  5. otherwise every finding lands as a draft in ONE transaction (`addAiDrafts`) and the
 *     row is finalised `done`.
 * Then always: stop the session, emit, remove the worktree, pump the next review.
 */
import { randomUUID } from 'node:crypto';
import {
  findingToDraft,
  parseFindings,
  validateFindings,
  type AiReview,
  type AiReviewRequester,
  type FindingsValidation,
} from '@shared/aiReview';
import type { Project } from '@shared/model';
import type {
  ClaudeModel,
  SessionEvent,
  SettingSource,
  StartSessionRequest,
} from '@shared/session';
import { detectAuthFailure } from '../authGate';
import { missingReviewSandboxFlags, type ClaudeCliCapabilities } from '../claudeCapabilities';
import { detectLimitFailure } from '../limitGate';
import { logMain } from '../log';
import {
  REVIEW_GIT_SUBCOMMANDS,
  REVIEW_READ_TOOLS,
  type ReviewToolDenial,
} from '../permissionPolicy';
import type { Scheduler } from '../scheduler';
import type { Store } from '../store';
import {
  isRefusal,
  type AiReviewRefusal,
  type AiReviewRefusalCode,
  type AiReviewSubjectSource,
  type ReviewTarget,
} from './aiReviewSubjects';
import { buildReviewPrompt } from './reviewPrompt';
import type { ReviewWorktrees } from './reviewWorktrees';

export type { AiReviewRefusal, AiReviewRefusalCode };

/** The only tools a review may use: the read tools, and git's read subcommands. */
export const REVIEW_ALLOWED_TOOLS: readonly string[] = [
  ...REVIEW_READ_TOOLS,
  ...REVIEW_GIT_SUBCOMMANDS.map((sub) => `Bash(git ${sub}:*)`),
];
/** Tools the CLI never offers a review, whatever the permission gate would answer. */
export const REVIEW_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
];
/** A PR is untrusted input: its `.claude/settings.json` (and the hooks it adds) never loads. */
export const REVIEW_SETTING_SOURCES: readonly SettingSource[] = ['user'];

/** The model a review runs on. F16.10 adds the `reviewModel` rung in front. */
export function reviewModelFor(
  project: Pick<Project, 'planningModel' | 'defaultModel'>,
): ClaudeModel {
  return project.planningModel ?? project.defaultModel;
}

/** The launch request for one review: read-only by construction, not by request. */
export function reviewLaunchRequest(
  cwd: string,
  prompt: string,
  model: ClaudeModel,
): StartSessionRequest {
  return {
    prompt,
    cwd,
    model,
    // Gated, so `buildClaudeArgs` sends `--permission-mode default` and every tool use not
    // pre-allowed reaches the deny-only review policy.
    permissionMode: 'manual',
    allowedTools: REVIEW_ALLOWED_TOOLS,
    disallowedTools: REVIEW_DISALLOWED_TOOLS,
    settingSources: REVIEW_SETTING_SOURCES,
    strictMcpConfig: true,
  };
}

/** The one repair turn: what was wrong with the reply, and the contract restated. */
export function repairPrompt(errors: readonly string[]): string {
  return [
    'Your review could not be read:',
    '',
    ...errors.map((e) => `- ${e}`),
    '',
    'Answer again with the whole review. End your reply with exactly one ```json block',
    'holding `{ "summary", "verdict", "findings" }` as the output contract describes, and',
    'nothing after it. Do not modify any files.',
  ].join('\n');
}

export interface AiReviewRunnerDeps {
  store: Pick<
    Store,
    | 'createAiReview'
    | 'getAiReview'
    | 'listAiReviews'
    | 'updateAiReview'
    | 'addAiDrafts'
    | 'getTask'
  >;
  scheduler: Pick<
    Scheduler,
    | 'startReviewSession'
    | 'sendToReviewSession'
    | 'stopReviewSession'
    | 'reviewBlockers'
    | 'activeRuns'
  >;
  worktrees: Pick<ReviewWorktrees, 'create' | 'remove'>;
  subjects: AiReviewSubjectSource;
  /** `probeClaudeCapabilities` on the project's host; null = unknown. */
  probe(project: Project): Promise<ClaudeCliCapabilities | null>;
  /** `aiReview:changed` — F16.11 wires it to the renderer and the relay. */
  emitChanged(review: AiReview): void;
  now?(): number;
  newId?(): string;
}

/** One review this runner is holding: queued, or the one running. */
interface Live {
  id: string;
  subjectId: string;
  target: ReviewTarget;
  model: ClaudeModel;
  runId: string | null;
  /** The outcome is decided — anything that arrives after this is ignored. */
  settled: boolean;
  /** The one repair turn has been spent. */
  repaired: boolean;
  /** The worktree exists and is this review's to remove. */
  worktree: boolean;
  denials: ReviewToolDenial[];
}

type ResultEvent = Extract<SessionEvent, { kind: 'result' }>;
type Finish = Partial<Omit<AiReview, 'id' | 'subjectId'>> & { resultText?: string | null };

export class AiReviewRunner {
  private readonly queue: Live[] = [];
  private running: Live | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: AiReviewRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Ask for a review of `subjectId`. A refusal creates no row; otherwise the review is
   * queued — and started at once when nothing else is running.
   */
  async start(
    subjectId: string,
    requestedBy: AiReviewRequester,
  ): Promise<AiReview | AiReviewRefusal> {
    if (this.disposed) return refuse('shutting-down', 'the app is shutting down');
    const target = await this.deps.subjects.resolve(subjectId);
    if (isRefusal(target)) return target;
    const caps = await this.deps.probe(target.project);
    // Every check from here on is synchronous, so two clicks cannot both pass `duplicate`.
    if (this.disposed) return refuse('shutting-down', 'the app is shutting down');

    const { diffId, headSha } = target.summary;
    const earlier = this.deps.store.listAiReviews(subjectId).filter((r) => r.diffId === diffId);
    if (earlier.some((r) => r.status === 'queued' || r.status === 'running')) {
      return refuse('duplicate', 'a review of these changes is already under way');
    }
    if (earlier.some((r) => r.status === 'done')) {
      return refuse('already-reviewed', 'these changes have already been reviewed');
    }
    if (subjectId.startsWith('task:') && target.taskId && this.cardIsRunning(target.taskId)) {
      return refuse('card-running', 'the card is running — its changes are still moving');
    }
    if (!caps) {
      return refuse(
        'sandbox-unsupported',
        "update Claude Code — couldn't tell whether this CLI can run a read-only review",
      );
    }
    const missing = missingReviewSandboxFlags(caps);
    if (missing.length > 0) {
      return refuse(
        'sandbox-unsupported',
        `update Claude Code — this CLI lacks ${missing.join(', ')}`,
      );
    }
    const blockers = this.deps.scheduler.reviewBlockers();
    const gate = blockers.signin ?? blockers.limit;
    if (gate) return refuse('gate-up', gate);

    const live: Live = {
      id: this.newId(),
      subjectId,
      target,
      model: reviewModelFor(target.project),
      runId: null,
      settled: false,
      repaired: false,
      worktree: false,
      denials: [],
    };
    const review = this.deps.store.createAiReview({
      id: live.id,
      subjectId,
      diffId,
      headSha,
      status: 'queued',
      parkReason: null,
      model: live.model,
      startedAt: null,
      finishedAt: null,
      costUsd: null,
      tokens: null,
      summary: null,
      verdict: null,
      error: null,
      requestedBy,
    });
    this.queue.push(live);
    this.deps.emitChanged(review);
    this.pump();
    return review;
  }

  /** Cancel a queued or running review. False when it is unknown or already finished. */
  async cancel(id: string): Promise<boolean> {
    const queued = this.queue.findIndex((l) => l.id === id);
    if (queued !== -1) {
      const [live] = this.queue.splice(queued, 1);
      live.settled = true;
      this.write(live, { status: 'cancelled', finishedAt: this.now() });
      return true;
    }
    const live = this.running;
    if (!live || live.id !== id || live.settled) return false;
    await this.finish(live, { status: 'cancelled' });
    return true;
  }

  list(subjectId: string): AiReview[] {
    return this.deps.store.listAiReviews(subjectId);
  }

  get(id: string): AiReview | undefined {
    return this.deps.store.getAiReview(id);
  }

  /** App quit: cancel everything live, start nothing. Called before the DB closes. */
  dispose(): void {
    this.disposed = true;
    for (const live of this.queue.splice(0)) {
      live.settled = true;
      this.write(live, { status: 'cancelled', finishedAt: this.now() });
    }
    if (this.running && !this.running.settled)
      void this.finish(this.running, { status: 'cancelled' });
  }

  /** Start the oldest queued review, if nothing is running. */
  private pump(): void {
    if (this.disposed || this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = next;
    void this.launch(next);
  }

  private async launch(live: Live): Promise<void> {
    const { project, summary, prompt, taskId } = live.target;
    this.write(live, { status: 'running', startedAt: this.now() });
    try {
      const made = await this.deps.worktrees.create(project, live.id, summary.headSha);
      if (live.settled) {
        // Cancelled while git was still checking out: the worktree is ours to clean up.
        if (made.ok) await this.deps.worktrees.remove(project, live.id);
        return;
      }
      if (!made.ok) {
        await this.finish(live, { status: 'failed', error: made.reason });
        return;
      }
      live.worktree = true;
      const request = reviewLaunchRequest(made.path, buildReviewPrompt(prompt), live.model);
      const { runId } = this.deps.scheduler.startReviewSession(project.id, live.id, request, {
        taskId,
        onDenied: (denial) => live.denials.push(denial),
        onResult: (event) => void this.onResult(live, event),
        onExit: () => void this.onExit(live),
      });
      if (!runId) {
        await this.finish(live, { status: 'failed', error: 'the app is shutting down' });
        return;
      }
      live.runId = runId;
    } catch (err) {
      if (!live.settled) {
        await this.finish(live, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async onResult(live: Live, event: ResultEvent): Promise<void> {
    if (live.settled) return;
    // The CLI reports the session's running totals on each `result`, so the latest is the
    // review's cost so far — not something to add to.
    const row = this.deps.store.getAiReview(live.id);
    this.write(live, {
      costUsd: event.costUsd ?? row?.costUsd ?? null,
      tokens: event.usage ?? row?.tokens ?? null,
    });

    const auth = event.success ? null : detectAuthFailure(event);
    if (auth) return this.onWall(live, 'signin', auth);
    const limit = detectLimitFailure(event);
    if (limit) {
      const resets = limit.resetsAt
        ? `, resets ${new Date(limit.resetsAt * 1000).toLocaleTimeString()}`
        : '';
      return this.onWall(live, 'limit', `usage limit reached${resets}`);
    }

    const { target } = live;
    const parsed = parseFindings(event.resultText);
    const checked: Pick<FindingsValidation, 'ok' | 'errors'> & Partial<FindingsValidation> =
      parsed.ok
        ? validateFindings(parsed.value, target.summary, target.files)
        : { ok: false, errors: [parsed.error] };

    if (!checked.ok) {
      if (!live.repaired && live.runId) {
        live.repaired = true;
        this.deps.scheduler.sendToReviewSession(live.runId, repairPrompt(checked.errors));
        return;
      }
      return this.finish(live, {
        status: 'failed',
        error: checked.errors.join('; '),
        resultText: event.resultText,
      });
    }

    const v = checked as FindingsValidation;
    const { subjectId } = live;
    const diffId = target.summary.diffId;
    try {
      const drafts = v.findings.map((f) => findingToDraft(f, { id: live.id, subjectId, diffId }));
      if (drafts.length > 0) this.deps.store.addAiDrafts(drafts, this.now());
    } catch (err) {
      return this.finish(live, {
        status: 'failed',
        error: `the findings could not be saved: ${err instanceof Error ? err.message : String(err)}`,
        resultText: event.resultText,
      });
    }
    const summary = v.cut > 0 ? `${v.summary} (${v.cut} more findings were cut)` : v.summary;
    return this.finish(live, {
      status: 'done',
      summary,
      verdict: v.verdict,
      findingCount: v.findings.length,
      droppedCount: v.dropped,
      resultText: event.resultText,
    });
  }

  /**
   * A sign-in or usage-limit wall. F16.8 ends the review `failed` with the reason; F16.9
   * replaces this body with a park in the gate.
   */
  private onWall(live: Live, _kind: 'signin' | 'limit', reason: string): Promise<void> {
    return this.finish(live, { status: 'failed', error: reason });
  }

  private async onExit(live: Live): Promise<void> {
    if (live.settled) return;
    await this.finish(live, {
      status: 'failed',
      error: 'the review session ended without an answer',
    });
  }

  /** Settle a review: the row, the session, the worktree, then the next review. */
  private async finish(live: Live, patch: Finish): Promise<void> {
    if (live.settled) return;
    live.settled = true;
    const denied = live.denials.map((d) => `${d.detail} (${d.reason})`);
    if (denied.length > 0) {
      if (patch.status === 'failed') {
        patch = {
          ...patch,
          error: `${patch.error ?? ''} — denied tool uses: ${denied.join('; ')}`,
        };
      } else {
        logMain(`AI review ${live.id}: denied tool uses: ${denied.join('; ')}`);
      }
    }
    this.write(live, { ...patch, finishedAt: this.now() });
    if (live.runId) this.deps.scheduler.stopReviewSession(live.runId);
    if (live.worktree) {
      live.worktree = false;
      const why = await this.deps.worktrees.remove(live.target.project, live.id);
      if (why) logMain(`AI review ${live.id}: could not remove its worktree: ${why}`);
    }
    if (this.running === live) {
      this.running = null;
      this.pump();
    }
  }

  /** Patch the row and say so. A row that has vanished is not worth failing over. */
  private write(live: Live, patch: Finish): void {
    const review = this.deps.store.updateAiReview(live.id, patch);
    if (review) this.deps.emitChanged(review);
  }

  /** The card — or any step of it — has a live run: its worktree is moving. */
  private cardIsRunning(taskId: string): boolean {
    const ownerOf = (id: string): string => this.deps.store.getTask(id)?.parentTaskId || id;
    const owner = ownerOf(taskId);
    return this.deps.scheduler.activeRuns().some((run) => ownerOf(run.taskId) === owner);
  }
}

function refuse(refused: AiReviewRefusalCode, reason: string): AiReviewRefusal {
  return { refused, reason };
}
