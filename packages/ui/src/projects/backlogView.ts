/**
 * The backlog's own view logic — filter, sort and group by epic — kept pure and apart from
 * `BacklogTable` so the grouping and the "TM-9 before TM-10" sort can be tested without a DOM.
 */
import type { Task } from '@tm/shared/model';
import { parseTicketKey } from '@tm/shared/ticketKey';

/**
 * The bucket every ticket with no epic — or one that names an epic not on this board — lands
 * in. Named rather than left blank, so an orphaned ticket reads as a group and not as a gap.
 */
export const NO_EPIC_GROUP = 'No epic';

export interface BacklogGroup {
  /** The epic's own id, or null for the {@link NO_EPIC_GROUP} bucket. */
  epicId: string | null;
  epicTitle: string;
  tickets: Task[];
}

export type BacklogSortKey = 'key' | 'due';

/**
 * Tickets whose title, key or any label matches `query`, case-blind.
 *
 * Returns the SAME array when `query` is blank — not merely an equal one — so a caller that
 * memoizes off this result sees no change on a no-op keystroke (an empty box, or one just
 * cleared back to empty) and skips the re-render a fresh array would otherwise force.
 */
export function filterTickets(tickets: readonly Task[], query: string): Task[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tickets as Task[];
  return (tickets as Task[]).filter((ticket) => {
    if (ticket.title.toLowerCase().includes(needle)) return true;
    if (ticket.ticketKey?.toLowerCase().includes(needle)) return true;
    return (ticket.labels ?? []).some((label) => label.toLowerCase().includes(needle));
  });
}

/**
 * The ordinal a key sorts by — `TM-9` is 9, `TM-10` is 10 — read from `ticketNumber` when the
 * row carries it and parsed out of `ticketKey` otherwise, so a fixture built with only the key
 * set (as most callers are) sorts exactly like a real row.
 */
function ticketOrdinal(ticket: Pick<Task, 'ticketKey' | 'ticketNumber'>): number {
  if (typeof ticket.ticketNumber === 'number') return ticket.ticketNumber;
  return parseTicketKey(ticket.ticketKey ?? '')?.ticketNumber ?? 0;
}

/**
 * `tickets`, ordered by `sortKey`. Always a new array — callers after `filterTickets`'s
 * identity shortcut get it from that call, not this one.
 *
 * `'key'` compares the parsed ORDINAL, never the string: `'TM-10' < 'TM-9'` under a plain
 * string compare, which is backwards and is the bug this function exists not to have.
 * `'due'` puts undated tickets (`dueAt: null`) last, regardless of direction — an unplanned
 * ticket is not "earliest due", it has no answer to the question being asked.
 */
export function sortBacklog(tickets: readonly Task[], sortKey: BacklogSortKey): Task[] {
  const sorted = [...tickets];
  if (sortKey === 'key') {
    sorted.sort((a, b) => ticketOrdinal(a) - ticketOrdinal(b));
  } else {
    sorted.sort((a, b) => {
      if (a.dueAt == null && b.dueAt == null) return 0;
      if (a.dueAt == null) return 1;
      if (b.dueAt == null) return -1;
      return a.dueAt - b.dueAt;
    });
  }
  return sorted;
}

/**
 * `tickets`, bucketed under the epic each names — an epic resolved from WITHIN the same list,
 * since a ticket's epic is just another row on the same board. A ticket whose `epicTaskId` is
 * null, or names an epic that isn't in this list (filtered out elsewhere, or simply gone),
 * lands in {@link NO_EPIC_GROUP} rather than being dropped: every input ticket appears in
 * exactly one output group, always.
 */
export function groupTickets(tickets: readonly Task[]): BacklogGroup[] {
  const epicsById = new Map<string, Task>();
  for (const ticket of tickets) {
    if (ticket.issueType === 'epic') epicsById.set(ticket.id, ticket);
  }

  const epicOrder: string[] = [];
  const epicBuckets = new Map<string, Task[]>();
  const orphans: Task[] = [];

  for (const ticket of tickets) {
    const epic = ticket.epicTaskId ? epicsById.get(ticket.epicTaskId) : undefined;
    if (!epic) {
      orphans.push(ticket);
      continue;
    }
    let bucket = epicBuckets.get(epic.id);
    if (!bucket) {
      bucket = [];
      epicBuckets.set(epic.id, bucket);
      epicOrder.push(epic.id);
    }
    bucket.push(ticket);
  }

  const groups: BacklogGroup[] = epicOrder.map((epicId) => ({
    epicId,
    epicTitle: epicsById.get(epicId)!.title,
    tickets: epicBuckets.get(epicId)!,
  }));
  if (orphans.length > 0) {
    groups.push({ epicId: null, epicTitle: NO_EPIC_GROUP, tickets: orphans });
  }
  return groups;
}

/** The whole pipeline a `BacklogTable` renders from: filter, then sort, then group. */
export function backlogRows(
  tickets: readonly Task[],
  query: string,
  sortKey: BacklogSortKey,
): BacklogGroup[] {
  return groupTickets(sortBacklog(filterTickets(tickets, query), sortKey));
}
