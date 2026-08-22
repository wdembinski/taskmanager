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
import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Tab,
  TabList,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PersonRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  /**
   * The rail's own frame: the tab list above, the Account tile pinned below it. Split from
   * the tile styling (`tabs`) because that block has to reach the Account button too — the
   * dropdown trigger is one more tile on the same rail, not a different control glued to it.
   */
  rail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    // Narrower still than the 56px this rail used to be — a slim icon-only rail closer to
    // an editor's activity bar, so it reads as a strip of destinations rather than a panel.
    width: '44px',
    paddingTop: '8px',
    flexShrink: 0,
    // The same surface as the detail pane, so the window reads as content between two
    // lighter edges rather than as three unrelated panels.
    backgroundColor: tokens.colorNeutralBackground1,
    // Square TILES, not wide short buttons: a rail of letterboxes reads as a toolbar rather
    // than as the app's primary navigation. Square is also what makes the glyph the whole
    // target. Scaled down with the rail itself so a tile still fills its share of it.
    '& button': {
      justifyContent: 'center',
      height: '44px',
      minWidth: '44px',
      borderRadius: tokens.borderRadiusMedium,
    },
    '& svg': { fontSize: '22px' },
  },
  /** The destination tabs, growing to fill the rail so the Account tile sits at its foot. */
  tabs: { flex: 1 },
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

/** One position in the Account dropdown pinned to the rail's foot — sign out today. */
export interface NavRailAccountItem {
  id: string;
  label: string;
  onClick: () => void;
}

export interface NavRailProps {
  items: readonly NavRailItem[];
  selected: string;
  onSelect: (id: string) => void;
  /**
   * The account-level actions no destination owns. Rendered as an Account tile pinned to
   * the bottom of the rail, opening a dropdown on click. Omitted (the desktop's case today)
   * where the host has no account to act on, so the tile itself disappears rather than
   * opening onto an empty list.
   */
  accountItems?: readonly NavRailAccountItem[];
}

export function NavRail({ items, selected, onSelect, accountItems }: NavRailProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.rail}>
      <TabList
        vertical
        size="large"
        className={styles.tabs}
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

      {accountItems && accountItems.length > 0 && (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              icon={<PersonRegular />}
              aria-label="Account"
              title="Account"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {accountItems.map((item) => (
                <MenuItem key={item.id} onClick={item.onClick}>
                  {item.label}
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
    </div>
  );
}
