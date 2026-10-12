/**
 * The compact board's own column tabs (F3.5) — a horizontal switcher standing in for the
 * wide board's five side-by-side columns, since a single-column layout has nowhere to put
 * the rest of them. Each tab names its column and carries the same card count the wide
 * board's own column header shows (`columnSwitcherItems`).
 *
 * A Fluent `TabList`, the same choice `BottomTabBar` made and for the same reasons: roving
 * tabindex and the selected-tab `role`/`aria-selected` wiring come for free, rather than
 * being re-built on a row of `ToggleButton`s. Horizontal and scrollable — five columns'
 * worth of tabs do not reliably fit a narrow viewport — and every tab is at least 44px tall,
 * the same touch-target floor `BottomTabBar` holds itself to.
 *
 * Tap is the only gesture wired here; a swipe between columns is optional future work and
 * not this step's.
 */
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import type { BoardColumn } from '@tm/shared/model';
import type { ColumnSwitcherItem } from './compactColumns';

const useStyles = makeStyles({
  bar: {
    display: 'flex',
    flexShrink: 0,
    overflowX: 'auto',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tabs: {
    display: 'flex',
    flexWrap: 'nowrap',
  },
  tab: {
    flexShrink: 0,
    minWidth: '44px',
    minHeight: '44px',
  },
});

export interface ColumnSwitcherProps {
  items: readonly ColumnSwitcherItem[];
  /** `null` only when every column is hidden — then no tab can read as selected. */
  selected: BoardColumn | null;
  onSelect: (column: BoardColumn) => void;
}

export function ColumnSwitcher({ items, selected, onSelect }: ColumnSwitcherProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.bar}>
      <TabList
        className={styles.tabs}
        selectedValue={selected ?? undefined}
        onTabSelect={(_e, data) => onSelect(data.value as BoardColumn)}
      >
        {items.map((item) => (
          <Tab key={item.column} value={item.column} className={styles.tab}>
            {item.label} ({item.count})
          </Tab>
        ))}
      </TabList>
    </div>
  );
}
