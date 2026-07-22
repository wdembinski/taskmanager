/**
 * Pure resolution of a drag-to-move on the board (Phase C): given a task and the
 * column it was dropped into, decide the new local status, whether to remember a
 * pre-block column, and whether the linked JIRA issue must be transitioned.
 *
 * The rules encode the product decisions:
 *   - Moving to/from BLOCKED is internal-only — JIRA is never touched, and the
 *     pre-block column is remembered so un-blocking restores it.
 *   - TO DO → IN PROGRESS transitions the JIRA issue to In Progress.
 *   - Moving into DONE transitions the JIRA issue to Done.
 *   - Moving back to TO DO does not transition JIRA (we don't reopen tickets).
 *   - Internal (non-JIRA) tasks never transition anything.
 */
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import { columnForTask, statusForColumn } from '@shared/board';
import type { JiraTransition } from './jiraClient';
import type { JiraSettings } from '@shared/settings';

export type JiraTransitionTarget = 'toInProgress' | 'toDone';

export interface MoveResolution {
  /** The task's new local status. */
  localStatus: TaskStatus;
  /** The column to restore on un-block (set only when moving into Blocked), else null. */
  preBlockStatus: TaskStatus | null;
  /** The JIRA transition to apply, or null when JIRA must not be touched. */
  jiraTransition: JiraTransitionTarget | null;
  /** True when nothing changes (dropped back into the same column). */
  noop: boolean;
}

/** Decide the effect of dropping `task` into `toColumn`. Pure. */
export function resolveMove(task: Task, toColumn: BoardColumn): MoveResolution {
  const from = columnForTask(task);
  const isJira = task.externalSource === 'jira';

  if (toColumn === from) {
    return {
      localStatus: task.status,
      preBlockStatus: task.preBlockStatus ?? null,
      jiraTransition: null,
      noop: true,
    };
  }

  // Into Blocked: internal-only. Remember where it came from; never touch JIRA.
  if (toColumn === 'blocked') {
    return { localStatus: 'blocked', preBlockStatus: task.status, jiraTransition: null, noop: false };
  }

  // Out of Blocked, or a plain column move.
  const localStatus = statusForColumn(toColumn);
  let jiraTransition: JiraTransitionTarget | null = null;
  if (isJira) {
    if (toColumn === 'in-progress') jiraTransition = 'toInProgress';
    else if (toColumn === 'done') jiraTransition = 'toDone';
    // toColumn === 'todo' → no transition (we don't reopen tickets).
  }
  return { localStatus, preBlockStatus: null, jiraTransition, noop: false };
}

/**
 * Choose which JIRA transition to apply for a target. Honors an exact-name override
 * from settings, else matches by the destination status category
 * (`indeterminate` = In Progress, `done` = Done). Returns null when none fits.
 */
export function pickTransition(
  transitions: JiraTransition[],
  target: JiraTransitionTarget,
  settings: Pick<JiraSettings, 'inProgressTransitionName' | 'doneTransitionName'>,
): JiraTransition | null {
  const override =
    target === 'toInProgress' ? settings.inProgressTransitionName : settings.doneTransitionName;
  if (override) {
    const byName = transitions.find((t) => t.name.toLowerCase() === override.toLowerCase());
    if (byName) return byName;
  }
  const wantKey = target === 'toInProgress' ? 'indeterminate' : 'done';
  return transitions.find((t) => t.to.statusCategory.key === wantKey) ?? null;
}
