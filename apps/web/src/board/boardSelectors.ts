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
import {
  hasPlan,
  hasRepo,
  isBoardProject,
  isFilingProject,
  PERSONAL_PROJECT_ID,
  type Project,
  type Task,
} from '@tm/shared/model';
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

/**
 * The relay's answer when it gave one, and the mirrored `projects` rows when it did not —
 * the resolution both {@link selectAgentProjects} and {@link selectFilingProjects} apply, over
 * their own predicate. A relayed read needs a desktop awake to run it, and against one that is
 * not polling it does not even fail fast: it waits out `RPC_TIMEOUT_MS` and then rejects into
 * `useBoardExtras`'s deliberately silent `catch`, which used to leave every control reading
 * this an empty state that looks exactly like *an account with no projects* rather than
 * *nobody answered* — while the rows sat in `state.projects` the whole time.
 *
 * WHY A REPLACEMENT AND NOT A MERGE
 * ---------------------------------
 * Each source is internally consistent and a union would match neither. A live desktop's
 * answer is authoritative *including its deletions*, so a project removed a moment ago is
 * absent from it and still present in the mirror until the next sync lands — a union
 * resurrects it, in a dropdown somebody is about to file a card under.
 *
 * WHY `relayAnswered` RATHER THAN "IS THE RELAYED LIST EMPTY"
 * -----------------------------------------------------------
 * Because "loaded and empty" and "nobody was home" are different answers and only the caller
 * can tell them apart. An account whose desktop genuinely has no projects to offer must show
 * none, not the mirror's idea of some; hence the flag, which `useBoardExtras` sets on the
 * successful branch alone.
 *
 * `predicate` is applied on BOTH branches — the same one `project:list`'s own consumers apply
 * over the same rows (see `MyTasks.tsx`'s `seed`) — so the shape is the same either way.
 *
 * Sorted by name (then id, to break a tie the same way every time), so the list does not
 * reshuffle under a reader's cursor when the relay's answer replaces the mirror's.
 */
function resolveProjects(
  mirrored: Record<string, Project>,
  relayed: readonly Project[],
  relayAnswered: boolean,
  predicate: (project: Project) => boolean,
): Project[] {
  const source = relayAnswered ? relayed : Object.values(mirrored);
  return source
    .filter(predicate)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The agent projects this browser can honestly name — a repo with no plan file, the only
 * shape delegation can run in (`resolveAgentProject`). Three controls draw this list — a
 * card's agent name and its project colour, and *Assign agent*'s picker — and every one of
 * them used to read a single relayed `agentProject:list`; see {@link resolveProjects} for why
 * that stopped being enough on its own.
 *
 * Deliberately narrower than {@link selectFilingProjects}: a repo-less project can be filed
 * under a card just fine, but there is no folder for an agent to work in.
 */
export function selectAgentProjects(
  mirrored: Record<string, Project>,
  relayed: readonly Project[],
  relayAnswered: boolean,
): Project[] {
  return resolveProjects(
    mirrored,
    relayed,
    relayAnswered,
    (project) => hasRepo(project) && !hasPlan(project),
  );
}

/**
 * The projects a card can be FILED under (`Task.projectTagId`) — the detail pane's Project
 * dropdown and the add-task dialog's Project field. Wider than {@link selectAgentProjects}:
 * a Personal-space project (no repo, no ticket prefix) is a fine thing to tag a card with,
 * it simply resolves to no agent project if a run is later delegated from it. See
 * `isFilingProject` for exactly what is (and is not) offered, and why.
 */
export function selectFilingProjects(
  mirrored: Record<string, Project>,
  relayed: readonly Project[],
  relayAnswered: boolean,
): Project[] {
  return resolveProjects(mirrored, relayed, relayAnswered, isFilingProject);
}
