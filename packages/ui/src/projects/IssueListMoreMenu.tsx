/**
 * The Issues list's permanent "…" (v9-1/v9-3): everything the list header used to draw as its
 * own strip above the Backlog — the Backlog / Timeline / Graph switch and the ticket-panel
 * toggle — plus, on the Backlog, its Group by modes and "Include archived". The header row
 * itself keeps only the project chip, "Issues", the Active / Backlog / All tabs, search, this
 * and "+".
 *
 * Shared by `BacklogTable`'s header and `Projects.tsx`'s slim Timeline/Graph row, so the view
 * switch reads the same from every view. `Projects` owns the view and the peek, and hands them
 * in as one {@link IssueViewMenu}; the Backlog adds its own groups beside it.
 *
 * Entries are `MenuItemRadio`/`MenuItemCheckbox`es under controlled `checkedValues`, each with
 * its own `onClick` — the tick is the caller's state, the same bargain `BoardMoreMenu` makes.
 * `open`/`inline` exist for the render test (no DOM testing library here to click "…").
 */
import {
  Menu,
  MenuButton,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { MoreHorizontalRegular } from '@fluentui/react-icons';
import type { BacklogGroupMode } from './backlogGrouping';

/** The views the "…" switches between — `'archived'` is reached from the sidebar alone. */
export type IssueListView = 'backlog' | 'timeline' | 'graph';

export const ISSUE_LIST_VIEW_LABEL: Record<IssueListView, string> = {
  backlog: 'Backlog',
  timeline: 'Timeline',
  graph: 'Graph',
};

/** The "Group by" modes, in menu order. */
export const GROUP_MODE_LABEL: Record<BacklogGroupMode, string> = {
  status: 'Status',
  epic: 'Epic',
  milestone: 'Milestone',
};

/** `Projects.tsx`'s contribution to the menu: which view is open, and the ticket panel. */
export interface IssueViewMenu {
  /** The open view — `'archived'` checks none of the three. */
  view: IssueListView | 'archived';
  onViewChange: (view: IssueListView) => void;
  /** The peek beside the list is open. */
  peekOpen: boolean;
  /** Nothing is selected, so there is nothing for a peek to show. */
  peekDisabled: boolean;
  /** Dispatches `space` — the same key the entry's title names. */
  onTogglePeek: () => void;
}

export interface IssueListMoreMenuProps {
  viewMenu?: IssueViewMenu;
  /** The Backlog's grouping — omitted on the views that do not group. */
  groupBy?: { mode: BacklogGroupMode; onChange: (mode: BacklogGroupMode) => void };
  /** The Backlog's "Include archived" — omitted where the view draws its own. */
  includeArchived?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Test only: render the menu open. */
  open?: boolean;
  /** Test only: render the popover in place rather than in a portal. */
  inline?: boolean;
}

export function IssueListMoreMenu({
  viewMenu,
  groupBy,
  includeArchived,
  open,
  inline,
}: IssueListMoreMenuProps): JSX.Element {
  const options = [
    ...(viewMenu?.peekOpen ? ['peek'] : []),
    ...(includeArchived?.checked ? ['archived'] : []),
  ];
  const hasOptions = viewMenu !== undefined || includeArchived !== undefined;
  return (
    <Menu
      open={open}
      inline={inline}
      checkedValues={{
        view: viewMenu && viewMenu.view !== 'archived' ? [viewMenu.view] : [],
        group: groupBy ? [groupBy.mode] : [],
        options,
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <MenuButton
          size="small"
          appearance="subtle"
          icon={<MoreHorizontalRegular />}
          title="More options"
          aria-label="More options"
          style={{ flexShrink: 0 }}
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {viewMenu && (
            <MenuGroup>
              <MenuGroupHeader>View</MenuGroupHeader>
              {(Object.keys(ISSUE_LIST_VIEW_LABEL) as IssueListView[]).map((v) => (
                <MenuItemRadio
                  key={v}
                  name="view"
                  value={v}
                  onClick={() => viewMenu.onViewChange(v)}
                  data-issue-menu={`view-${v}`}
                >
                  {ISSUE_LIST_VIEW_LABEL[v]}
                </MenuItemRadio>
              ))}
            </MenuGroup>
          )}
          {groupBy && (
            <>
              {viewMenu && <MenuDivider />}
              <MenuGroup>
                <MenuGroupHeader>Group by</MenuGroupHeader>
                {(Object.keys(GROUP_MODE_LABEL) as BacklogGroupMode[]).map((mode) => (
                  <MenuItemRadio
                    key={mode}
                    name="group"
                    value={mode}
                    onClick={() => {
                      if (mode !== groupBy.mode) groupBy.onChange(mode);
                    }}
                    data-issue-menu={`group-${mode}`}
                  >
                    {GROUP_MODE_LABEL[mode]}
                  </MenuItemRadio>
                ))}
              </MenuGroup>
            </>
          )}
          {hasOptions && (viewMenu || groupBy) && <MenuDivider />}
          {viewMenu && (
            <MenuItemCheckbox
              name="options"
              value="peek"
              title="Open the selected ticket beside the list (Space)"
              disabled={viewMenu.peekDisabled}
              onClick={viewMenu.onTogglePeek}
              data-issue-menu="peek"
            >
              Ticket panel
            </MenuItemCheckbox>
          )}
          {includeArchived && (
            <MenuItemCheckbox
              name="options"
              value="archived"
              onClick={() => includeArchived.onChange(!includeArchived.checked)}
              data-issue-menu="archived"
            >
              Include archived
            </MenuItemCheckbox>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
