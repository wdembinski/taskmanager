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
import { categoryFromKey, columnForTask, statusForColumn } from '@shared/board';
import { STATUS_REASONS, resolveStatusColumn } from '@shared/statusResolve';
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

/** The settings `pickTransition` consults — the three name overrides plus both status maps. */
export type TransitionSettings = Pick<
  JiraSettings,
  | 'inProgressTransitionName'
  | 'inReviewTransitionName'
  | 'doneTransitionName'
  | 'statusCategoryOverrides'
  | 'learnedStatusColumns'
>;

const NAME_OVERRIDE: Record<JiraTransitionTarget, keyof TransitionSettings> = {
  toInProgress: 'inProgressTransitionName',
  toInReview: 'inReviewTransitionName',
  toDone: 'doneTransitionName',
};

/** The board column each transition target is trying to reach. */
const TARGET_COLUMN: Record<JiraTransitionTarget, BoardColumn> = {
  toInProgress: 'in-progress',
  toInReview: 'in-review',
  toDone: 'done',
};

/**
 * Choose which JIRA transition to apply for a target, in order of how much we know:
 *
 *   1. an exact transition name the user configured for this target;
 *   2. otherwise the first transition whose DESTINATION STATUS resolves to this
 *      target's column — tried tier by tier, so an explicitly-mapped status is taken
 *      before a learned one, a learned one before the name heuristic, and the plain
 *      category last.
 *
 * The destination is resolved with the very same `resolveStatusColumn` the sync uses
 * (`shared/statusResolve.ts`), which is the point: a transition is only picked for IN
 * REVIEW if the sync would also read that status as IN REVIEW, so a drag can no longer
 * move a ticket somewhere the next sync disagrees with. It also subsumes the old
 * hand-written guard against IN PROGRESS grabbing a review status — "Code Review"
 * resolves to `in-review`, so it can never equal `in-progress`.
 *
 * Tier-by-tier rather than first-match-wins over the transition list, because a
 * workflow's transitions come back in the order the workflow declares them: a bare
 * scan would take a category-guess that happened to be listed first over the status
 * the user explicitly mapped.
 *
 * Returns null when nothing fits — the caller turns that into a readable error rather
 * than moving the card silently.
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

  const wantColumn = TARGET_COLUMN[target];
  for (const tier of STATUS_REASONS) {
    const hit = transitions.find((t) => {
      const resolved = resolveStatusColumn(
        t.to.name,
        categoryFromKey(t.to.statusCategory.key),
        settings.statusCategoryOverrides,
        settings.learnedStatusColumns,
      );
      return resolved.reason === tier && resolved.column === wantColumn;
    });
    if (hit) return hit;
  }
  return null;
}
