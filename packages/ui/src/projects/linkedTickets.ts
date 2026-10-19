/**
 * The Links section's own view model — every order arrow and ticket link that touches one
 * ticket, grouped and sorted for display. Pure, no React, for the same reason
 * `@shared/ticketLinks` is: the phrasing a row shows has to be the one `linksFor()` already
 * settled on, not a second copy of the vocabulary that could drift from it.
 *
 * A dependency lives in the order arrows alone. "Blocked by" / "Blocks" are read off them
 * through `dependencyLists` — the same list the engine and the board's chips read — so the
 * panel can never claim nothing holds a card the engine is holding. A `blocks` ticket link
 * left over from before the migration is NOT listed: it decides nothing, and showing it next
 * to the arrows would be a second answer to the same question.
 */
import { columnForTask } from '@tm/shared/board';
import type { BoardColumn, IssueType, Task, TicketLink } from '@tm/shared/model';
import {
  linksFor,
  TICKET_LINK_REFUSAL_MESSAGE,
  TICKET_LINK_VOCABULARY,
  type TicketLinkResult,
} from '@tm/shared/ticketLinks';
import {
  dependencyLists,
  LINK_REFUSAL_MESSAGE,
  type DependencyRow,
  type LinkResult,
  type TaskLink,
} from '@tm/shared/taskChain';

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

export interface LinkedTicketsSection {
  /** Every arrow INTO the card — what it waits for. */
  blockedBy: DependencyRow[];
  /** Every arrow OUT of the card — what waits for it. */
  blocks: DependencyRow[];
  /** The ticket links, every type except `blocks`. */
  groups: LinkedTicketGroup[];
}

/** Every phrase a row can show, in the order its group should appear. */
const PHRASE_ORDER: readonly string[] = Object.values(TICKET_LINK_VOCABULARY).flatMap((entry) =>
  entry.symmetric ? [entry.outward] : [entry.outward, entry.inward],
);

function compareKeys(a: LinkedTicketRow, b: LinkedTicketRow): number {
  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * Every order arrow and non-`blocks` ticket link that touches `ticket`, read into the shape
 * the Links section renders. `null` when there is nothing to show — no arrow either way and
 * no ticket link — so the caller can swap in an empty state rather than render empty groups.
 */
export function linkedTicketRows(
  ticket: Pick<Task, 'id' | 'projectId'>,
  ticketLinks: readonly TicketLink[],
  tasksById: ReadonlyMap<string, Task>,
  chainLinks: readonly TaskLink[] = [],
): LinkedTicketsSection | null {
  const { blockedBy, blocks } = dependencyLists(ticket, chainLinks, tasksById);
  const views = linksFor(
    ticketLinks.filter((link) => link.type !== 'blocks'),
    ticket.id,
  );
  if (views.length === 0 && blockedBy.length === 0 && blocks.length === 0) return null;

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

  return { blockedBy, blocks, groups };
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

/** {@link linkAddRefusal} for `chain:link` — an arrow drawn from the add row. */
export function arrowAddRefusal(result: LinkResult): string | null {
  return result.status === 'refused' ? LINK_REFUSAL_MESSAGE[result.reason] : null;
}
