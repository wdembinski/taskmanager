/**
 * The archive predicate (F14): whether a ticket is hidden because its tracker project, its
 * milestone, its epic or itself has been archived — and the handful of pure helpers every
 * surface (board, Backlog, Timeline, Graph, sidebar, pickers, palette) must share rather than
 * each writing its own filter.
 *
 * Also the shared **archive/restore contract**: the request and result types `store.ts`
 * (F14.3), `ipc.ts` (F14.4) and the UI (F14.7/F14.8) all import, so the main-process store and
 * the renderer agree on one shape for "archive this", "restore this" and what either can
 * refuse.
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
import { isEpic, isNativeTicket } from './tickets';

/**
 * What to do with a milestone's (or epic's/project's) still-open tickets when it is
 * archived: leave them where they are and only bucket them as "No milestone" in views that
 * drop into one (`backlog`), move them to another milestone that outlives this one
 * (`milestone`), or archive them along with their parent (`archive`).
 */
export type OpenTicketsChoice =
  { kind: 'backlog' } | { kind: 'milestone'; milestoneId: string } | { kind: 'archive' };

/** The thing an archive/restore call acts on — one row, named by its own id. */
export type ArchiveTarget = { kind: 'milestone' | 'epic' | 'project'; id: string };

/**
 * Why an archive/restore call was refused. The store (F14.3) returns one of these instead of
 * throwing, so the renderer can show the human a reason rather than a stack trace.
 */
export type ArchiveRefusalReason =
  | 'not-found' // unknown id
  | 'already-archived'
  | 'not-archived' // restore of something active
  | 'not-a-ticket-project' // agent/plan project (ownsTickets false)
  | 'not-an-epic' // epic op on a non-epic or non-native ticket
  | 'target-not-found' // choice.milestoneId unknown
  | 'target-is-self'
  | 'target-archived'
  | 'target-other-project'
  | 'choice-required'; // open tickets exist and no OpenTicketsChoice was given

/**
 * What an archive/restore call hands back: on success, the project touched and which tasks
 * and milestones changed (for the renderer to patch without a full refetch); on refusal, a
 * reason plus a short, specific `message` ready to show as-is — for example
 * `"M2 · Review is archived"` — so the IPC layer never has to synthesize its own copy.
 */
export type ArchiveResult =
  | { ok: true; projectId: string; changedTaskIds: string[]; milestonesChanged: boolean }
  | { ok: false; reason: ArchiveRefusalReason; message: string };

/** The archived rows a project's "Archived" view lists, grouped by kind. */
export interface ArchivedListing {
  projects: Project[];
  milestones: Milestone[];
  epics: Task[];
}

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
 * Where a restore call for `by` should land — the one `ArchiveTarget` `archive:restore` can
 * act on (F14.9). A project or milestone restores itself; an epic restores by its own id
 * either way `by` named it (`epic`, or `self` when the archived ticket IS that epic — the
 * only way `archivedBy` ever returns `self`, see `archiveEpicTx`). `null` only guards against
 * a `self` ticket that somehow isn't an epic, which `archivedBy` should never produce.
 */
export function archiveRestoreTarget(
  ticket: Pick<Task, 'id' | 'issueType'>,
  by: NonNullable<ArchivedBy>,
): ArchiveTarget | null {
  switch (by.by) {
    case 'project':
    case 'milestone':
    case 'epic':
      return { kind: by.by, id: by.id };
    case 'self':
      return isEpic(ticket) ? { kind: 'epic', id: ticket.id } : null;
  }
}

/** Display names for {@link archivedBanner}'s "with <name>" clause, keyed the same way
 *  {@link ArchiveIndex} is — a milestone's own `name`, an epic's own ticket key alone (its
 *  banner already says "epic", so repeating the title would be noise), a project's own
 *  `name`. */
export interface ArchivedByNames {
  projects: Map<string, string>;
  milestones: Map<string, string>;
  epics: Map<string, string>;
}

/** Builds {@link ArchivedByNames} from the same three lists {@link archiveIndexOf} reads.
 *  `epics` can be a whole ticket list, same as `archiveIndexOf`'s own argument: only the ids
 *  `by` actually names are ever looked up. An epic with no `ticketKey` (shouldn't happen — a
 *  native ticket always has one) falls back to its title rather than going nameless. */
export function archivedByNamesOf(
  milestones: readonly Pick<Milestone, 'id' | 'name'>[],
  epics: readonly Pick<Task, 'id' | 'ticketKey' | 'title'>[],
  projects: readonly Pick<Project, 'id' | 'name'>[],
): ArchivedByNames {
  return {
    milestones: new Map(milestones.map((m) => [m.id, m.name])),
    epics: new Map(epics.map((e) => [e.id, e.ticketKey ?? e.title])),
    projects: new Map(projects.map((p) => [p.id, p.name])),
  };
}

/**
 * The sentence naming what hid a ticket (F14.9) — `"Archived with <milestone name>"`,
 * `"Archived with epic <key>"`, `"Archived with project <name>"`, or plain `"Archived"` for
 * `self` (the ticket IS the archived epic) and for a lookup `names` can't resolve — a miss
 * degrades to the same plain text a `by`-less filter already reads, rather than a sentence
 * naming a project/milestone/epic with no name in it. Shared by the F12 panel's restore
 * banner and the board's `hiddenByMessage`, which lower-cases it to fit mid-sentence.
 */
export function archivedBanner(by: NonNullable<ArchivedBy>, names?: ArchivedByNames): string {
  if (by.by === 'self') return 'Archived';
  const name = names?.[`${by.by}s` as 'projects' | 'milestones' | 'epics']?.get(by.id);
  if (!name) return 'Archived';
  return by.by === 'milestone' ? `Archived with ${name}` : `Archived with ${by.by} ${name}`;
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
