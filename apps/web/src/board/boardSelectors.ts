/**
 * Which of the mirrored rows the web board is actually looking at.
 *
 * The desktop's board is not "every task the account has": it is one **scope**'s un-archived
 * rows — `'all'` unions every board project's cards, a single project id narrows to just that
 * board (`store.ts`'s `getBoardTasks`/`getAllBoardTasks`) — with the archived half kept apart
 * for the Archived dialog (`getArchivedTasksFor`/`getAllArchivedBoardTasks`). The cloud mirror
 * carries everything — every project's queue, board or not, and the archived rows too — so
 * without this the web board renders a superset of the app it is meant to look exactly like.
 * These two functions are that SQL, said once in JS.
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
import { isBoardProject, PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { CloudBoardState } from './cloudBoardStore';

/** Just the slice these read — so a test can pass a bag of tasks (and, now, projects) rather
 *  than a whole board. */
export type BoardTaskState = Pick<CloudBoardState, 'tasks' | 'projects'>;

/**
 * Whether `task` belongs to `scope` — `'all'` unions every board project (Personal, plus any
 * project with no plan file: `isBoardProject`), matching `store.ts`'s `getAllBoardTasks` join.
 * A project not yet mirrored falls back to the one board id known without a lookup at all.
 */
function inScope(state: BoardTaskState, task: Task, scope: string): boolean {
  if (scope !== 'all') return task.projectId === scope;
  const project = state.projects[task.projectId];
  return project ? isBoardProject(project) : task.projectId === PERSONAL_PROJECT_ID;
}

/** The rows the board draws: `scope`'s, not archived, in board order. */
export function selectBoardTasks(state: BoardTaskState, scope: string): Task[] {
  return Object.values(state.tasks)
    .filter((task) => inScope(state, task, scope) && task.archivedAt == null)
    .sort((a, b) => a.order - b.order);
}

/** The other half: `scope`'s rows that have been archived, most recently archived first. */
export function selectArchivedTasks(state: BoardTaskState, scope: string): Task[] {
  return Object.values(state.tasks)
    .filter((task) => inScope(state, task, scope) && task.archivedAt != null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.order - b.order);
}
