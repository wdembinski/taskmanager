/**
 * Pure mapping between a task's status, its board column, and (for JIRA tasks) the
 * tracker's status category. Lives in `shared` so the main process (JIRA sync &
 * move resolution) and the renderer (the board UI) agree on the vocabulary without
 * either importing the other. No React, no Electron, no DB — trivially testable.
 */
import { isPersonalBoard } from './model';
import type { BoardColumn, JiraStatusCategory, ManualStatus, Task, TaskStatus } from './model';
import { mrNeedsAttention, type MergeRequest } from './mergeRequest';

/**
 * The statuses that mean **a run owns this task right now**. They are the scheduler's,
 * not the human's: nothing a person can pick from a menu produces one (see
 * `MANUAL_STATUSES`), and each of them ends by itself when the session does.
 */
const RUN_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting-input',
  'blocked-by-limit',
]);

/**
 * Runaway guard on the steps ONE CARD may carry, across every planning round.
 *
 * This is **not** a product rule about how much work a card is allowed to be. An approved
 * plan is a human decision: if it argued for forty steps and someone approved it, forty
 * steps are what the card gets. The bound exists for the other case — a parse gone wrong,
 * where a document full of `##` headings splits into hundreds of rows nobody asked for.
 * Set high enough that no real plan reaches it, low enough that a misparse cannot fill the
 * Steps list with noise.
 *
 * Lives in `shared` because both sides enforce it and must agree: the engine caps what an
 * approved plan appends (`stepsToAppend`), and the panel greys out "Plan more steps…" when
 * there is no room left, so the human is told before the round trip rather than after.
 *
 * A bound on the CARD, not on any one plan — counting per round would let a card re-planned
 * five times sail past the bound the guard exists to enforce.
 */
export const MAX_PLAN_STEPS = 200;

/** Whether `status` is one a live run put there. See {@link RUN_STATUSES}. */
export function isRunStatus(status: TaskStatus): boolean {
  return RUN_STATUSES.has(status);
}

/**
 * Whether this task's state belongs to the human alone — a top-level card of the
 * Personal board, the thing you drag between columns.
 *
 * Its two exclusions are the whole point. A **plan project's** tasks are a queue the
 * orchestrator drains, where `pending → running → done` IS the feature. A **step** of an
 * approved plan is not a card at all — it renders inside its parent, and the chain reads
 * its `done`/`failed` to know whether to advance. Both must keep the lifecycle they have;
 * only a card the human files by hand is protected from the agent.
 */
export function isBoardCard(task: Task): boolean {
  return isPersonalBoard(task.projectId) && !task.parentTaskId;
}

/**
 * Where a card **rests** — the status the human put it in, whatever a run is doing to it
 * this second. Equal to `task.status` except while a run has borrowed that field, and
 * then it is what the run borrowed it from (see {@link Task.preRunStatus}).
 *
 * This, not `status`, is what the board and every "what state is this card in" control
 * must read: a card left in TO DO stays in TO DO while its agent works, and the spinner,
 * the glyph and the run strip are what say the agent is working.
 */
export function restingStatus(task: Task): TaskStatus {
  if (isRunStatus(task.status) && task.preRunStatus) return task.preRunStatus;
  return task.status;
}

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
 *
 * Reads {@link restingStatus} rather than `status`, so a running card sits where its
 * human left it instead of being dragged into IN PROGRESS by its own agent.
 */
export function columnForTask(task: Task): BoardColumn {
  return columnForStatus(restingStatus(task));
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
 * The statuses that mean **the human has closed this card**. A deliberately smaller set
 * than {@link TERMINAL} below, which also counts `failed`: a failed card is over, but
 * nobody decided it was — and a card that fell over is exactly the kind that should still
 * be shouting.
 */
const CLOSED_BY_HUMAN: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'stopped']);

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
 *
 * A card the human has CLOSED is silent, whichever of the five drivers below is still
 * true — see the override at the top of the body.
 */
export function chainNeedsAttention(
  task: Task,
  subtasks: Task[],
  mergeRequests: readonly MergeRequest[] = [],
  attentionTaskIds?: ReadonlySet<string>,
): boolean {
  // **A closed card does not shout.** Deliberately an override of signals that are still
  // perfectly true: an unread ticket comment, a step that failed on the way, an inbox item
  // nobody ever answered, an MR left open on the branch — every one of them can outlive
  // the decision to be done with the card, and none of them is a reason to keep ringing
  // about work nobody is going to do. Marking a card done IS the human answering.
  //
  // Here rather than at the two call sites, so the ring (`TaskCard`) and the ordering
  // (`sortCards`) cannot disagree — a done card sorted to the top of its column without a
  // ring, or ringed there, means they already had.
  //
  // `restingStatus` and not `status`, for the usual reason: a run borrows that field, and
  // where the HUMAN left the card is the whole subject of this override.
  if (CLOSED_BY_HUMAN.has(restingStatus(task))) return false;

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
export type RunPhase =
  'idle' | 'queued' | 'starting' | 'running' | 'waiting' | 'blocked' | 'merging' | 'done';

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
 *   1. `task:assignAgent` patches the card and only *then* calls `runTask`, so the task it
 *      hands back still says whatever the card was resting in while a run is already
 *      spawning. That window is exactly the "it's working but there's no spinner" complaint.
 *   2. Once an agent can be assigned WITHOUT being started, `assigned + pending` is a
 *      legitimate resting state — so "starting" stops being derivable from `Task` at all.
 *
 * `liveRunTaskIds` (from `scheduler:activeRuns`) closes both. It is optional so a caller
 * with no snapshot still gets a sane answer, one phase less precise.
 *
 * Also deliberately not gated on {@link isAgentAssigned}: a step added by hand carries no
 * `agentProjectId`, and gating would mean it could never show a spinner however hard it ran.
 *
 * `mergingTaskIds` (from `scheduler:integrating`) closes the third window, the one Merge
 * left open: pressing it starts a rebase-and-fast-forward that can run for a minute, and
 * NOTHING about the card changes while it does — no run, no status, no transcript line —
 * so the board said the card was resting and the button simply looked dead. Unlike the
 * live-run snapshot this set never lags: the engine adds a task before the git work starts
 * and removes it in a `finally`, so it is a fact rather than a hint.
 */
export function runPhase(
  task: Task,
  subtasks: Task[] = [],
  liveRunTaskIds?: ReadonlySet<string>,
  mergingTaskIds?: ReadonlySet<string>,
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

  // Merging outranks everything below, including a terminal status: a chain's branch is
  // integrated under the id of the STEP that finished it, and that step is `done` by
  // then — so refusing to read a settled task out of this set would hide the merge on
  // exactly the cards that most often have one. The card claims its steps' merges too,
  // since the branch being merged is the card's work reaching base.
  if (mergingTaskIds?.size) {
    const merging =
      mergingTaskIds.has(task.id) || subtasks.some((step) => mergingTaskIds.has(step.id));
    if (merging) return { phase: 'merging', label: 'Merging branch…', spinner: true };
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
    // A step held behind the usage-limit gate: say so on the card, rather than leaving it
    // to the "Queued" fall-through below. A chain that stops between steps for five hours
    // and a chain that is merely waiting its turn look identical otherwise, and the first
    // one is the one people ask about.
    const limited = subtasks.findIndex((s) => s.status === 'blocked-by-limit');
    if (limited >= 0) {
      return {
        phase: 'blocked',
        label: `Paused — usage limit (step ${limited + 1} of ${total})`,
        spinner: false,
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
  //
  // `sessionId` is what makes "never ran" mean it: a card whose run is over goes back to
  // the status its human left it in (see `restingStatus`), which is very often `pending`
  // — and a finished card claiming it had never started was the first thing that broke.
  //
  // Still keyed on `pending`, and deliberately, now that assignment no longer drags a card
  // into TO DO (`assignmentStatusPatch`): a card assigned while it rests in IN REVIEW or
  // BLOCKED simply says nothing here. "Not started" is a statement about a queue, and the
  // only column that means queued is TO DO — on any other, where the card sits already says
  // what it is, and the words would be contradicting it rather than adding to it. The Start
  // button is offered from the card either way; this is only what the card SAYS.
  if (isAgentAssigned(task) && task.status === 'pending' && !task.sessionId) {
    return { phase: 'idle', label: 'Assigned — not started', spinner: false };
  }

  return TERMINAL.has(task.status) ? FINISHED : IDLE;
}

/**
 * Whether **Stop** would actually stop something on this task — what decides that the
 * button is offered at all. The renderer's copy of `Scheduler.stopTask`'s own test, in
 * the same spirit as `chatAvailability`: it decides whether to OFFER the control, never
 * what pressing it does.
 *
 * Deliberately not `isRunStatus(task.status)`, which is the question the detail pane used
 * to ask. That one is answered `false` in exactly the cases where the human most wants the
 * button, and every one of them is work the engine has always been willing to stop:
 *
 *  - **a card executing an approved plan.** It sits `in-progress` while a STEP holds the
 *    run, so the card offering the button had no button, and the only way to stop the
 *    work was to know that steps have panes of their own. `stopTask` stops the card AND
 *    its steps in one call — the button was the only thing missing.
 *  - **a run that has spawned but is not yet persisted as `running`** — the window
 *    `runPhase` calls `starting`, and the reason this takes the live-run snapshot too.
 *  - **a chain between steps.** Nothing is running this instant and the next step starts
 *    by itself, so "there is no button because nothing is running" is at best a race.
 *
 * `subtasks` must be the task's OWN steps. A step's SIBLINGS would offer a Stop that
 * stops the wrong work, since the button stops the id it was drawn for.
 */
export function canStopWork(
  task: Task,
  subtasks: Task[] = [],
  liveRunTaskIds?: ReadonlySet<string>,
): boolean {
  // Same discipline as {@link runPhase}: a terminal status is a FACT and the snapshot only
  // a lagging hint, so a finished task is never read out of it — that lag is what used to
  // leave cards spinning "Starting…" after their agent had stopped.
  const spawning = (t: Task): boolean =>
    !TERMINAL.has(t.status) && Boolean(liveRunTaskIds?.has(t.id));
  if (isRunStatus(task.status) || spawning(task)) return true;
  if (subtasks.some((s) => isRunStatus(s.status) || spawning(s))) return true;
  // A chain caught between steps: something is still to run, and the chain has already
  // started — so it WILL run, and stopping it is a real choice. The second half is what
  // keeps this honest: steps written by hand on a card nobody has started are queued for
  // nothing, and a Stop there would cancel work that never began.
  return (
    subtasks.some((s) => s.status === 'pending') && subtasks.some((s) => TERMINAL.has(s.status))
  );
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
 *
 * `merging` is deliberately NOT one of the moving states here, even though it spins. The
 * pulse means "the agent is working", and during a merge the agent is finished — what is
 * moving is git. A bare pulse there would be indistinguishable from a run, so this one
 * phase keeps its words.
 */
export function cardRunLabel(run: RunState, agentAssigned: boolean): string | null {
  if (!run.label) return null;
  const moving = run.phase === 'running' || run.phase === 'starting';
  return moving && agentAssigned ? null : run.label;
}
