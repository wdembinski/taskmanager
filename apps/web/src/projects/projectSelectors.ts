/**
 * The hub's own reads over the mirror — which projects it lists, and what it says about
 * each one. Pure, like `board/boardSelectors.ts`: the hub renders whatever `GET /v1/board`
 * has already delivered (every project on the account, `useCloudBoard`'s own mirror), so
 * there is nothing here to fetch.
 */
import { isPersonalBoard, type Project } from '@tm/shared/model';
import type { CloudBoardState } from '../board/cloudBoardStore';

/** Just the slices these read — so a test can pass a bag of rows, not a whole board. */
export type HubProjectState = Pick<CloudBoardState, 'projects'>;
export type HubTaskState = Pick<CloudBoardState, 'tasks'>;

/**
 * Every project worth a tile on the hub, alphabetically.
 *
 * The Personal board is excluded on purpose — it is the built-in My Tasks queue, already
 * its own nav tile, and `isPersonalBoard`/`Project`'s own doc comment says it is "hidden
 * from the Projects tab" on the desktop for the same reason.
 */
export function selectHubProjects(state: HubProjectState): Project[] {
  return Object.values(state.projects)
    .filter((project) => !isPersonalBoard(project.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ProjectStats {
  /** Un-archived rows filed directly in this project's own queue (`task.projectId`) — what
   *  a `ticket`/`plan` project's board shows. */
  ticketCount: number;
  /** Cards delegated to run here (`task.agentProjectId`) — what an `agent` project counts,
   *  since it keeps no queue of its own. */
  assignedCount: number;
  /** The most recent thing that happened on one of this project's own tickets — the later
   *  of a card being worked or given a status note — or null when nothing has yet. */
  lastActivityAt: number | null;
}

/** What the hub says about one project's tile — see {@link ProjectStats}. */
export function projectStats(state: HubTaskState, projectId: string): ProjectStats {
  let ticketCount = 0;
  let assignedCount = 0;
  let lastActivityAt: number | null = null;

  for (const task of Object.values(state.tasks)) {
    if (task.agentProjectId === projectId) assignedCount++;
    if (task.projectId !== projectId) continue;
    if (task.archivedAt == null) ticketCount++;
    const at = Math.max(task.workedAt ?? 0, task.statusNoteAt ?? 0);
    if (at > 0 && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at;
  }

  return { ticketCount, assignedCount, lastActivityAt };
}
