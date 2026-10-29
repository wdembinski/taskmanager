/**
 * The engine that RUNS an AI review (F16.8): the queue, the refusals, the launch and the
 * settle path. Everything it needs is injected, so it is tested against a real `Scheduler`
 * with a fake session and never needs Electron.
 *
 * One review at a time per desktop. `start()` refuses, as data and before anything is spent,
 * or creates the row `queued` and pumps. The pump takes the oldest queued review when none is
 * running: a detached worktree at the pinned head, the prompt, a gated read-only session.
 *
 * Parks (F16.9). The usage-limit and sign-in walls are the account's, not the review's, so a
 * review that meets one is parked IN that gate — the gate is the only memory (memory
 * *limit-gate-is-the-only-memory*); the row's `parked-*` status and `parkReason` only mirror
 * it. A review started, or pumped, while a gate is up parks at once. When the gate lifts, the
 * scheduler hands the ids back to {@link AiReviewRunner.resume}, which restarts each one from
 * scratch — re-resolved, re-pinned, a new worktree and session — keeping only its cost so far.
 *
 * The settle path, for each `result`, ignoring anything once the review has settled (memory
 * *a-park-settled-over-by-its-own-result*):
 *  1. the cost so far onto the row (live cost);
 *  2. `Scheduler.classifyReviewWall` — `settled` is checked AGAIN after it, because it probes
 *     `/usage`. A sign-in or usage-limit wall parks the review ({@link AiReviewRunner.park});
 *     a limit sentence `/usage` contradicts ends it `failed` with the reason;
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
  type AiReviewDoc,
  type AiReviewRequester,
  type AiReviewStatus,
  type AiReviewTokens,
  type FindingsValidation,
} from '@shared/aiReview';
import type { Project } from '@shared/model';
import type {
  ClaudeModel,
  SessionEvent,
  SettingSource,
  StartSessionRequest,
} from '@shared/session';
import { missingReviewSandboxFlags, type ClaudeCliCapabilities } from '../claudeCapabilities';
import { logMain } from '../log';
import {
  REVIEW_GIT_SUBCOMMANDS,
  REVIEW_READ_TOOLS,
  type ReviewToolDenial,
} from '../permissionPolicy';
import type { ReviewPark, Scheduler } from '../scheduler';
import type { Store } from '../store';
import {
  isRefusal,
  type AiReviewRefusal,
  type AiReviewRefusalCode,
  type AiReviewSubjectSource,
  type ReviewTarget,
} from './aiReviewSubjects';
import { buildReviewPrompt, usedReviewDoc } from './reviewPrompt';
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

/**
 * The model a review runs on: the project's own `reviewModel`, else its planning model
 * (reviewing is the same kind of reading-and-judging turn), else its execution model.
 */
export function reviewModelFor(
  project: Pick<Project, 'reviewModel' | 'planningModel' | 'defaultModel'>,
): ClaudeModel {
  return project.reviewModel ?? project.planningModel ?? project.defaultModel;
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
    | 'listAiReviewsByStatus'
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
    | 'classifyReviewWall'
    | 'parkReview'
    | 'unparkReview'
    | 'setReviewParkHandler'
    | 'currentLimit'
    | 'currentAuth'
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
  /** A `result` is being classified: an exit now waits for that decision. */
  walling: boolean;
  /** The session exited while {@link walling} — applied once the decision is made. */
  exitedWhileWalling: boolean;
  /**
   * What earlier sessions of this review spent before it was parked and restarted. The CLI
   * reports running totals per SESSION, so a restart's totals are added to this.
   */
  costBase: { costUsd: number | null; tokens: AiReviewTokens | null };
}

type ResultEvent = Extract<SessionEvent, { kind: 'result' }>;
type Finish = Partial<Omit<AiReview, 'id' | 'subjectId'>> & { resultText?: string | null };

const PARKED: readonly AiReviewStatus[] = ['parked-limit', 'parked-signin'];
const isParked = (status: AiReviewStatus): boolean => PARKED.includes(status);

export class AiReviewRunner {
  private readonly queue: Live[] = [];
  private running: Live | null = null;
  /** Parked ids {@link resume} is restarting right now — a second hand-over skips them. */
  private readonly resuming = new Set<string>();
  private disposed = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: AiReviewRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    deps.scheduler.setReviewParkHandler({ resume: (ids) => void this.resume(ids) });
  }

  /**
   * Ask for a review of `subjectId`. A refusal creates no row; otherwise the review is
   * queued — and started at once when nothing else is running. Behind a standing limit or
   * sign-in gate it is not refused but parked in that gate (sign-in first), to restart when
   * the gate lifts.
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
    if (
      earlier.some((r) => r.status === 'queued' || r.status === 'running' || isParked(r.status))
    ) {
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

    const live = this.liveFor(this.newId(), subjectId, target, { costUsd: null, tokens: null });
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
      reviewDoc: reviewDocOf(target),
    });
    const gate = this.gateUp();
    if (gate) return this.parkRow(live.id, gate) ?? review;
    this.queue.push(live);
    this.deps.emitChanged(review);
    this.pump();
    return review;
  }

  /** Cancel a queued, running or parked review. False when it is unknown or already finished. */
  async cancel(id: string): Promise<boolean> {
    const queued = this.queue.findIndex((l) => l.id === id);
    if (queued !== -1) {
      const [live] = this.queue.splice(queued, 1);
      live.settled = true;
      this.write(live, { status: 'cancelled', finishedAt: this.now() });
      return true;
    }
    const live = this.running;
    if (live && live.id === id) {
      if (live.settled) return false;
      await this.finish(live, { status: 'cancelled' });
      return true;
    }
    const row = this.deps.store.getAiReview(id);
    if (!row || !isParked(row.status)) return false;
    // The gate is the memory: out of it first, or its lift would restart a cancelled review.
    this.deps.scheduler.unparkReview(id);
    this.writeRow(id, { status: 'cancelled', parkReason: null, finishedAt: this.now() });
    return true;
  }

  /**
   * A gate lifted with these reviews parked in it (the scheduler's review park handler).
   * Each one still `parked-*` is re-parked behind whichever gate is still up — a gate that is
   * lifting reads as down — or else restarted from scratch: the subject re-resolved and
   * re-pinned at its current head, queued with what it has spent so far. Then pump.
   */
  async resume(ids: readonly string[]): Promise<void> {
    const mine = ids.filter((id) => !this.resuming.has(id) && !this.holds(id));
    for (const id of mine) this.resuming.add(id);
    try {
      for (const id of mine) await this.restart(id);
    } finally {
      for (const id of mine) this.resuming.delete(id);
    }
    this.pump();
  }

  /**
   * Boot: restart every `parked-*` row that neither restored gate holds — its gate was saved
   * empty, already lifted, or never written. A row a gate still holds waits for that gate.
   */
  async restoreParked(): Promise<void> {
    const held = new Set([
      ...(this.deps.scheduler.currentLimit()?.parkedReviewIds ?? []),
      ...(this.deps.scheduler.currentAuth()?.parkedReviewIds ?? []),
    ]);
    const orphans = this.deps.store
      .listAiReviewsByStatus(PARKED)
      .map((r) => r.id)
      .filter((id) => !held.has(id));
    if (orphans.length > 0) await this.resume(orphans);
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

  /**
   * Start the oldest queued review, if nothing is running. While a gate is up nothing
   * launches: every queued review is parked into that gate instead.
   */
  private pump(): void {
    if (this.disposed || this.running) return;
    const gate = this.gateUp();
    if (gate) {
      for (const live of this.queue.splice(0)) {
        live.settled = true;
        this.parkRow(live.id, gate);
      }
      return;
    }
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
        // A blocking `rate-limit` event: the scheduler has already raised the gate with the
        // review in it, so `park` re-parking is a no-op there and the rest is the settle.
        onParked: (reason) => void this.park(live, { gate: 'limit', reason }),
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
    await this.settleResult(live, event);
    // An exit that arrived while the wall was being decided — unless that decision parked
    // (or otherwise settled) the review, it is a session that ended without an answer.
    if (live.exitedWhileWalling) {
      live.exitedWhileWalling = false;
      await this.onExit(live);
    }
  }

  private async settleResult(live: Live, event: ResultEvent): Promise<void> {
    if (live.settled) return;
    // The CLI reports the session's running totals on each `result`, so the latest is this
    // session's cost so far — not something to add to. Only a restart's earlier sessions
    // (`costBase`) are added.
    const row = this.deps.store.getAiReview(live.id);
    const base = live.costBase;
    this.write(live, {
      costUsd: event.costUsd != null ? (base.costUsd ?? 0) + event.costUsd : (row?.costUsd ?? null),
      tokens: event.usage ? addTokens(base.tokens, event.usage) : (row?.tokens ?? null),
    });

    live.walling = true;
    let wall: Awaited<ReturnType<Scheduler['classifyReviewWall']>>;
    try {
      wall = await this.deps.scheduler.classifyReviewWall(live.id, event);
    } finally {
      live.walling = false;
    }
    // The probe yielded: a cancel, a rate-limit park or a dispose may have settled it since.
    if (live.settled) return;
    if (wall?.gate === 'signin' || wall?.gate === 'limit') return this.park(live, wall);
    if (wall) return this.finish(live, { status: 'failed', error: wall.reason });

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
   * A sign-in or usage-limit wall: park the review in that gate and settle it — the row
   * mirrors the gate (no `finishedAt`: it is not finished), the session is stopped, the
   * worktree removed and the next review pumped, which parks too while the gate stands.
   */
  private async park(live: Live, wall: ReviewPark): Promise<void> {
    if (live.settled) return;
    live.settled = true;
    if (live.denials.length > 0) {
      const denied = live.denials.map((d) => `${d.detail} (${d.reason})`);
      logMain(`AI review ${live.id}: denied tool uses: ${denied.join('; ')}`);
    }
    this.parkRow(live.id, wall);
    await this.release(live);
  }

  private async onExit(live: Live): Promise<void> {
    if (live.settled) return;
    if (live.walling) {
      live.exitedWhileWalling = true;
      return;
    }
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
    await this.release(live);
  }

  /** After a settle: stop the session, remove the worktree, then the next review. */
  private async release(live: Live): Promise<void> {
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

  /** Restart one parked review from scratch — see {@link resume}. */
  private async restart(id: string): Promise<void> {
    if (this.disposed) return;
    const row = this.deps.store.getAiReview(id);
    if (!row || !isParked(row.status)) return;
    const early = this.gateUp();
    if (early) {
      this.parkRow(id, early);
      return;
    }
    const target = await this.deps.subjects.resolve(row.subjectId);
    // The resolve yielded: a cancel, a dispose or a fresh wall may have come since.
    const now = this.deps.store.getAiReview(id);
    if (this.disposed || !now || !isParked(now.status)) return;
    if (isRefusal(target)) {
      this.writeRow(id, {
        status: 'failed',
        parkReason: null,
        error: target.reason,
        finishedAt: this.now(),
      });
      return;
    }
    const gate = this.gateUp();
    if (gate) {
      this.parkRow(id, gate);
      return;
    }
    // Out of any gate that still lists it (a boot orphan's stale entry): it runs now.
    this.deps.scheduler.unparkReview(id);
    const live = this.liveFor(id, row.subjectId, target, {
      costUsd: now.costUsd,
      tokens: now.tokens,
    });
    this.writeRow(id, {
      status: 'queued',
      parkReason: null,
      diffId: target.summary.diffId,
      headSha: target.summary.headSha,
      model: live.model,
      reviewDoc: reviewDocOf(target),
    });
    this.queue.push(live);
  }

  /** A fresh in-memory review: never launched, nothing settled. */
  private liveFor(
    id: string,
    subjectId: string,
    target: ReviewTarget,
    costBase: Live['costBase'],
  ): Live {
    return {
      id,
      subjectId,
      target,
      model: reviewModelFor(target.project),
      runId: null,
      settled: false,
      repaired: false,
      worktree: false,
      denials: [],
      walling: false,
      exitedWhileWalling: false,
      costBase,
    };
  }

  /** The gate a review would park behind right now — sign-in first — or null when both are down. */
  private gateUp(): ReviewPark | null {
    const blockers = this.deps.scheduler.reviewBlockers();
    if (blockers.signin) return { gate: 'signin', reason: blockers.signin };
    if (blockers.limit) return { gate: 'limit', reason: blockers.limit };
    return null;
  }

  /** Park `id` in the gate and mirror it on the row: the status and the gate's reason. */
  private parkRow(id: string, wall: ReviewPark): AiReview | undefined {
    const parkReason = this.deps.scheduler.parkReview(id, wall);
    const status: AiReviewStatus = wall.gate === 'signin' ? 'parked-signin' : 'parked-limit';
    return this.writeRow(id, { status, parkReason });
  }

  /** Whether this runner holds `id` in memory — queued, or the one running. */
  private holds(id: string): boolean {
    return this.running?.id === id || this.queue.some((l) => l.id === id);
  }

  /** Patch the row and say so. A row that has vanished is not worth failing over. */
  private write(live: Live, patch: Finish): void {
    this.writeRow(live.id, patch);
  }

  private writeRow(id: string, patch: Finish): AiReview | undefined {
    const review = this.deps.store.updateAiReview(id, patch);
    if (review) this.deps.emitChanged(review);
    return review;
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

/** The checklist the target's prompt carries — the same test the prompt itself makes. */
function reviewDocOf(target: ReviewTarget): AiReviewDoc {
  return usedReviewDoc(target.prompt) ? 'REVIEW.md' : 'default';
}

/** A restart's earlier sessions plus this one's running totals. */
function addTokens(base: AiReviewTokens | null, more: AiReviewTokens): AiReviewTokens {
  if (!base) return more;
  return {
    inputTokens: base.inputTokens + more.inputTokens,
    outputTokens: base.outputTokens + more.outputTokens,
    cacheCreationTokens: base.cacheCreationTokens + more.cacheCreationTokens,
    cacheReadTokens: base.cacheReadTokens + more.cacheReadTokens,
  };
}
