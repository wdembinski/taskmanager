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
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { PersonRegular } from '@fluentui/react-icons';
import { Fragment, type ReactNode } from 'react';
import type { ShellNavEntry, ShellNavId } from './shellNav';

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
    // Transparent, per F13's design doc: the canvas shows through the rail, with no pane of
    // its own (the mockup draws the activity bar sitting directly on the canvas, same as the
    // sidebar it stands beside).
    backgroundColor: 'transparent',
    // Square TILES, not wide short buttons: a rail of letterboxes reads as a toolbar rather
    // than as the app's primary navigation. Square is also what makes the glyph the whole
    // target. Scaled down with the rail itself so a tile still fills its share of it.
    '& button': {
      justifyContent: 'center',
      height: '44px',
      minWidth: '44px',
      borderRadius: tokens.borderRadiusMedium,
    },
    // 20px Regular glyphs in the muted text tone — F13's token for an icon that is not the
    // selected one; `selectedTab` below recolours the selected tile's own glyph to `brand`.
    '& svg': { fontSize: '20px', color: 'var(--tm-text-muted)' },
  },
  /** The destination tabs, growing to fill the rail so the Account tile sits at its foot. */
  tabs: { flex: 1, display: 'flex', flexDirection: 'column' },
  /** The spacer between the bar group and the foot group (Settings), pushing Settings to the
   *  rail's bottom the same way `tabs` pushes the whole list above the Account tile — F13.11
   *  deleted the `interim` group this used to sit below instead of above. */
  spacer: { flex: 1 },
  /**
   * The selected tile: `selectedTint` fill and a `brand` glyph — the glyph recolour has to
   * win over the plain `svg` rule above, so it is declared after it in the same object. The
   * third piece, Fluent's own selected-tab indicator, needs no rule here: `Tab` paints it from
   * `colorCompoundBrandStroke`, which `theme.ts` pins to `SEMANTIC[scheme].brand` on both
   * themes precisely so it never has to be chased down and overridden from outside.
   */
  selectedTab: {
    backgroundColor: 'var(--tm-selected-tint)',
    '& svg': { color: 'var(--tm-brand)' },
  },
  /**
   * A destination this host cannot reach. Dimmed rather than removed: a rail with one tile
   * on it looks like a different application, and a tile that is present-but-off tells you
   * the app is the same one and that the rest of it lives elsewhere.
   */
  unavailable: { opacity: 0.4, cursor: 'default' },
  /** The palette hint's label is a shortcut ("Ctrl K", "⌘K"), not a glyph — too wide for the
   *  rail's 44px tile at the `button`/`svg` sizing above, so it gets its own small, tight
   *  text instead of inheriting either. */
  paletteHint: {
    fontSize: '11px',
    lineHeight: '13px',
    whiteSpace: 'normal',
    color: tokens.colorNeutralForeground3,
  },
});

/** One position in the Account dropdown pinned to the rail's foot — sign out today. */
export interface NavRailAccountItem {
  id: string;
  label: string;
  onClick: () => void;
}

export interface NavRailProps {
  /** The shell's one navigation list (F13.8) — every host passes `SHELL_NAV`. */
  items: readonly ShellNavEntry[];
  selected: string;
  onSelect: (id: string) => void;
  /**
   * Why a destination is off on this host, keyed by id — e.g. `{ scratch: 'web only' }`. An
   * entry here means its tile is drawn dimmed, refuses selection, and appends the reason to
   * its tooltip, because a dead tile with a reason is honest where a missing one is silent.
   */
  unavailable?: Partial<Record<ShellNavId, string>>;
  /** Anything to draw inside a tile beside its glyph, keyed by id — the only label the rail
   *  ever shows (a host's "waiting on you" or unread count), built fresh per render since it
   *  moves. */
  badges?: Partial<Record<ShellNavId, ReactNode>>;
  /**
   * The account-level actions no destination owns. Rendered as an Account tile pinned to
   * the bottom of the rail, opening a dropdown on click. Omitted (the desktop's case today)
   * where the host has no account to act on, so the tile itself disappears rather than
   * opening onto an empty list.
   */
  accountItems?: readonly NavRailAccountItem[];
  /**
   * The command palette's opener (F9.6), rendered as a tile pinned to the rail's foot below
   * the destinations — above the Account tile, since both hosts that have one mount it.
   * Omitted where no host has yet wired the palette into this rail.
   */
  paletteHint?: NavRailPaletteHint;
}

/** A click opens the palette; `label` is the platform-aware shortcut text (`shortcutLabel`'s
 *  output) the tile shows and the tooltip/accessible name is built from. */
export interface NavRailPaletteHint {
  label: string;
  onClick: () => void;
}

export function NavRail({
  items,
  selected,
  onSelect,
  unavailable,
  badges,
  accountItems,
  paletteHint,
}: NavRailProps): JSX.Element {
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
          if (unavailable?.[id as ShellNavId]) return;
          onSelect(id);
        }}
      >
        {items.map((item, index) => {
          const reason = unavailable?.[item.id];
          const Icon = item.icon;
          // The flexible gap that pushes the foot group (Settings) to the rail's bottom —
          // drawn right before the first item of that group, so a rail with no foot group at
          // all (none today) leaves no spacer behind either.
          const precededBySpacer =
            index > 0 && item.group !== items[index - 1].group && item.group === 'foot';
          return (
            <Fragment key={item.id}>
              {precededBySpacer && <div className={styles.spacer} />}
              <Tooltip
                content={reason ? `${item.label} — ${reason}` : item.label}
                relationship="label"
                positioning="after"
              >
                <Tab
                  value={item.id}
                  icon={<Icon />}
                  aria-disabled={reason ? true : undefined}
                  className={mergeClasses(
                    selected === item.id && styles.selectedTab,
                    reason && styles.unavailable,
                  )}
                >
                  {badges?.[item.id]}
                </Tab>
              </Tooltip>
            </Fragment>
          );
        })}
      </TabList>

      {paletteHint && (
        <Tooltip
          content={`Open command palette (${paletteHint.label})`}
          relationship="label"
          positioning="after"
        >
          <Button
            appearance="subtle"
            className={styles.paletteHint}
            aria-label={`Open command palette (${paletteHint.label})`}
            onClick={paletteHint.onClick}
          >
            {paletteHint.label}
          </Button>
        </Tooltip>
      )}

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
