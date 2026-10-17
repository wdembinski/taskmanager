/**
 * The backlog's own grouping for `BacklogTable`'s `IssueRow` list — by STATUS, not epic (see
 * `backlogView.ts`, which this still leans on for `filterTickets`/`sortBacklog`). Kept pure
 * and apart from the table so the group order and the epic carve-out can be tested without a
 * DOM.
 */
import type { BoardColumn, Task } from '@tm/shared/model';
import { columnForTask } from '@tm/shared/board';
import { isEpic } from '@tm/shared/tickets';
import type { ArchiveIndex } from '@tm/shared/trackerArchive';
import { columnBadge } from '../taskStatus';
import {
  archiveVisibleTickets,
  type BacklogSortKey,
  filterTickets,
  sortBacklog,
} from './backlogView';

export interface BacklogStatusGroup {
  column: BoardColumn;
  /** The column's own badge label (`columnBadge`) — "In Progress", not the raw column id,
   *  so a group header reads exactly like the status a row's own glyph stands for. */
  label: string;
  tickets: Task[];
}

/** The order a backlog reads top to bottom — what's moving first, what's settled last. */
const STATUS_ORDER: readonly BoardColumn[] = [
  'in-progress',
  'in-review',
  'blocked',
  'todo',
  'done',
];

/**
 * `tickets`, with archived rows dropped (`archiveVisibleTickets`, F14.6) exactly as
 * `backlogRows` does, filtered (`filterTickets`) and sorted (`sortBacklog`) exactly as the
 * epic-grouped view is, then bucketed by the column each is in (`columnForTask`) instead of
 * by epic. An epic is never one of the rows here — dropped (`isEpic`) rather than grouped,
 * since this view has no header for it to sit under. A column with nothing in it is omitted
 * rather than rendered empty: every non-epic ticket appears in exactly one group's `tickets`,
 * always.
 */
export function backlogStatusGroups(
  tickets: readonly Task[],
  query: string,
  sortKey: BacklogSortKey,
  archive?: { index: ArchiveIndex; includeArchived?: boolean },
): BacklogStatusGroup[] {
  const sorted = sortBacklog(
    filterTickets(archiveVisibleTickets(tickets, archive), query),
    sortKey,
  ).filter((ticket) => !isEpic(ticket));

  const buckets = new Map<BoardColumn, Task[]>();
  for (const ticket of sorted) {
    const column = columnForTask(ticket);
    const bucket = buckets.get(column);
    if (bucket) bucket.push(ticket);
    else buckets.set(column, [ticket]);
  }

  return STATUS_ORDER.filter((column) => buckets.has(column)).map((column) => ({
    column,
    label: columnBadge(column).label,
    tickets: buckets.get(column)!,
  }));
}
