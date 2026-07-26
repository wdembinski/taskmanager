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
 * Whether an agent is working this task **right now** — the card (or step row) shows a
 * spinner. Deliberately narrower than "in progress": `in-progress` is a status a human
 * sets by dragging a card, while `running` only ever comes from a live session. A card
 * parked on a question or behind the usage-limit gate is *not* running: nothing is
 * moving, and a spinner would claim otherwise.
 */
export function isAgentRunning(task: Task): boolean {
  return isAgentAssigned(task) && task.status === 'running';
}
