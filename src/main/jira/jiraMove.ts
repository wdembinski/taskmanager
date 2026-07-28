/**
 * Pure resolution of a drag-to-move on the board (Phase C): given a task and the
 * column it was dropped into, decide the new local status, whether to remember a
 * pre-block column, and whether the linked JIRA issue must be transitioned.
 *
 * The rules encode the product decisions:
 *   - Moving to/from BLOCKED is internal-only — JIRA is never touched, and the
 *     pre-block column is remembered so un-blocking restores it.
 *   - TO DO → IN PROGRESS transitions the JIRA issue to In Progress.
 *   - Moving into IN REVIEW transitions the JIRA issue to its review status.
 *   - Moving into DONE transitions the JIRA issue to Done.
 *   - Moving back to TO DO does not transition JIRA (we don't reopen tickets).
 *   - Internal (non-JIRA) tasks never transition anything.
 */
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import { columnForTask, lookupStatusColumn, statusForColumn } from '@shared/board';
import type { JiraTransition } from './jiraClient';
import type { JiraSettings } from '@shared/settings';

export type JiraTransitionTarget = 'toInProgress' | 'toInReview' | 'toDone';

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
    return {
      localStatus: 'blocked',
      preBlockStatus: task.status,
      jiraTransition: null,
      noop: false,
    };
  }

  // Out of Blocked, or a plain column move.
  const localStatus = statusForColumn(toColumn);
  let jiraTransition: JiraTransitionTarget | null = null;
  if (isJira) {
    if (toColumn === 'in-progress') jiraTransition = 'toInProgress';
    else if (toColumn === 'in-review') jiraTransition = 'toInReview';
    else if (toColumn === 'done') jiraTransition = 'toDone';
    // toColumn === 'todo' → no transition (we don't reopen tickets).
  }
  return { localStatus, preBlockStatus: null, jiraTransition, noop: false };
}

/** The settings `pickTransition` consults — the three name overrides plus the status map. */
export type TransitionSettings = Pick<
  JiraSettings,
  | 'inProgressTransitionName'
  | 'inReviewTransitionName'
  | 'doneTransitionName'
  | 'statusCategoryOverrides'
>;

const NAME_OVERRIDE: Record<JiraTransitionTarget, keyof TransitionSettings> = {
  toInProgress: 'inProgressTransitionName',
  toInReview: 'inReviewTransitionName',
  toDone: 'doneTransitionName',
};

/**
 * Choose which JIRA transition to apply for a target, in order of how much the user
 * told us:
 *
 *   1. an exact transition name they configured for this target;
 *   2. a transition whose destination status they mapped to this target's column;
 *   3. a category match (`indeterminate` = In Progress, `done` = Done) — for IN
 *      REVIEW, a category match plus "review" in the name, since JIRA files review
 *      statuses under `indeterminate` with everything else.
 *
 * IN PROGRESS deliberately *rejects* any transition whose destination the user
 * mapped to IN REVIEW: both live in the `indeterminate` category, so a bare category
 * match would happily drop a card into "Code Review" because it happened to come
 * first in the workflow's transition list. Returns null when nothing fits — the
 * caller turns that into a readable error rather than moving the card silently.
 */
export function pickTransition(
  transitions: JiraTransition[],
  target: JiraTransitionTarget,
  settings: TransitionSettings,
): JiraTransition | null {
  const override = settings[NAME_OVERRIDE[target]];
  if (typeof override === 'string' && override) {
    const byName = transitions.find((t) => t.name.toLowerCase() === override.toLowerCase());
    if (byName) return byName;
  }

  const map = settings.statusCategoryOverrides;
  const wantColumn: BoardColumn =
    target === 'toInProgress' ? 'in-progress' : target === 'toInReview' ? 'in-review' : 'done';
  const byMap = transitions.find((t) => lookupStatusColumn(t.to.name, map) === wantColumn);
  if (byMap) return byMap;

  const wantKey = target === 'toDone' ? 'done' : 'indeterminate';
  return (
    transitions.find((t) => {
      if (t.to.statusCategory.key !== wantKey) return false;
      const mapped = lookupStatusColumn(t.to.name, map);
      if (target === 'toInReview') return /review/i.test(t.to.name);
      // Never let IN PROGRESS grab a status the user said means IN REVIEW.
      return mapped !== 'in-review';
    }) ?? null
  );
}
