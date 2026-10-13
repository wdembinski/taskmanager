/**
 * Pure drop-target selection for moving a card between board columns — the one rule the
 * wide board's drag-and-drop and the compact board's "Move to" action sheet (F3.6) both
 * read, so a column a drag refuses can never be one the sheet offers instead.
 */
import type { BoardColumn, Task } from '@tm/shared/model';
import { columnForTask } from '@tm/shared/board';
import { COLUMN_META, visibleColumns } from './boardColumns';

/**
 * The columns a card may be dropped into right now.
 *
 * Deliberately takes no run/status/chain input. A card's column is the human's to move,
 * whatever an agent happens to be doing to it — `restingStatus`/`columnForTask` already
 * keep a running card sitting where its human left it, and a drop target computed from the
 * run would be the board moving a card no human asked it to. The only thing narrower than
 * "every visible column" is `pending`: one edit in flight at a time per card, same as the
 * existing drag guard.
 */
export function allowedDropColumns(opts: {
  hiddenColumns: readonly BoardColumn[];
  pending: boolean;
}): BoardColumn[] {
  if (opts.pending) return [];
  return visibleColumns(opts.hiddenColumns);
}

/** One column choice in the compact board's "Move to" sheet. */
export interface MoveSheetOption {
  column: BoardColumn;
  label: string;
  enabled: boolean;
  /**
   * A marker only — the current column stays `enabled`, since dropping a card on the
   * column it is already in is accepted as a no-op by the wide board's `resolveMove` too.
   */
  current: boolean;
}

/** The compact board's "Move to" sheet: one row per visible column, in board order. */
export function moveSheetOptions(
  task: Task,
  opts: { hiddenColumns: readonly BoardColumn[]; pending: boolean },
): MoveSheetOption[] {
  const labels = new Map(COLUMN_META.map((c) => [c.column, c.label]));
  const allowed = new Set(allowedDropColumns(opts));
  const current = columnForTask(task);
  return visibleColumns(opts.hiddenColumns).map((column) => ({
    column,
    label: labels.get(column) ?? column,
    enabled: allowed.has(column),
    current: current === column,
  }));
}
