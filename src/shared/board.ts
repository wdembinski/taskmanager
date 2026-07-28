/**
 * Pure mapping between a task's status, its board column, and (for JIRA tasks) the
 * tracker's status category. Lives in `shared` so the main process (JIRA sync &
 * move resolution) and the renderer (the board UI) agree on the vocabulary without
 * either importing the other. No React, no Electron, no DB — trivially testable.
 */
import type { BoardColumn, JiraStatusCategory, ManualStatus, Task, TaskStatus } from './model';

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
 * Which board column a JIRA status lands in: the user's per-status-name map first,
 * the issue's category as the fallback.
 *
 * The map exists because a category cannot express IN REVIEW — JIRA has only three
 * of them, and "Review", "In Review" and "Code Review" all sit in `In Progress`
 * alongside the status that actually means "being written". Names, unlike
 * categories, differ per project, so the map is keyed by name and matched
 * **case-insensitively**; anything unmapped still lands by category, which is
 * exactly how every board behaved before the map existed.
 *
 * Shared by the sync (which column an incoming issue lands in) and the move path
 * (which transition a drag should pick), so the two can never disagree about what
 * "Code Review" means.
 */
export function columnForJiraStatus(
  rawStatus: string,
  category: JiraStatusCategory,
  map: Record<string, BoardColumn> | undefined,
): BoardColumn {
  return lookupStatusColumn(rawStatus, map) ?? categoryToColumn(category);
}

/**
 * The column a status name is explicitly mapped to, or null when the user has not
 * mapped it. Separate from {@link columnForJiraStatus} because the move path needs
 * to tell "mapped to In Review" from "fell back to In Progress" — a transition must
 * only be *rejected* for a target when the user said it means something else.
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

/** Whether a card has been delegated to an agent project (drives the card's agent glyph). */
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
 * its own agent asking, **or a parked step**. One helper so the board card, the detail
 * pane and any future surface can never disagree about which cards are shouting.
 */
export function chainNeedsAttention(task: Task, subtasks: Task[]): boolean {
  return hasUnreadJira(task) || needsAgentInput(task) || parkedStep(subtasks) !== null;
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
