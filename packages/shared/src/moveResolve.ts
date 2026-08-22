/**
 * Pure resolution of a drag-to-move on the board (Phase C): given a task and the
 * column it was dropped into, decide the new local status, whether to remember a
 * pre-block column, and whether the linked JIRA issue must be transitioned.
 *
 * Lives in `shared` (Phase 25 — cloud web independence) rather than in
 * `apps/client/src/main/jira/jiraMove.ts`, where it was written: it does no JIRA I/O
 * of its own — `jiraTransition` is a plain string the CALLER posts, or doesn't — so
 * it is exactly as usable by `apps/server`'s own write endpoints (an ad-hoc task has
 * no linked issue and never gets one back) as it is by the desktop's drag handler.
 * `jiraMove.ts` re-exports this rather than every one of its own call sites being
 * repointed, so `@shared/moveResolve` and `./jira/jiraMove` name the same function.
 *
 * The rules encode the product decisions:
 *   - EVERY column move transitions the linked issue, BLOCKED and TO DO included: the board
 *     is a view of the ticket, so a column that disagrees with the tracker is a board that
 *     lies. (Moving a card back to TO DO used to be local-only, on a "we don't reopen
 *     tickets" rule that made dragging a card leftwards silently meaningless.)
 *   - BLOCKED was the last column exempt from that, on the rule that no tracker status
 *     stands behind it. Workflows say otherwise — they have a Blocked status, the board now
 *     READS it (`isBlockedishStatus`), and a column that a sync can put a card into but a
 *     drag cannot must mean two different things depending on which side moved it. So a
 *     drop into BLOCKED transitions too, and `preBlockStatus` is still recorded: whether it
 *     is worth REMEMBERING depends on whether the transition happened, which only the caller
 *     that attempts it knows. See `ipc.ts`.
 *   - BLOCKED is also the one target a workflow is allowed not to have. A workflow with no
 *     blocked status cannot express the concept, and the card must still block locally —
 *     again the caller's decision, not this resolver's.
 *   - Internal (non-JIRA) tasks never transition anything.
 */
import type { BoardColumn, Task, TaskStatus } from './model';
import { columnForTask, restingStatus, statusForColumn } from './board';

export type JiraTransitionTarget =
  'toTodo' | 'toInProgress' | 'toInReview' | 'toDone' | 'toBlocked';

export interface MoveResolution {
  /** The task's new local status. */
  localStatus: TaskStatus;
  /**
   * The column to restore on un-block (set only when moving into Blocked), else null.
   *
   * A *candidate*: the caller keeps it only when the block stayed local. A block the
   * tracker took is the tracker's to undo, and remembering a column for it would have the
   * app restore one status while the next sync asserts another.
   */
  preBlockStatus: TaskStatus | null;
  /** The JIRA transition to apply, or null when JIRA must not be touched. */
  jiraTransition: JiraTransitionTarget | null;
  /** True when nothing changes (dropped back into the same column). */
  noop: boolean;
}

/** Decide the effect of dropping `task` into `toColumn`. Pure. */
export function resolveMove(task: Task, toColumn: BoardColumn): MoveResolution {
  const from = columnForTask(task);
  // JIRA in particular, not "any external tracker": what this decides is whether a JIRA
  // TRANSITION is applied, and a GitHub issue has no workflow to transition. A GitHub card
  // takes the same `localStatus` from the same rules below and simply carries no transition
  // — its own write-back is a different act on a different API and belongs in its own
  // resolver, not in a branch of this one.
  const isJira = task.externalSource === 'jira';

  if (toColumn === from) {
    return {
      localStatus: restingStatus(task),
      preBlockStatus: task.preBlockStatus ?? null,
      jiraTransition: null,
      noop: true,
    };
  }

  // Into Blocked: block the ticket too, and offer where it came from as the column to
  // restore. Where it came FROM is where the card rests — a card whose agent is mid-run is
  // not "coming from" the run, and un-blocking must not restore it to a run state.
  if (toColumn === 'blocked') {
    return {
      localStatus: 'blocked',
      preBlockStatus: restingStatus(task),
      jiraTransition: isJira ? 'toBlocked' : null,
      noop: false,
    };
  }

  // Out of Blocked, or a plain column move.
  const localStatus = statusForColumn(toColumn);
  let jiraTransition: JiraTransitionTarget | null = null;
  if (isJira) {
    if (toColumn === 'todo') jiraTransition = 'toTodo';
    else if (toColumn === 'in-progress') jiraTransition = 'toInProgress';
    else if (toColumn === 'in-review') jiraTransition = 'toInReview';
    else if (toColumn === 'done') jiraTransition = 'toDone';
  }
  return { localStatus, preBlockStatus: null, jiraTransition, noop: false };
}
