/**
 * Which of the mirrored rows a board is actually looking at.
 *
 * The desktop's My Tasks board is not "every task the account has": it is one project's
 * un-archived rows (`store.ts`'s `selectBoardTasks`), with the archived half kept apart for
 * the Archived dialog (`selectArchivedBoardTasks`). The cloud mirror carries everything —
 * every project's queue, and the archived rows too — so without this the web board renders a
 * superset of the queue it is meant to look exactly like. These two functions are that SQL,
 * said once in JS, parameterized on WHICH project's queue is being drawn — the Personal
 * board and every ticket/plan project's own board are the same shape of question.
 *
 * They are selectors read at render, deliberately NOT a filter in
 * `cloudBoardStore.applyBoardResponse`, for two reasons:
 *
 *  - the Archived dialog needs the archived rows, so ingest cannot drop them; and
 *  - `reconcilePendingStatusChanges` looks a pending edit's task up in `state.tasks`. A card
 *    archived on the desktop after you dragged it would simply not be there to match, and
 *    its pending badge would sit there until the 2-minute timeout swept it.
 *
 * A **step** is returned by {@link selectBoardTasks} like any other row: it inherits its
 * parent's `projectId` (see `addSubtask`), and `groupSubtasks` needs it in the list to hang
 * it under the parent's card. Filtering steps out here would empty every card of its steps.
 */
import type { Task } from '@tm/shared/model';
import type { CloudBoardState } from './cloudBoardStore';

/** Just the slice these read — so a test can pass a bag of tasks, not a whole board. */
export type BoardTaskState = Pick<CloudBoardState, 'tasks'>;

/** The rows a project's board draws: its own, not archived, in board order. */
export function selectBoardTasks(state: BoardTaskState, projectId: string): Task[] {
  return Object.values(state.tasks)
    .filter((task) => task.projectId === projectId && task.archivedAt == null)
    .sort((a, b) => a.order - b.order);
}

/** The other half: that project's rows that have been archived, most recently archived first. */
export function selectArchivedTasks(state: BoardTaskState, projectId: string): Task[] {
  return Object.values(state.tasks)
    .filter((task) => task.projectId === projectId && task.archivedAt != null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.order - b.order);
}
