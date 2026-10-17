/**
 * The auto-archive sweep's due predicate (F14.10): which open milestones are old enough,
 * closed enough, to archive on their own — `AppSettings.ticketAutoArchiveWeeks` (F14, open
 * question 1) is the knob, this file is the only place that reads it against a milestone's
 * tickets.
 *
 * **Structural input types**, not `Milestone` / `Task` themselves — the same discipline
 * `trackerArchive.ts` uses, and for the same reason: this is pure, no React, no Electron, no
 * DB, so a caller already holding the real rows (or a fixture) can pass them as-is without a
 * cast.
 *
 * "Closed enough" means every ticket on the milestone is `done` or `cancelled`
 * ({@link isOpenTicketStatus}) — a milestone with even one open ticket, or no tickets at all,
 * is never due. "Old enough" means every one of those tickets' own closing times is at least
 * `weeks` ago; a ticket's closing time is its activity-log row when one exists
 * (`doneTimes`), falling back to `updatedAt` — see the F14 doc's open question 4, "a ticket
 * with no log row uses `updatedAt`, which can only make the archive later, never earlier".
 * A ticket with neither blocks the whole milestone, the same way an open ticket does: there
 * is no reading of "undatable" that is safe to treat as "long enough ago".
 */
import type { TaskStatus } from './model';
import { isOpenTicketStatus } from './tickets';

/** One week, in ms — the unit `ticketAutoArchiveWeeks` and `dueForAutoArchive` share. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The slice of a `Milestone` the sweep needs. */
export type AutoArchivableMilestone = {
  id: string;
  archivedAt?: number | null;
};

/** The slice of a `Task` the sweep needs. */
export type AutoArchivableTicket = {
  id: string;
  milestoneId: string | null;
  status: TaskStatus;
  updatedAt: number | null;
};

/**
 * The ids of `milestones` (in input order) that are due to be auto-archived right now.
 *
 * `weeks` is the raw settings value (`AppSettings.ticketAutoArchiveWeeks`): `null`, a
 * non-finite number, or anything `<= 0` means the sweep is off and nothing is ever due — a
 * `0`-week threshold is not "archive instantly", it is "no threshold was set".
 *
 * Already-archived milestones are skipped outright; their tickets are not even looked at.
 */
export function dueForAutoArchive(
  milestones: readonly AutoArchivableMilestone[],
  tickets: readonly AutoArchivableTicket[],
  doneTimes: ReadonlyMap<string, number>,
  now: number,
  weeks: number | null,
): string[] {
  if (weeks === null || !Number.isFinite(weeks) || weeks <= 0) return [];

  const ticketsByMilestone = new Map<string, AutoArchivableTicket[]>();
  for (const ticket of tickets) {
    if (ticket.milestoneId === null) continue;
    const existing = ticketsByMilestone.get(ticket.milestoneId);
    if (existing) {
      existing.push(ticket);
    } else {
      ticketsByMilestone.set(ticket.milestoneId, [ticket]);
    }
  }

  const thresholdMs = weeks * WEEK_MS;
  const due: string[] = [];

  for (const milestone of milestones) {
    if (milestone.archivedAt != null) continue;

    const milestoneTickets = ticketsByMilestone.get(milestone.id);
    if (!milestoneTickets || milestoneTickets.length === 0) continue;
    if (milestoneTickets.some((ticket) => isOpenTicketStatus(ticket.status))) continue;

    const closedTimes: number[] = [];
    let undatable = false;
    for (const ticket of milestoneTickets) {
      const closedAt = doneTimes.get(ticket.id) ?? ticket.updatedAt;
      if (closedAt == null) {
        undatable = true;
        break;
      }
      closedTimes.push(closedAt);
    }
    if (undatable) continue;

    const latestClose = Math.max(...closedTimes);
    if (now - latestClose >= thresholdMs) due.push(milestone.id);
  }

  return due;
}
