/**
 * The mobile board's column picker: a horizontally scrollable row of chips, one per
 * column, each carrying the column's label and how many cards are in it — `KanbanColumn`'s
 * own header, turned into something a thumb can flick through instead of something a mouse
 * scrolls past sideways.
 *
 * A phone has no room for `KanbanColumn`'s side-by-side columns (`boardLayout.columns` is a
 * CSS grid of `minmax(0, 1fr)` tracks, which is exactly what does not fit a 360px screen), so
 * this replaces the whole row with a single-column-at-a-time view: pick a chip, see that
 * column's cards below it. The chips carry `COLUMN_META`'s own order and labels, so the same
 * five names read in the same order they do on the desktop and the web.
 */
import { Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { BoardColumn } from '@tm/shared/model';
import { COLUMN_META, type BoardCard } from '@tm/ui/board/boardColumns';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    gap: '8px',
    overflowX: 'auto',
    padding: '8px 12px',
    flexShrink: 0,
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    padding: '0 14px',
    minHeight: '36px',
    borderRadius: '999px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    font: 'inherit',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  // The whole `border`, not `borderColor`: Griffel rejects the four-sided shorthand mixed
  // with a longhand elsewhere in the same `makeStyles` call — see `TaskCard.tsx`'s own note.
  chipSelected: {
    backgroundColor: tokens.colorBrandBackground,
    border: `1px solid ${tokens.colorBrandBackground}`,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  count: { color: 'inherit', opacity: 0.75 },
});

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

export interface ColumnChipsProps {
  /** The columns to offer, in order — `visibleColumns(showDone)`'s own answer. */
  columns: readonly BoardColumn[];
  cardsByColumn: ReadonlyMap<BoardColumn, readonly BoardCard[]>;
  selected: BoardColumn;
  onSelect: (column: BoardColumn) => void;
}

export function ColumnChips({
  columns,
  cardsByColumn,
  selected,
  onSelect,
}: ColumnChipsProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.row} role="tablist" aria-label="Board column">
      {columns.map((column) => (
        <button
          key={column}
          type="button"
          role="tab"
          aria-selected={column === selected}
          className={mergeClasses(styles.chip, column === selected && styles.chipSelected)}
          onClick={() => onSelect(column)}
        >
          {COLUMN_LABEL[column]}
          <Caption1 className={styles.count}>{cardsByColumn.get(column)?.length ?? 0}</Caption1>
        </button>
      ))}
    </div>
  );
}
