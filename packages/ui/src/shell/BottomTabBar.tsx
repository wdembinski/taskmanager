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
 * - **The tile is a CSS grid, stacked, not a flex column.** Fluent's `Tab` root is
 *   `display: grid; gridAutoFlow: column` — icon in column 1, content in column 2, both on
 *   row 1 — so a `flexDirection: 'column'` override on it does nothing; the label used to sit
 *   **beside** the icon and clip against the tile edge instead of wrapping under it. The
 *   `tab` class instead sets `gridAutoFlow: 'row'` (icon row 1, label row 2) with
 *   `justifyItems`/`alignContent` centring both, and `minWidth: 0` (not a floor) so every
 *   tile keeps sharing the bar evenly regardless of label length — content never forces one
 *   wider than its neighbours. Every tab is still at least 44×44 px, the standard touch
 *   target floor — unlike `NavRail`'s 44px-square tiles (same floor, coincidentally the same
 *   number), this bar's tiles are as wide as `items.length` divides the bar evenly, so the
 *   floor here is on height alone.
 * - **One icon pill, fixed size, for every tab.** The `icon` class gives every tab a 56×30
 *   fully-rounded box, overriding Fluent's fixed 20×20 icon slot; `iconSelected` then only
 *   swaps `backgroundColor`/`color` on selection, never size, so selecting a tab repaints the
 *   pill instead of resizing the tile around it. The attention badge (e.g. the Inbox count)
 *   renders inside this icon slot too, absolutely positioned at the pill's corner — not inside
 *   the label — because the label's own width has to track the tile, not the badge.
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
 *   icon pill (fixed size — see above) recolours to `var(--tm-selected-tint)`/`var(--tm-brand)`
 *   on selection; the label recolours to the same brand token. Both are set from this
 *   component, in JS, via the `Tab` `icon` slot's `className` and a wrapper `span` around the
 *   label — not CSS selectors reaching into Fluent's internals — so there is exactly one place
 *   each colour is decided. Fluent's own `::after` selection underline is hidden outright: the
 *   pill is this bar's one selection cue, not a second indicator stacked under it. The weight
 *   swap (400→600) on the label is Fluent's own `selected`/`body1Strong` styling, left alone —
 *   the `content` slot class only sets size/wrapping, never `fontWeight`, so the bold copy
 *   Fluent reserves space for (`contentReservedSpace`, which merges this same class in) means
 *   bolding on selection never resizes the tile either.
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
   *  the module header. Fluent's `Tab` root is a CSS grid (icon column 1, content column 2,
   *  both row 1) — `flexDirection` has no effect on it, which is what let the label spill
   *  past the tile and clip. Grid overrides stack the icon over the label instead:
   *  `gridAutoFlow: 'row'` puts each slot on its own row, `justifyItems`/`alignContent`
   *  centre both within the tile. `minWidth: 0` (not a floor) lets all tiles share the bar
   *  equally regardless of label length — content never forces a tile wider. Side padding
   *  is narrowed to the smallest token so the label gets the tile's full width to wrap into. */
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: '44px',
    gridAutoFlow: 'row',
    justifyItems: 'center',
    alignContent: 'center',
    rowGap: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalXXS,
    paddingRight: tokens.spacingHorizontalXXS,
    // This bar draws its own selection cue (the icon pill, below) — Fluent's default
    // underline would be a second, redundant indicator.
    '::after': { display: 'none' },
  },
  /** The label slot, row 2 of the tile's grid — see `tab` above. Fluent merges
   *  `content.className` into `contentReservedSpace.className` too (the hidden bold copy
   *  used to measure the tab, so the selected weight swap never resizes the tile), so this
   *  class has to apply to both without setting `fontWeight` itself: Fluent's own `selected`
   *  styles already carry the 400→600 weight change, and reserving space for the bold copy
   *  keeps that swap from nudging tile width. */
  content: {
    gridColumnStart: 1,
    gridRowStart: 2,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  /** One pill geometry for every tab, selected or not — overrides the icon slot's fixed
   *  20×20 box so selecting a tab only repaints the pill (`iconSelected`, below) instead of
   *  resizing it, which would otherwise nudge every tile's width. */
  icon: {
    width: '56px',
    height: '30px',
    fontSize: '22px',
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'visible',
    position: 'relative',
  },
  /** The selected tab's icon pill — see the module header. Paint only: size and shape come
   *  from `icon` above, so selecting a tab never changes tile width. */
  iconSelected: {
    backgroundColor: 'var(--tm-selected-tint)',
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
  },
  labelSelected: {
    color: `var(--tm-brand, ${tokens.colorBrandForeground1})`,
  },
  /** The attention badge, positioned against the icon pill (`icon` is `position: relative`)
   *  instead of sitting inside the label — see the module header. Half out at the pill's
   *  top-right corner, as in the mockup's dot. */
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    transform: 'translate(50%, -50%)',
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
                children: (
                  <>
                    {item.icon}
                    {item.badge && <span className={styles.badge}>{item.badge}</span>}
                  </>
                ),
                className: mergeClasses(styles.icon, isSelected && styles.iconSelected),
              }}
              content={{ className: styles.content }}
              className={styles.tab}
            >
              <span className={isSelected ? styles.labelSelected : undefined}>{item.label}</span>
            </Tab>
          );
        })}
      </TabList>
    </div>
  );
}
