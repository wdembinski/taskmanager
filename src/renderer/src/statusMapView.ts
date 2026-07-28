/**
 * statusMapView — the rows behind Settings' "how your statuses land" table.
 *
 * The surface that would have made the IN REVIEW bug obvious. That bug was not a wrong
 * rule, it was an INVISIBLE one: the sync resolved a status by its JIRA category while
 * the drag resolved it by name, and nothing in the app ever said which had decided. So
 * this table's real content is the `reason` column.
 *
 * It calls the same `resolveStatusColumn` the engine calls, deliberately — a viewer with
 * its own copy of the rules is a viewer that can lie, which is the failure we are fixing.
 * Pure, so the ordering and grouping are testable without a DOM.
 */
import type { BoardColumn } from '@shared/model';
import type { JiraStatusOption } from '@shared/ipc';
import { resolveStatusColumn, type StatusReason } from '@shared/statusResolve';
import { visibleColumns } from './board/boardColumns';

export interface StatusMapViewRow {
  name: string;
  category: JiraStatusOption['category'];
  column: BoardColumn;
  reason: StatusReason;
}

/**
 * Group order: the board's own left-to-right column order, so the table reads like the
 * board rather than like the alphabet. `visibleColumns(true)` includes Done, which is a
 * column a status can absolutely resolve to even when the board hides it.
 */
const COLUMN_ORDER: readonly BoardColumn[] = visibleColumns(true);

function columnRank(column: BoardColumn): number {
  const at = COLUMN_ORDER.indexOf(column);
  return at === -1 ? COLUMN_ORDER.length : at;
}

/**
 * One row per status the instance reports, resolved and explained.
 *
 * Sorted by resolved column (board order) then name, so every status that lands in a
 * given column sits together — which is how you spot the one that shouldn't.
 */
export function buildStatusMapRows(
  statuses: readonly JiraStatusOption[],
  map?: Record<string, BoardColumn>,
  learned?: Record<string, BoardColumn>,
): StatusMapViewRow[] {
  return statuses
    .map(({ name, category }) => {
      const { column, reason } = resolveStatusColumn(name, category, map, learned);
      return { name, category, column, reason };
    })
    .sort(
      (a, b) => columnRank(a.column) - columnRank(b.column) || a.name.localeCompare(b.name),
    );
}

/** The badge text for a row's tier. Sentence-shaped, because it answers "why?". */
export function reasonLabel(reason: StatusReason): string {
  switch (reason) {
    case 'explicit':
      return 'Mapped by you';
    case 'learned':
      return 'Learned from a move';
    case 'heuristic':
      return 'Name says review';
    case 'category':
      return 'JIRA category';
  }
}
