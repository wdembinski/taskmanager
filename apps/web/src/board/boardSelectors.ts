/**
 * Which of the mirrored rows the web board is actually looking at.
 *
 * The desktop's board is not "every task the account has": it is the Personal project's
 * un-archived rows, ordered by `order` (`store.ts`'s `selectBoardTasks`), with the archived
 * half kept apart for the Archived dialog (`selectArchivedBoardTasks`). The cloud mirror
 * carries everything — every project's queue, and the archived rows too — so without this
 * the web board renders a superset of the app it is meant to look exactly like. These two
 * functions are that SQL, said once in JS.
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
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@tm/shared/model';
import type { CloudBoardState } from './cloudBoardStore';

/** Just the slice these read — so a test can pass a bag of tasks, not a whole board. */
export type BoardTaskState = Pick<CloudBoardState, 'tasks'>;

/** The rows the board draws: Personal, not archived, in board order. */
export function selectBoardTasks(state: BoardTaskState): Task[] {
  return Object.values(state.tasks)
    .filter((task) => task.projectId === PERSONAL_PROJECT_ID && task.archivedAt == null)
    .sort((a, b) => a.order - b.order);
}

/** The other half: Personal rows that have been archived, most recently archived first. */
export function selectArchivedTasks(state: BoardTaskState): Task[] {
  return Object.values(state.tasks)
    .filter((task) => task.projectId === PERSONAL_PROJECT_ID && task.archivedAt != null)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.order - b.order);
}

/**
 * The agent projects this browser can honestly name — the relay's answer when it gave one,
 * and the mirrored `projects` rows when it did not.
 *
 * Five controls draw this list (a card's agent name and its project colour, the detail pane's
 * Project dropdown, *Assign agent*'s picker, the add-task dialog's Project field) and every
 * one of them used to read a single relayed `agentProject:list`. A relayed read needs a
 * desktop awake to run it, and against one that is not polling it does not even fail fast: it
 * waits out `RPC_TIMEOUT_MS` and then rejects into `useBoardExtras`'s deliberately silent
 * `catch`. All five then rendered an empty state that reads as *an account with no projects*
 * rather than as *nobody answered* — while the rows sat in `state.projects` the whole time.
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
 * can tell them apart. An account whose desktop genuinely has no agent projects must show
 * none, not the mirror's idea of some; hence the flag, which `useBoardExtras` sets on the
 * successful branch alone.
 *
 * `kind === 'agent'` is filtered on BOTH branches — the same predicate the desktop's own
 * handler applies over the same rows (`apps/client/src/main/ipc.ts`) — so the shape is the
 * same either way and neither branch can leak the Personal board, a legacy plan project or a
 * ticket project into a repo picker.
 *
 * Sorted by name (then id, to break a tie the same way every time), so the list does not
 * reshuffle under a reader's cursor when the relay's answer replaces the mirror's.
 */
export function selectAgentProjects(
  mirrored: Record<string, Project>,
  relayed: readonly Project[],
  relayAnswered: boolean,
): Project[] {
  const source = relayAnswered ? relayed : Object.values(mirrored);
  return source
    .filter((project) => project.kind === 'agent')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
