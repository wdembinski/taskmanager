/**
 * Board column view helpers for the My Tasks Kanban. The pure status↔column↔category
 * mapping lives in `@shared/board` (shared with the main process); this module adds
 * the renderer-only concerns: display metadata and the "Show Done" toggle.
 */
import type { BoardColumn } from '@shared/model';

export type { BoardColumn } from '@shared/model';
export {
  categoryFromKey,
  categoryToColumn,
  columnForStatus,
  columnForTask,
  statusForColumn,
} from '@shared/board';

/** Display metadata for each column, in left-to-right board order. */
export const COLUMN_META: ReadonlyArray<{ column: BoardColumn; label: string; order: number }> = [
  { column: 'todo', label: 'TO DO', order: 0 },
  { column: 'in-progress', label: 'IN PROGRESS', order: 1 },
  { column: 'blocked', label: 'BLOCKED', order: 2 },
  { column: 'done', label: 'DONE', order: 3 },
];

/** The columns to render, honoring the "Show Done" toggle. */
export function visibleColumns(showDone: boolean): BoardColumn[] {
  return COLUMN_META.filter((c) => showDone || c.column !== 'done').map((c) => c.column);
}
