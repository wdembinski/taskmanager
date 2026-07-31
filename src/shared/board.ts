/**
 * Pure mapping between a task's status, its board column, and (for JIRA tasks) the
 * tracker's status category. Lives in `shared` so the main process (JIRA sync &
 * move resolution) and the renderer (the board UI) agree on the vocabulary without
 * either importing the other. No React, no Electron, no DB — trivially testable.
 */
import type { BoardColumn, JiraStatusCategory, ManualStatus, Task, TaskStatus } from './model';
import { mrNeedsAttention, type MergeRequest } from './mergeRequest';

/** Which board column a bare status maps to. Total over every `TaskStatus`. */
export function columnForStatus(status: TaskStatus): BoardColumn {
  switch (status) {
    case 'pending':
      return 'todo';
    case 'in-progress':
    case 'running':
    case 'waiting-input':
    case 'blocked-by-limit':
      return 'in-progress';
    case 'in-review':
      return 'in-review';
    case 'blocked':
      return 'blocked';
    case 'done':
    case 'failed':
    case 'stopped':
    case 'cancelled':
      return 'done';
  }
}

/** The manual status a card takes when dropped into a column. */
export function statusForColumn(column: BoardColumn): ManualStatus {
  switch (column) {
    case 'todo':
      return 'pending';
    case 'in-progress':
      return 'in-progress';
    case 'in-review':
      return 'in-review';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'done';
  }
}

/** Map a JIRA status category onto a board column. */
export function categoryToColumn(category: JiraStatusCategory): BoardColumn {
  switch (category) {
    case 'To Do':
      return 'todo';
    case 'In Progress':
      return 'in-progress';
    case 'Done':
      return 'done';
  }
}

/**
 * The JIRA status category behind a `statusCategory.key`. Keys are stable and not
 * localized (unlike the display name): `indeterminate` = In Progress, `done` = Done,
 * everything else (`new`, `undefined`) = To Do.
 */
export function categoryFromKey(key: string): JiraStatusCategory {
  if (key === 'indeterminate') return 'In Progress';
  if (key === 'done') return 'Done';
  return 'To Do';
}

/**
 * The column a status name is mapped to by the given map, or null when it is not in
 * it. The building block of `resolveStatusColumn` (`shared/statusResolve.ts`), which
 * is what both the sync and the move path actually call — this only answers "did
 * somebody say what this name means", not "where does it go".
 *
 * Matched **case-insensitively** and on the trimmed name: the map is keyed by a
 * status NAME, and names are typed by hand in Settings.
 */
export function lookupStatusColumn(
  rawStatus: string,
  map: Record<string, BoardColumn> | undefined,
): BoardColumn | null {
  if (!map) return null;
  const wanted = rawStatus.trim().toLowerCase();
  if (!wanted) return null;
  for (const [name, column] of Object.entries(map)) {
    if (name.trim().toLowerCase() === wanted) return column;
  }
  return null;
}

/**
 * Which column a task lives in. JIRA sync keeps a task's local `status` in step with
 * its tracker category (except when the task is internally `blocked`, which is
 * preserved), so a single status-based mapping is correct for both internal and
 * JIRA tasks.
 */
export function columnForTask(task: Task): BoardColumn {
  return columnForStatus(task.status);
}

/**
 * Whether a JIRA task has comments the user hasn't read yet — drives the card's
 * orange border. True when the newest comment seen at sync is newer than the last
 * one the user read (or none has been read). Internal tasks are never "unread".
 */
export function hasUnreadJira(task: Task): boolean {
  if (task.externalSource !== 'jira' || task.latestCommentAt == null) return false;
  return task.lastReadCommentAt == null || task.latestCommentAt > task.lastReadCommentAt;
}

/**
 * Whether the agent working this card is parked on a question or a permission
 * request — the card gets the same orange frame as an unread JIRA comment, since
 * both mean "this one wants you". A personal card only ever reaches
 * `waiting-input` through a delegated run, so the status alone is the signal.
 */
export function needsAgentInput(task: Task): boolean {
  return task.status === 'waiting-input';
}

/**
 * Whether a card has been DELEGATED to an agent project (drives the card's agent glyph).
 *
 * Deliberately `agentProjectId` and not `projectTagId`: filing a card under a project
 * says what it is about, not that anyone is working it. Conflating the two is what gave
 * every merely-filed card an agent glyph.
 */
export function isAgentAssigned(task: Task): boolean {
  return Boolean(task.agentProjectId);
}

/**
 * The step that has stopped a card's chain, or null while it is healthy (Phase 12).
 *
 * Steps run strictly one at a time, so a step that is parked on a question or has
 * `failed` is the whole chain: its siblings stay `pending` until a human resolves it.
 * Both cases are "this card wants you" — a failed step is not a finished one, and until
 * Phase 12 nothing on the board said so.
 */
export function parkedStep(subtasks: Task[]): Task | null {
  return subtasks.find((s) => s.status === 'waiting-input' || s.status === 'failed') ?? null;
}

/**
 * Whether a card should wear the orange "wants you" frame: an unread ticket comment,
 * its own agent asking, a parked step, **or a merge request that wants you** — a red
 * pipeline, a review comment, changes requested. One helper so the board card, the
 * detail pane and any future surface can never disagree about which cards are shouting.
 *
 * `mergeRequests` is DEFAULTED, so every existing call site compiles unchanged. But
 * `sortCards` must pass it: the ordering and the ring are the same predicate on purpose,
 * and a board where the loudest card is not the top one is a board that is lying.
 *
 * `attentionTaskIds` is the set of tasks the inbox is actually holding an item for, and
 * it is the only *authoritative* signal here — the other three are inferences. Until
 * Phase 17 the board had no access to it at all, so an item raised without the engine
 * also flipping the task to `waiting-input` drew no ring, which is why cards sometimes
 * sat there silently wanting you. Defaulted for the main-process callers, which have no
 * inbox to consult and rely on the status.
 */
export function chainNeedsAttention(
  task: Task,
  subtasks: Task[],
  mergeRequests: readonly MergeRequest[] = [],
  attentionTaskIds?: ReadonlySet<string>,
): boolean {
  if (attentionTaskIds?.has(task.id)) return true;
  if (attentionTaskIds && subtasks.some((s) => attentionTaskIds.has(s.id))) return true;
  return (
    hasUnreadJira(task) ||
    needsAgentInput(task) ||
    parkedStep(subtasks) !== null ||
    mergeRequests.some(mrNeedsAttention)
  );
}

/**
 * Which task a message typed on `task`'s card should be delivered to (Phase 12).
 *
 * A card executing an approved plan holds no session of its own — it sits `in-progress`
 * while step N does the work — so "the agent on this card" IS the live step, and talking
 * to the parent would be talking to nothing. Steps are sequential, so at most one can be
 * live; ties are impossible by construction, and the first live step wins if one ever
 * happened.
 *
 * A step selected directly is its own target, and a card with no live step is its own
 * target too (there may still be a session to resume — that is the caller's problem).
 */
export function chatTarget(task: Task, subtasks: Task[]): Task {
  if (task.parentTaskId) return task;
  return subtasks.find((s) => s.status === 'running' || s.status === 'waiting-input') ?? task;
}

/**
 * Whether a card's approved plan is still in flight (Phase 12) — some step can still
 * start, is working, or is parked waiting for a resolution that will start the next one.
 *
 * This is what stops a chat message from **resuming the parent** mid-chain: a card that
 * has handed over to a plan holds only its planner's session, and a run started from it
 * would both re-open a conversation that is over and race the chain for the card's shared
 * worktree. `done`/`cancelled`/`stopped` steps are inert — nothing will move them — so a
 * finished or abandoned chain leaves the card free to talk again.
 */
export function chainInFlight(subtasks: Task[]): boolean {
  return subtasks.some(
    (s) =>
      s.status === 'pending' ||
      s.status === 'running' ||
      s.status === 'waiting-input' ||
      s.status === 'blocked-by-limit' ||
      s.status === 'failed',
  );
}

/**
 * Whether an agent is working this task **right now** — the card (or step row) shows a
 * spinner. Deliberately narrower than "in progress": `in-progress` is a status a human
 * sets by dragging a card, while `running` only ever comes from a live session. A card
 * parked on a question or behind the usage-limit gate is *not* running: nothing is
 * moving, and a spinner would claim otherwise.
 */
export function isAgentRunning(task: Task): boolean {
  return isAgentAssigned(task) && task.status === 'running';
}

/**
 * What a card is doing, as one value. `idle`/`done` are resting states; everything else
 * means something is happening and the card should say so.
 */
export type RunPhase = 'idle' | 'queued' | 'starting' | 'running' | 'waiting' | 'blocked' | 'done';

/** A phase plus the words and the spinner that go with it. */
export interface RunState {
  phase: RunPhase;
  /** Human-facing, e.g. `Running step 2 of 5`. Empty for `idle`/`done`. */
  label: string;
  /** Whether a spinner should turn. Only true when something is actually moving. */
  spinner: boolean;
}

const IDLE: RunState = { phase: 'idle', label: '', spinner: false };
const FINISHED: RunState = { phase: 'done', label: '', spinner: false };

/**
 * Statuses that mean this task's own work is over. A terminal status is a *fact* recorded
 * against the task; `liveRunTaskIds` is only a snapshot, and one that lags on purpose (see
 * {@link runPhase}) — so the two must never be weighed the other way round.
 */
const TERMINAL: ReadonlySet<Task['status']> = new Set(['done', 'failed', 'stopped', 'cancelled']);

/**
 * The one answer to "what is this card doing right now", shared by the card, the detail
 * pane and the status strip above the composer, so the three can never disagree.
 *
 * Deliberately NOT derived from status alone, for two reasons:
 *
 *   1. `task:assignAgent` writes `status: 'pending'` and only *then* calls `runTask`, so
 *      the task that patches the card says `pending` while a run is already spawning.
 *      That window is exactly the "it's working but there's no spinner" complaint.
 *   2. Once an agent can be assigned WITHOUT being started, `assigned + pending` is a
 *      legitimate resting state — so "starting" stops being derivable from `Task` at all.
 *
 * `liveRunTaskIds` (from `scheduler:activeRuns`) closes both. It is optional so a caller
 * with no snapshot still gets a sane answer, one phase less precise.
 *
 * Also deliberately not gated on {@link isAgentAssigned}: a step added by hand carries no
 * `agentProjectId`, and gating would mean it could never show a spinner however hard it ran.
 */
export function runPhase(
  task: Task,
  subtasks: Task[] = [],
  liveRunTaskIds?: ReadonlySet<string>,
): RunState {
  // The task's own state always wins over the chain's — a parent that is itself running
  // (a review-seed turn, say) is running, whatever its finished steps say.
  switch (task.status) {
    case 'running':
      return { phase: 'running', label: 'Running…', spinner: true };
    case 'waiting-input':
      return { phase: 'waiting', label: 'Waiting for you', spinner: false };
    case 'blocked-by-limit':
      return { phase: 'blocked', label: 'Paused — usage limit', spinner: false };
    default:
      break;
  }

  // Only a task that could still be starting. A finished/stopped one must NOT be read out
  // of the live-run snapshot, because that snapshot legitimately lags behind the task: the
  // engine emits the settling `task:changed` and only removes the run when the process
  // later reports `exited`, so every refresh triggered by that event is taken while the
  // finished run is still listed. Trusting it here is what left a card spinning
  // "Starting…" after its agent had finished or been stopped.
  if (!TERMINAL.has(task.status) && liveRunTaskIds?.has(task.id)) {
    return { phase: 'starting', label: 'Starting…', spinner: true };
  }

  if (subtasks.length > 0) {
    const total = subtasks.length;
    const live = subtasks.findIndex((s) => s.status === 'running');
    if (live >= 0) {
      return { phase: 'running', label: `Running step ${live + 1} of ${total}`, spinner: true };
    }
    // Same discipline as the parent's own check above: the step's recorded status is a FACT,
    // the snapshot only a lagging hint, so a step that has finished is never read out of it.
    // Without the guard a `done` step still listed in `scheduler:activeRuns` — which it is
    // for the moment between settling and the process exiting — spins the whole card as
    // "Starting step N of M", and a step whose run leaked from the snapshot spins it forever.
    const starting = subtasks.findIndex(
      (s) => !TERMINAL.has(s.status) && liveRunTaskIds?.has(s.id),
    );
    if (starting >= 0) {
      return {
        phase: 'starting',
        label: `Starting step ${starting + 1} of ${total}`,
        spinner: true,
      };
    }
    const parked = subtasks.findIndex((s) => s.status === 'waiting-input' || s.status === 'failed');
    if (parked >= 0) {
      return {
        phase: 'waiting',
        label: `Stopped at step ${parked + 1} of ${total}`,
        spinner: false,
      };
    }
    if (chainInFlight(subtasks)) {
      return { phase: 'queued', label: 'Queued', spinner: false };
    }
  }

  // An agent is on the card but nothing is moving and nothing ever ran: it was assigned
  // and not started. Saying so is the whole point of offering a Start button.
  if (isAgentAssigned(task) && task.status === 'pending') {
    return { phase: 'idle', label: 'Assigned — not started', spinner: false };
  }

  return TERMINAL.has(task.status) ? FINISHED : IDLE;
}

/**
 * What a **card** should say about its run, in words — or nothing, when something else on the
 * card already says it.
 *
 * The card's agent glyph pulses while work is moving, so "Running…" / "Running step 2 of 5"
 * next to it is the third telling of one fact: the pulse says it is moving, the `2/5` counter
 * says how far, and the step rows underneath say which step. Only the states motion CANNOT
 * express are worth the room — "Waiting for you", "Paused — usage limit", "Queued",
 * "Assigned — not started".
 *
 * The `agentAssigned` argument is the exception that makes this a function rather than a
 * ternary at the call site. The glyph only exists on a card an agent owns, while `runPhase`
 * is deliberately not gated on that (a hand-written step chain runs without one — see
 * {@link runPhase}). With no glyph to pulse, dropping the words would leave the card saying
 * nothing at all, so they stay.
 */
export function cardRunLabel(run: RunState, agentAssigned: boolean): string | null {
  if (!run.label) return null;
  const moving = run.phase === 'running' || run.phase === 'starting';
  return moving && agentAssigned ? null : run.label;
}
