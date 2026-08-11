/**
 * The app's vertical navigation rail — the desktop's, extracted so the browser draws the
 * same one rather than a lookalike.
 *
 * Extracted rather than copied for the reason `KanbanColumn` already proves: two copies of
 * a rail are two rails, and the second one stops matching on the first tweak. What is
 * *not* extracted is the `App` around it — the desktop's owns `TitleBar`, the banners, the
 * sync rings and every `window.api` call, none of which a browser has, and a shared `App`
 * would be fifteen optional props with fourteen absent on the web.
 */
import { Tab, TabList, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  /**
   * A vertical rail of icons rather than a row of tabs across the top: the tab strip
   * cost every screen a band of height at its most valuable point, and a handful of
   * destinations with familiar glyphs need no words. Each tab keeps its label as a
   * tooltip, which is also what a screen reader announces.
   */
  nav: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    // ~1.5× the width an icon-only tab takes on its own, so the rail is a deliberate
    // edge of the window rather than a thin strip of buttons.
    width: '84px',
    paddingTop: '8px',
    flexShrink: 0,
    // The same surface as the detail pane, so the window reads as content between two
    // lighter edges rather than as three unrelated panels.
    backgroundColor: tokens.colorNeutralBackground1,
    // Square TILES, not wide short buttons: at 84 wide and ~40 tall each tab was a
    // letterbox, and a rail of letterboxes reads as a toolbar rather than as the app's
    // primary navigation. Square is also what makes the glyph the whole target.
    '& button': {
      justifyContent: 'center',
      height: '84px',
      minWidth: '84px',
      borderRadius: tokens.borderRadiusMedium,
    },
    // Twice the 24px they started at. The tile grew with them, so the icon still sits in
    // the same share of its tab rather than crowding the edges.
    '& svg': { fontSize: '48px' },
  },
  /**
   * A destination this host cannot reach. Dimmed rather than removed: a rail with one tile
   * on it looks like a different application, and a tile that is present-but-off tells you
   * the app is the same one and that the rest of it lives elsewhere.
   */
  unavailable: { opacity: 0.4, cursor: 'default' },
});

export interface NavRailItem {
  id: string;
  /** The tooltip and the accessible name — the rail has no visible labels. */
  label: string;
  icon: JSX.Element;
  /**
   * Anything to draw inside the tile beside the glyph. The desktop puts its "waiting on
   * you" count here; it is the only label the rail ever shows.
   */
  badge?: ReactNode;
  /**
   * Why this destination is off, when it is — e.g. `'desktop only'`. Set means the tile is
   * drawn dimmed, refuses selection, and appends this to its tooltip, because a dead tile
   * with a reason is honest where a missing one is silent.
   */
  unavailable?: string;
}

export interface NavRailProps {
  items: readonly NavRailItem[];
  selected: string;
  onSelect: (id: string) => void;
}

export function NavRail({ items, selected, onSelect }: NavRailProps): JSX.Element {
  const styles = useStyles();
  return (
    <TabList
      vertical
      size="large"
      className={styles.nav}
      selectedValue={selected}
      onTabSelect={(_e, d) => {
        const id = String(d.value);
        // Refused here rather than with Fluent's own `disabled`, which renders a native
        // `<button disabled>` — and a disabled button fires no pointer events, so the
        // tooltip saying WHY it is off would never open. `aria-disabled` keeps the tile
        // focusable and hoverable and still announces the state.
        if (items.find((item) => item.id === id)?.unavailable) return;
        onSelect(id);
      }}
    >
      {items.map((item) => (
        <Tooltip
          key={item.id}
          content={item.unavailable ? `${item.label} — ${item.unavailable}` : item.label}
          relationship="label"
          positioning="after"
        >
          <Tab
            value={item.id}
            icon={item.icon}
            aria-disabled={item.unavailable ? true : undefined}
            className={item.unavailable ? styles.unavailable : undefined}
          >
            {item.badge}
          </Tab>
        </Tooltip>
      ))}
    </TabList>
  );
}
