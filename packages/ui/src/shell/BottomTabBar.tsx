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
 * - **No `unavailable` concept here**, unlike `NavRail`'s own `unavailable` map (F13.8) —
 *   every compact tab is always reachable; `CompactApp`'s four tabs never need a disabled
 *   fifth. This component also keeps its own `BottomTabBarItem` rather than `NavRail`'s
 *   `ShellNavEntry`: its `icon` is an element, not a `FluentIcon` component, and it has no
 *   `group` — a four-tab bar has nothing to group.
 * - **On glass (F13.17), edge-to-edge, with a gradient hairline standing in for the border.**
 *   `useGlassStyles().pane` supplies the fill (glass or opaque, per `GlassPane`'s own switch)
 *   with `borderRadius` forced back to `0` — every other pane is a floating rounded surface,
 *   this one is the bottom edge of the screen itself. The old flat `colorNeutralStroke2`
 *   `borderTop` is gone; in its place an `aria-hidden` span along the top edge paints
 *   `var(--tm-status-gradient)`, the same ink `StatusBar` uses, so the one line that used to
 *   be a plain rule now reads as part of the same system. `attention` swaps that gradient for
 *   `var(--tm-attention)`'s flat orange — `StatusBar`'s `footerAttention` pattern, reused
 *   rather than re-derived, including needing `backgroundImage: 'none'` so the gradient image
 *   doesn't paint over the flat fill. Under `forced-colors: active` the hairline falls back
 *   to a solid `CanvasText` line — `GlassPane` already draws a real border in that mode, so
 *   the bar keeps a visible top edge either way.
 * - **The selected tab reads as brand, not Fluent's default "selected" grey-on-white.** The
 *   icon gets a `var(--tm-selected-tint)` pill behind it and recolours to `var(--tm-brand)`;
 *   the label recolours to the same brand token. Both are set from this component, in JS, via
 *   the `Tab` `icon` slot's `className` and a wrapper `span` around the label — not CSS
 *   selectors reaching into Fluent's internals — so there is exactly one place each colour is
 *   decided. Fluent's own `::after` selection underline is hidden outright: the pill is this
 *   bar's one selection cue, not a second indicator stacked under it.
 */
import { Tab, TabList, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { useGlassStyles } from './GlassPane';

const useStyles = makeStyles({
  bar: {
    display: 'flex',
    flexShrink: 0,
    position: 'relative',
    // Edge-to-edge, not a floating pane — overrides `glass.pane`'s rounded corners.
    borderRadius: 0,
  },
  /** The gradient hairline standing in for the old flat `borderTop` — see the module
   *  header. Absolutely positioned so it doesn't take up a row in the bar's flex layout. */
  hairline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '2px',
    backgroundImage: 'var(--tm-status-gradient)',
    '@media (forced-colors: active)': {
      backgroundImage: 'none',
      backgroundColor: 'CanvasText',
    },
  },
  /** `StatusBar`'s `footerAttention` pattern: `backgroundImage: 'none'` matters here or the
   *  gradient image paints over the flat orange fill. */
  hairlineAttention: {
    backgroundImage: 'none',
    backgroundColor: 'var(--tm-attention)',
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
    // This bar draws its own selection cue (the icon pill, below) — Fluent's default
    // underline would be a second, redundant indicator.
    '::after': { display: 'none' },
  },
  /** The selected tab's icon pill — see the module header. Overrides the icon slot's own
   *  fixed 20×20 box (and its `overflow: hidden`) so the pill can be bigger than the glyph. */
  iconSelected: {
    width: 'auto',
    height: 'auto',
    overflow: 'visible',
    padding: '4px 16px',
    borderRadius: '14px',
    backgroundColor: 'var(--tm-selected-tint)',
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
  },
  labelSelected: {
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
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
  /** True while something is waiting on a human — the hairline swaps from the resting
   *  gradient to the flat orange, the same signal `StatusBar`'s fill carries. */
  attention?: boolean;
}

export function BottomTabBar({
  items,
  selected,
  onSelect,
  attention,
}: BottomTabBarProps): JSX.Element {
  const styles = useStyles();
  const glass = useGlassStyles();
  return (
    <div className={mergeClasses(glass.pane, styles.bar)}>
      <span
        aria-hidden="true"
        className={mergeClasses(styles.hairline, attention && styles.hairlineAttention)}
      />
      <TabList
        className={styles.tabs}
        selectedValue={selected}
        onTabSelect={(_e, d) => onSelect(String(d.value))}
      >
        {items.map((item) => {
          const isSelected = item.id === selected;
          return (
            <Tab
              key={item.id}
              value={item.id}
              icon={{
                children: item.icon,
                className: isSelected ? styles.iconSelected : undefined,
              }}
              className={styles.tab}
            >
              <span className={isSelected ? styles.labelSelected : undefined}>{item.label}</span>
              {item.badge}
            </Tab>
          );
        })}
      </TabList>
    </div>
  );
}
