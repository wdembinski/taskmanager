/**
 * The compact one-column board's own small selectors (F3.5) — what the column switcher
 * offers, and which column it should be showing right now.
 *
 * Pure, so a test can build a `cardsByColumn` map and a route by hand rather than mounting
 * the compact shell.
 */
import type { BoardColumn } from '@tm/shared/model';
import type { CompactRoute } from '../layout/compactRoute';
import { COLUMN_META, type BoardCard } from './boardColumns';

/** One entry in the compact board's column switcher. */
export interface ColumnSwitcherItem {
  column: BoardColumn;
  label: string;
  count: number;
}

/**
 * The switcher's entries, one per visible column, in `COLUMN_META`'s left-to-right order.
 * `count` is the same number the wide board's column header shows — the column's own card
 * count, not its steps (`groupSubtasks` already folded those into their parent card).
 */
export function columnSwitcherItems(
  cardsByColumn: ReadonlyMap<BoardColumn, readonly BoardCard[]>,
  hidden: readonly BoardColumn[],
): ColumnSwitcherItem[] {
  const hiddenSet = new Set(hidden);
  return COLUMN_META.filter((meta) => !hiddenSet.has(meta.column)).map((meta) => ({
    column: meta.column,
    label: meta.label,
    count: cardsByColumn.get(meta.column)?.length ?? 0,
  }));
}

/**
 * Which column the compact board should show, given the current route.
 *
 * - a `{kind:'board'}` route's own column wins, as long as it is still visible — a column
 *   hidden after the route was set (or carried in from a stale hash) falls through instead;
 * - a `{kind:'card'}` route shows the card's own column, so opening a card never silently
 *   switches the tab underneath it;
 * - anything else — an unknown hidden column, a route with no column of its own — falls
 *   back to the first visible column;
 * - `null` when there is no visible column left to fall back to, which only happens when
 *   every column is hidden.
 *
 * Never rewrites `location.hash` itself — same rule `useHashRoute` applies to an unknown
 * hash — so a column that comes back visible later finds the route untouched.
 */
export function activeCompactColumn(
  route: CompactRoute,
  visible: readonly BoardColumn[],
  cardColumn?: BoardColumn,
): BoardColumn | null {
  if (route.kind === 'board' && visible.includes(route.column)) return route.column;
  if (route.kind === 'card' && cardColumn !== undefined) return cardColumn;
  return visible[0] ?? null;
}
