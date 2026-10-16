/**
 * The Links section's own view model — every ticket link and chain link that touches one
 * ticket, grouped and sorted for display. Pure, no React, for the same reason
 * `@shared/ticketLinks` is: the phrasing a row shows has to be the one `linksFor()` already
 * settled on, not a second copy of the vocabulary that could drift from it.
 */
import { columnForTask } from '@tm/shared/board';
import type { BoardColumn, IssueType, Task, TicketLink } from '@tm/shared/model';
import {
  linksFor,
  TICKET_LINK_REFUSAL_MESSAGE,
  TICKET_LINK_VOCABULARY,
  type TicketLinkResult,
} from '@tm/shared/ticketLinks';
import type { TaskLink } from '@tm/shared/taskChain';

export interface LinkedTicketRow {
  /** What `ticketLink:remove` addresses. */
  linkId: string;
  /** What `onOpenTask` opens. */
  otherTaskId: string;
  /** `ticketKey`, else the id when the ticket is missing. */
  key: string;
  /** Null when missing. */
  title: string | null;
  issueType: IssueType | null;
  /** The status; null when missing. */
  column: BoardColumn | null;
  /** The linked ticket's `projectId` differs from this ticket's. */
  otherProject: boolean;
  /** Not in `tasksById`: greyed, still removable. */
  missing: boolean;
}

export interface LinkedTicketGroup {
  phrase: string;
  rows: LinkedTicketRow[];
}

/** The tickets this one runs after/before, as keys (id fallback). */
export interface ChainPointer {
  runsAfter: string[];
  runsBefore: string[];
}

export interface LinkedTicketsSection {
  groups: LinkedTicketGroup[];
  chain: ChainPointer | null;
}

/** Every phrase a row can show, in the order its group should appear. */
const PHRASE_ORDER: readonly string[] = Object.values(TICKET_LINK_VOCABULARY).flatMap((entry) =>
  entry.symmetric ? [entry.outward] : [entry.outward, entry.inward],
);

function keyFor(taskId: string, tasksById: ReadonlyMap<string, Task>): string {
  return tasksById.get(taskId)?.ticketKey ?? taskId;
}

function compareKeys(a: LinkedTicketRow, b: LinkedTicketRow): number {
  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * Every ticket link and chain link that touches `ticket`, read into the shape the Links
 * section renders. `null` when there is nothing to show — the ticket has neither kind of
 * link — so the caller can skip the section entirely rather than render an empty one.
 */
export function linkedTicketRows(
  ticket: Pick<Task, 'id' | 'projectId'>,
  ticketLinks: readonly TicketLink[],
  tasksById: ReadonlyMap<string, Task>,
  chainLinks: readonly TaskLink[] = [],
): LinkedTicketsSection | null {
  const views = linksFor(ticketLinks, ticket.id);
  const touchingChain = chainLinks.filter(
    (link) => link.fromTaskId === ticket.id || link.toTaskId === ticket.id,
  );
  if (views.length === 0 && touchingChain.length === 0) return null;

  const rowsByPhrase = new Map<string, LinkedTicketRow[]>();
  for (const view of views) {
    const other = tasksById.get(view.otherTaskId);
    const missing = !other;
    const row: LinkedTicketRow = {
      linkId: view.link.id,
      otherTaskId: view.otherTaskId,
      key: missing ? view.otherTaskId : (other.ticketKey ?? other.id),
      title: missing ? null : other.title,
      issueType: missing ? null : (other.issueType ?? null),
      column: missing ? null : columnForTask(other),
      otherProject: missing ? false : other.projectId !== ticket.projectId,
      missing,
    };
    const rows = rowsByPhrase.get(view.phrase);
    if (rows) rows.push(row);
    else rowsByPhrase.set(view.phrase, [row]);
  }

  const groups: LinkedTicketGroup[] = [];
  for (const phrase of PHRASE_ORDER) {
    const rows = rowsByPhrase.get(phrase);
    if (rows && rows.length > 0) groups.push({ phrase, rows: [...rows].sort(compareKeys) });
  }

  let chain: ChainPointer | null = null;
  if (touchingChain.length > 0) {
    const runsAfter: string[] = [];
    const runsBefore: string[] = [];
    for (const link of touchingChain) {
      if (link.toTaskId === ticket.id) runsAfter.push(keyFor(link.fromTaskId, tasksById));
      if (link.fromTaskId === ticket.id) runsBefore.push(keyFor(link.toTaskId, tasksById));
    }
    chain = { runsAfter, runsBefore };
  }

  return { groups, chain };
}

/**
 * Why `ticketLink:add` refused to draw a link, in words — `null` when it did not, so a caller
 * can show a `MessageBar` on the refusal and nothing at all on the ok case. Pure wrapper
 * around `TICKET_LINK_REFUSAL_MESSAGE` so `TicketLinkAddRow` never has to read `result.reason`
 * itself.
 */
export function linkAddRefusal(result: TicketLinkResult): string | null {
  return result.status === 'refused' ? TICKET_LINK_REFUSAL_MESSAGE[result.reason] : null;
}
