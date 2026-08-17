/**
 * Which of the mirrored rows the web board is actually looking at.
 *
 * The desktop's board is not "every task the account has": it is ONE board's — Personal, or
 * a native ticket project's (Phase 24: `boardScope.ts`) — un-archived rows, ordered by
 * `order` (`store.ts`'s `getBoardTasks`), with the archived half kept apart for the Archived
 * dialog (`getArchivedTasksFor`). The cloud mirror carries everything — every project's
 * queue, ticket projects included, and the archived rows too (`cloudDelta.ts` shapes `Task`/
 * `Project` rows uniformly, with no `kind` filter) — so without this the web board renders a
 * superset of the app it is meant to look exactly like. These two functions are that SQL,
 * said once in JS.
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
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { CloudBoardState } from './cloudBoardStore';

/** Just the slice these read — so a test can pass a bag of tasks, not a whole board. */
export type BoardTaskState = Pick<CloudBoardState, 'tasks'>;

/**
 * The rows the board draws: one project's, not archived, in board order. `projectId`
 * defaults to Personal — every existing caller that has not been taught about scopes yet
 * keeps reading exactly what it always has.
 */
export function selectBoardTasks(
  state: BoardTaskState,
  projectId: string = PERSONAL_PROJECT_ID,
): Task[] {
  return Object.values(state.tasks)
    .filter((task) => task.projectId === projectId && task.archivedAt == null)
    .sort((a, b) => a.order - b.order);
}

/** The other half: that project's rows that have been archived, most recently archived
 *  first. Same default as {@link selectBoardTasks}, for the same reason. */
export function selectArchivedTasks(
  state: BoardTaskState,
  projectId: string = PERSONAL_PROJECT_ID,
): Task[] {
  return Object.values(state.tasks)
    .filter((task) => task.projectId === projectId && task.archivedAt != null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.order - b.order);
}
