/**
 * The board header's permanent "…" (v9-7/v9-7b): every board control that is not the title,
 * the Board/List tabs, the `Links:` pill or "+". The header used to draw each one in the row —
 * the Show Done switch, Current sprint, the Chain toggle, the commit graph and detail pane
 * buttons, Removed cards and Sync — and only folded them into a "···" menu when the row ran
 * out of width. Now they always live here, so the header reads as the mockup does at any width.
 *
 * Shared by both hosts (`MyTasks.tsx`, the web's `BoardToolbar.tsx`) so the two menus cannot
 * drift: the entries, their order and their words are {@link boardMoreMenuEntries}'s, and the
 * hosts only pass state and handlers in.
 *
 * Checkable entries are `MenuItemCheckbox`es under controlled `checkedValues`: the tick is the
 * host's state, and a click only calls the entry's handler — the host flips its state and the
 * tick follows.
 *
 * `open`/`inline` exist for the render test, as `LinkModeSwitch`'s do: no DOM testing library
 * here to click "…", so the test renders the menu open in place and calls each entry's
 * `onSelect` from {@link boardMoreMenuEntries} directly.
 */
import type { ReactElement } from 'react';
import {
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
} from '@fluentui/react-components';
import {
  ArchiveRegular,
  ArrowRoutingRegular,
  ArrowSyncRegular,
  BranchForkRegular,
  CalendarRegular,
  CheckmarkCircleRegular,
  MoreHorizontalRegular,
  PanelRightRegular,
} from '@fluentui/react-icons';

export interface BoardMoreMenuProps {
  /** `doneSwitchLabel(...)` — `Show Done (N)` while the column is shut and holds cards. */
  doneLabel: string;
  /** `doneSwitchTitle(...)` — what the count is counting, or null when there is no count. */
  doneTitle?: string | null;
  doneChecked: boolean;
  onToggleDone: () => void;
  /** Current sprint — only where a tracker with sprints is connected. */
  sprint?: { checked: boolean; disabled?: boolean; onToggle: () => void };
  chainFocus: boolean;
  /** Nothing is selected, so there is no chain to focus on. */
  chainFocusDisabled: boolean;
  onToggleChainFocus: () => void;
  showGraph: boolean;
  onToggleGraph: () => void;
  showDetail: boolean;
  onToggleDetail: () => void;
  /** Cards that have left the board. The entry is only offered when there are some. */
  archivedCount: number;
  onOpenArchived: () => void;
  /** Sync the trackers now — only where one is connected. */
  sync?: { syncing: boolean; onSync: () => void };
  /** Test only: render the menu open. */
  open?: boolean;
  /** Test only: render the popover in place rather than in a portal. */
  inline?: boolean;
}

/** One line of the menu, before it is drawn. */
export interface BoardMoreMenuEntry {
  id: 'done' | 'sprint' | 'chain' | 'graph' | 'detail' | 'archived' | 'sync';
  label: string;
  title?: string;
  icon: ReactElement;
  /** Set for a checkable entry: whether it is ticked. Absent for a plain action. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** The entries, in menu order. A divider separates the view toggles from the actions. */
export function boardMoreMenuEntries(p: BoardMoreMenuProps): BoardMoreMenuEntry[] {
  const entries: BoardMoreMenuEntry[] = [
    {
      id: 'done',
      label: p.doneLabel,
      title: p.doneTitle ?? undefined,
      icon: <CheckmarkCircleRegular />,
      checked: p.doneChecked,
      onSelect: p.onToggleDone,
    },
  ];
  if (p.sprint) {
    entries.push({
      id: 'sprint',
      label: 'Current sprint',
      icon: <CalendarRegular />,
      checked: p.sprint.checked,
      disabled: p.sprint.disabled,
      onSelect: p.sprint.onToggle,
    });
  }
  entries.push(
    {
      id: 'chain',
      label: 'Focus this card’s chain',
      title: p.chainFocusDisabled
        ? 'Pick a card first — focus follows the selected card’s chain'
        : 'Show only this card’s chain: what it waits for, and what waits on it',
      icon: <ArrowRoutingRegular />,
      checked: p.chainFocus,
      disabled: p.chainFocusDisabled,
      onSelect: p.onToggleChainFocus,
    },
    {
      id: 'graph',
      label: 'Commit graph',
      title: 'The repository’s commit graph, beside the board',
      icon: <BranchForkRegular />,
      checked: p.showGraph,
      onSelect: p.onToggleGraph,
    },
    {
      id: 'detail',
      label: 'Detail pane',
      icon: <PanelRightRegular />,
      checked: p.showDetail,
      onSelect: p.onToggleDetail,
    },
  );
  if (p.archivedCount > 0) {
    entries.push({
      id: 'archived',
      label: `Removed cards (${p.archivedCount})`,
      icon: <ArchiveRegular />,
      onSelect: p.onOpenArchived,
    });
  }
  if (p.sync) {
    entries.push({
      id: 'sync',
      label: p.sync.syncing ? 'Syncing…' : 'Sync now',
      icon: p.sync.syncing ? <Spinner size="extra-tiny" /> : <ArrowSyncRegular />,
      disabled: p.sync.syncing,
      onSelect: p.sync.onSync,
    });
  }
  return entries;
}

export function BoardMoreMenu(props: BoardMoreMenuProps): JSX.Element {
  const entries = boardMoreMenuEntries(props);
  const toggles = entries.filter((e) => e.checked !== undefined);
  const actions = entries.filter((e) => e.checked === undefined);
  return (
    <Menu
      open={props.open}
      inline={props.inline}
      checkedValues={{ board: toggles.filter((e) => e.checked).map((e) => e.id) }}
    >
      <MenuTrigger disableButtonEnhancement>
        <MenuButton
          size="small"
          appearance="subtle"
          icon={<MoreHorizontalRegular />}
          title="More board options"
          aria-label="More board options"
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {toggles.map((e) => (
            <MenuItemCheckbox
              key={e.id}
              name="board"
              value={e.id}
              icon={e.icon}
              title={e.title}
              disabled={e.disabled}
              onClick={e.onSelect}
              data-board-menu={e.id}
            >
              {e.label}
            </MenuItemCheckbox>
          ))}
          {actions.length > 0 && <MenuDivider />}
          {actions.map((e) => (
            <MenuItem
              key={e.id}
              icon={e.icon}
              title={e.title}
              disabled={e.disabled}
              onClick={e.onSelect}
              data-board-menu={e.id}
            >
              {e.label}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
