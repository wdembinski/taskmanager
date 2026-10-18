/**
 * The Archived view's own model (F14.8): one row per archived milestone, epic or project,
 * with the native tickets under it tallied into done/open — pure, no React, same discipline
 * as `archiveDialog.ts` and `backlogView.ts`.
 */
import type { Task } from '@tm/shared/model';
import { parseTicketKey } from '@tm/shared/ticketKey';
import { isNativeTicket, isOpenTicketStatus } from '@tm/shared/tickets';
import type { ArchivedListing } from '@tm/shared/trackerArchive';

export type ArchivedTab = 'milestone' | 'epic' | 'project';

export interface ArchivedRow {
  kind: ArchivedTab;
  id: string;
  /** Display name — a milestone's or project's own `name`, an epic's `"KEY · title"`. */
  name: string;
  archivedAt: number;
  /** A milestone's own due date; `null` for an epic or a project row. */
  dueAt: number | null;
  /** The native tickets filed under this row, in key order. */
  tickets: Task[];
  doneCount: number;
  openCount: number;
  /** `openCount > 0` — restoring is not just bookkeeping, something is still unfinished. */
  flagged: boolean;
}

export interface ArchivedViewModel {
  milestones: ArchivedRow[];
  epics: ArchivedRow[];
  projects: ArchivedRow[];
  total: number;
}

function epicName(epic: Pick<Task, 'ticketKey' | 'title'>): string {
  return epic.ticketKey ? `${epic.ticketKey} · ${epic.title}` : epic.title;
}

/** The ordinal a key sorts by — `TM-9` is 9, `TM-10` is 10 — same reading `backlogView.ts`'s
 *  `sortBacklog('key')` uses, so a row's tickets and the Backlog agree on what "key order"
 *  means. */
function ticketOrdinal(ticket: Pick<Task, 'ticketKey' | 'ticketNumber'>): number {
  if (typeof ticket.ticketNumber === 'number') return ticket.ticketNumber;
  return parseTicketKey(ticket.ticketKey ?? '')?.ticketNumber ?? 0;
}

/** `tickets`, narrowed to the native ones that match `matches`, sorted into key order. */
function ticketsFor(tickets: readonly Task[], matches: (ticket: Task) => boolean): Task[] {
  return tickets
    .filter((ticket) => isNativeTicket(ticket) && matches(ticket))
    .sort((a, b) => ticketOrdinal(a) - ticketOrdinal(b));
}

function rowFor(
  kind: ArchivedTab,
  id: string,
  name: string,
  archivedAt: number,
  dueAt: number | null,
  tickets: Task[],
): ArchivedRow {
  const doneCount = tickets.filter((t) => !isOpenTicketStatus(t.status)).length;
  const openCount = tickets.length - doneCount;
  return {
    kind,
    id,
    name,
    archivedAt,
    dueAt,
    tickets,
    doneCount,
    openCount,
    flagged: openCount > 0,
  };
}

function byArchivedAtDesc(a: { archivedAt: number }, b: { archivedAt: number }): number {
  return b.archivedAt - a.archivedAt;
}

export function archivedViewModel(
  listing: ArchivedListing,
  tickets: readonly Task[],
  projectId: string | null,
): ArchivedViewModel {
  const allTickets = tickets as Task[];

  const milestones = (listing.milestones ?? [])
    .filter((m) => projectId == null || m.projectId === projectId)
    .map((m) =>
      rowFor(
        'milestone',
        m.id,
        m.name,
        m.archivedAt ?? 0,
        m.dueAt,
        ticketsFor(allTickets, (t) => t.milestoneId === m.id),
      ),
    )
    .sort(byArchivedAtDesc);

  const epics = (listing.epics ?? [])
    .filter((e) => projectId == null || e.projectId === projectId)
    .map((e) =>
      rowFor(
        'epic',
        e.id,
        epicName(e),
        e.trackerArchivedAt ?? 0,
        null,
        ticketsFor(allTickets, (t) => t.epicTaskId === e.id),
      ),
    )
    .sort(byArchivedAtDesc);

  const projects = (listing.projects ?? [])
    .map((p) =>
      rowFor(
        'project',
        p.id,
        p.name,
        p.archivedAt ?? 0,
        null,
        ticketsFor(allTickets, (t) => t.projectId === p.id),
      ),
    )
    .sort(byArchivedAtDesc);

  return {
    milestones,
    epics,
    projects,
    total: milestones.length + epics.length + projects.length,
  };
}

export function archivedTicketSummary(row: ArchivedRow): string {
  if (row.tickets.length === 0) return 'No tickets';
  if (row.openCount === 0) return `${row.doneCount} done`;
  return `${row.doneCount} done · ${row.openCount} open`;
}
