/**
 * The archive predicate (F14): whether a ticket is hidden because its tracker project, its
 * milestone, its epic or itself has been archived — and the handful of pure helpers every
 * surface (board, Backlog, Timeline, Graph, sidebar, pickers, palette) must share rather than
 * each writing its own filter.
 *
 * This is the **tracker's** archive — "finished, put away, still editable, never pruned" —
 * and not `Task.archivedAt`, which means *taken off the board*: set by the JIRA/GitHub
 * reconcilers and by variant discard, excluded from `board:tasks`, and destroyed by
 * `pruneArchivedBefore` after `ARCHIVE_RETENTION_DAYS`. The two never read each other's
 * column. No SQL `WHERE` and no per-screen filter may ever decide hiding on its own — every
 * reader goes through `isHidden`/`visibleTickets`/`pickable*` here, or the board, Backlog,
 * Timeline, Graph, sidebar and palette would disagree about what is archived.
 *
 * Built on **structural input types**, not `Milestone` / `Project` / `Task` themselves: this
 * ships before F14.1 adds the real `archivedAt` / `trackerArchivedAt` columns, and once it
 * does, the real types satisfy these with no change here. Pure — no React, no Electron, no
 * DB — the same discipline as `@shared/tickets`.
 */
import type { Milestone, Project, Task } from './model';
import { isNativeTicket } from './tickets';

/** The slice of a `Milestone` this module needs, before or after F14.1 adds the column. */
export type ArchivableMilestone = Pick<Milestone, 'id'> & { archivedAt?: number | null };

/** The slice of a `Project` this module needs, before or after F14.1 adds the column. */
export type ArchivableProject = Pick<Project, 'id'> & { archivedAt?: number | null };

/**
 * The slice of a `Task` this module needs to decide whether it is hidden. An epic is looked
 * up through this same shape (as a value in `ArchiveIndex.epics`), so its own
 * `trackerArchivedAt` is read the same way a ticket's is.
 */
export type ArchivableTicket = Pick<
  Task,
  'id' | 'projectId' | 'source' | 'milestoneId' | 'epicTaskId'
> & { trackerArchivedAt?: number | null };

/**
 * The three lookups `archivedBy` needs, keyed by id. Generic over the three shapes so a
 * caller already holding real `Milestone` / `Task` / `Project` maps can pass them as-is,
 * rather than narrowing them down to `Archivable*` first.
 */
export interface ArchiveIndex<
  TMilestone extends ArchivableMilestone = ArchivableMilestone,
  TEpic extends ArchivableTicket = ArchivableTicket,
  TProject extends ArchivableProject = ArchivableProject,
> {
  milestones: Map<string, TMilestone>;
  epics: Map<string, TEpic>;
  projects: Map<string, TProject>;
}

/** Which archived thing hid a ticket, and that thing's id — or `null` when nothing did. */
export type ArchivedBy = { by: 'project' | 'milestone' | 'epic' | 'self'; id: string } | null;

/**
 * Why a ticket is hidden, or `null` when it is not — the first reason found, in order:
 * its tracker project, its milestone, its epic, then itself.
 *
 * Always `null` for a row that is not a **native** ticket ({@link isNativeTicket}): a
 * JIRA/GitHub/Linear row's lifecycle belongs to its tracker, not this one.
 *
 * A lookup miss — `milestoneId` or `epicTaskId` naming a row that has been deleted, or one
 * simply absent from `index` — counts as **not archived** at that step, the same way a
 * missing milestone already degrades to the "No milestone" bucket in `backlogView.ts`'s
 * `groupTickets`: a dangling id must never hide a ticket silently.
 */
export function archivedBy<
  TMilestone extends ArchivableMilestone = ArchivableMilestone,
  TEpic extends ArchivableTicket = ArchivableTicket,
  TProject extends ArchivableProject = ArchivableProject,
>(ticket: ArchivableTicket, index: ArchiveIndex<TMilestone, TEpic, TProject>): ArchivedBy {
  if (!isNativeTicket(ticket)) return null;

  const project = index.projects.get(ticket.projectId);
  if (project && project.archivedAt != null) return { by: 'project', id: project.id };

  if (ticket.milestoneId) {
    const milestone = index.milestones.get(ticket.milestoneId);
    if (milestone && milestone.archivedAt != null) {
      return { by: 'milestone', id: milestone.id };
    }
  }

  if (ticket.epicTaskId) {
    const epic = index.epics.get(ticket.epicTaskId);
    if (epic && epic.trackerArchivedAt != null) return { by: 'epic', id: epic.id };
  }

  if (ticket.trackerArchivedAt != null) return { by: 'self', id: ticket.id };

  return null;
}

/**
 * Whether a ticket should be hidden from an ordinary view — the single switch every
 * "Include archived" toggle (Backlog search, the Archived view, a direct link) flips by
 * passing `includeArchived: true`.
 */
export function isHidden<
  TMilestone extends ArchivableMilestone = ArchivableMilestone,
  TEpic extends ArchivableTicket = ArchivableTicket,
  TProject extends ArchivableProject = ArchivableProject,
>(
  ticket: ArchivableTicket,
  index: ArchiveIndex<TMilestone, TEpic, TProject>,
  opts?: { includeArchived?: boolean },
): boolean {
  return !opts?.includeArchived && archivedBy(ticket, index) !== null;
}

/**
 * Filters a ticket list down to what an ordinary view should draw — the board (ticket-project
 * scope), Backlog, Timeline and Graph each get back exactly the shape they passed in, in the
 * same order.
 */
export function visibleTickets<
  T extends ArchivableTicket,
  TMilestone extends ArchivableMilestone = ArchivableMilestone,
  TEpic extends ArchivableTicket = ArchivableTicket,
  TProject extends ArchivableProject = ArchivableProject,
>(
  tickets: readonly T[],
  index: ArchiveIndex<TMilestone, TEpic, TProject>,
  opts?: { includeArchived?: boolean },
): T[] {
  return tickets.filter((ticket) => !isHidden(ticket, index, opts));
}

/**
 * Milestones a picker should offer: archived ones are dropped, except the one already
 * matching `currentId` — the same rule `offeredMilestones` already applies for `closed`
 * (`packages/ui/src/projects/ticketRegistries.ts`), which stays its own, separate filter.
 * Keeps the input order and the element type.
 */
export function pickableMilestones<T extends ArchivableMilestone>(
  milestones: readonly T[],
  currentId?: string | null,
): T[] {
  return milestones.filter(
    (milestone) => milestone.archivedAt == null || milestone.id === currentId,
  );
}

/**
 * Epics a picker should offer: archived ones (by `trackerArchivedAt`) are dropped, except
 * the one already matching `currentId`. Keeps the input order and the element type.
 */
export function pickableEpics<T extends ArchivableTicket>(
  epics: readonly T[],
  currentId?: string | null,
): T[] {
  return epics.filter((epic) => epic.trackerArchivedAt == null || epic.id === currentId);
}

/**
 * Ticket projects a picker should offer: archived ones are dropped, except the one already
 * matching `currentId`. Keeps the input order and the element type.
 */
export function pickableProjects<T extends ArchivableProject>(
  projects: readonly T[],
  currentId?: string | null,
): T[] {
  return projects.filter((project) => project.archivedAt == null || project.id === currentId);
}

/**
 * Builds the three `Map`s `archivedBy` and `isHidden` need in one call, so a caller does not
 * hand-roll `new Map(x.map((v) => [v.id, v]))` three times over.
 */
export function archiveIndexOf<
  TMilestone extends ArchivableMilestone = ArchivableMilestone,
  TEpic extends ArchivableTicket = ArchivableTicket,
  TProject extends ArchivableProject = ArchivableProject,
>(
  milestones: readonly TMilestone[],
  epics: readonly TEpic[],
  projects: readonly TProject[],
): ArchiveIndex<TMilestone, TEpic, TProject> {
  return {
    milestones: new Map(milestones.map((milestone) => [milestone.id, milestone])),
    epics: new Map(epics.map((epic) => [epic.id, epic])),
    projects: new Map(projects.map((project) => [project.id, project])),
  };
}
