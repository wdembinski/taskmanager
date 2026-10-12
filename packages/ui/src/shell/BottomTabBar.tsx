/**
 * The compact shell's primary navigation (F3.2): a bottom tab bar, the phone pattern — as
 * opposed to `NavRail`'s icon-only side rail, which has no room on a narrow viewport and
 * assumes a mouse to hover a tooltip.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **A Fluent `TabList`, horizontal, not `NavRail`'s vertical one.** Reusing `TabList`
 *   rather than four plain buttons keeps roving-tabindex keyboard nav and the selected-tab
 *   `role`/`aria-selected` wiring that Fluent already gets right — see the next point.
 * - **Labels are always visible, under the icon.** `NavRail` can get away with icon-only
 *   plus a `Tooltip` because it assumes a mouse to hover one; a bottom tab bar on a touch
 *   device cannot, so there is **no `Tooltip` anywhere in this component** — a label a sighted
 *   user can only discover by holding a tap is tooltip-only information, which the brief
 *   rules out.
 * - **Every tab is at least 44×44 px**, the standard touch target floor — unlike `NavRail`'s
 *   44px-square tiles (same floor, coincidentally the same number), this bar's tiles are as
 *   wide as `items.length` divides the bar evenly, so the floor is on height alone plus a
 *   `minWidth`.
 * - **`role`/accessible selection state come from `TabList` itself** — no bespoke
 *   `aria-current` or `role="tab"` written by hand, the same reason `NavRail` doesn't either.
 * - **No `unavailable` concept here**, unlike `NavRailItem` — every compact tab is always
 *   reachable; `CompactApp`'s four tabs never need a disabled fifth.
 */
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  bar: {
    display: 'flex',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tabs: { display: 'flex', width: '100%' },
  /** As wide as the tab count divides the bar evenly; the floor is on height alone — see
   *  the module header. */
  tab: {
    flex: 1,
    minWidth: '44px',
    minHeight: '44px',
    flexDirection: 'column',
    gap: '2px',
  },
});

export interface BottomTabBarItem {
  id: string;
  /** Always visible, under the icon — see the module header. Doubles as the tab's
   *  accessible name. */
  label: string;
  icon: JSX.Element;
  /** The one thing the desktop rail also shows inline — e.g. the Inbox tab's attention
   *  count, drawn as a `CounterBadge`. */
  badge?: ReactNode;
}

export interface BottomTabBarProps {
  items: readonly BottomTabBarItem[];
  selected: string;
  onSelect: (id: string) => void;
}

export function BottomTabBar({ items, selected, onSelect }: BottomTabBarProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.bar}>
      <TabList
        className={styles.tabs}
        selectedValue={selected}
        onTabSelect={(_e, d) => onSelect(String(d.value))}
      >
        {items.map((item) => (
          <Tab key={item.id} value={item.id} icon={item.icon} className={styles.tab}>
            {item.label}
            {item.badge}
          </Tab>
        ))}
      </TabList>
    </div>
  );
}
