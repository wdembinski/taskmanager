/**
 * The board card's header controls that are neither a filter nor a view toggle (v9-7/v9-7b):
 * the title picker — which board the card shows, set as the card's own title — and the
 * Board / List pill tabs beside it.
 *
 * Shared by both hosts (`MyTasks.tsx`'s header, the web's `BoardToolbar.tsx`) for the reason
 * `LinkModeSwitch` is: the desktop and the browser must agree on what the card's title says
 * and what the tabs look like, and a component built twice drifts the moment one host changes
 * a label. The styles are `boardLayout.ts`'s (`title`, `tabs`, `tab`, `tabSelected`).
 *
 * Both hosts wrap each of these in a pinned `OverflowItem`, which clones its child and attaches
 * a ref to measure it — so both are `forwardRef`'d to their root `<div>` (see
 * `ToolbarOverflow.tsx`'s own comment on the bug a dropped ref causes).
 */
import { forwardRef } from 'react';
import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  mergeClasses,
} from '@fluentui/react-components';
import { ChevronDownRegular } from '@fluentui/react-icons';
import type { BoardScope } from '@tm/shared/ipc';
import { pickableProjects } from '@tm/shared/trackerArchive';
import { useBoardLayoutStyles } from './boardLayout';

/** What the title says for `scope` — `'all'`, or a board that is no longer in `scopes`. */
export function boardScopeLabel(scope: string, scopes: readonly BoardScope[]): string {
  if (scope === 'all') return 'All boards';
  return scopes.find((s) => s.id === scope)?.name ?? 'All boards';
}

export interface BoardTitlePickerProps {
  /** `'all'`, or one board's own project id — `settings.boardScopeId`. */
  scope: string;
  /** The boards offered beyond "All boards" — `board:scopes`' own list. */
  scopes: BoardScope[];
  onScopeChange: (scope: string) => void;
}

/**
 * The card's title, which is also the board-scope picker: "All boards ▾", or one board's
 * name. It replaces the scope `Dropdown` that used to open the toolbar — the same options and
 * the same persisted setting, drawn as the heading the mockup puts there.
 */
export const BoardTitlePicker = forwardRef<HTMLDivElement, BoardTitlePickerProps>(
  function BoardTitlePicker({ scope, scopes, onScopeChange }, ref) {
    const layout = useBoardLayoutStyles();
    const label = boardScopeLabel(scope, scopes);
    return (
      <div ref={ref} className={layout.titleSlot} data-board-title="">
        <Menu
          checkedValues={{ scope: [scope] }}
          onCheckedValueChange={(_e, d) => {
            const next = d.checkedItems[0];
            if (next) onScopeChange(next);
          }}
        >
          <MenuTrigger disableButtonEnhancement>
            <button
              type="button"
              className={layout.title}
              title="Which board this shows"
              aria-label={`Board: ${label}`}
            >
              <span className={layout.titleText}>{label}</span>
              <span className={layout.titleChevron} aria-hidden="true">
                <ChevronDownRegular />
              </span>
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItemRadio name="scope" value="all">
                All boards
              </MenuItemRadio>
              {pickableProjects(scopes, scope === 'all' ? null : scope).map((s) => (
                <MenuItemRadio key={s.id} name="scope" value={s.id}>
                  {s.name}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
    );
  },
);

export interface BoardViewTabsProps {
  /** Leave the board for the issue list (the Tickets screen). Absent, List is disabled. */
  onOpenList?: () => void;
}

/**
 * Board (selected, since this IS the board) / List. List is the Tickets screen — the same
 * tickets as a list — so it navigates rather than switching a mode in place. No Timeline tab:
 * there is no timeline view of the board yet.
 */
export const BoardViewTabs = forwardRef<HTMLDivElement, BoardViewTabsProps>(function BoardViewTabs(
  { onOpenList },
  ref,
) {
  const layout = useBoardLayoutStyles();
  return (
    <div ref={ref} className={layout.tabs} role="tablist" aria-label="View">
      <button
        type="button"
        role="tab"
        aria-selected="true"
        className={mergeClasses(layout.tab, layout.tabSelected)}
      >
        Board
      </button>
      <button
        type="button"
        role="tab"
        aria-selected="false"
        className={layout.tab}
        disabled={!onOpenList}
        title="Show these tickets as a list"
        onClick={onOpenList}
      >
        List
      </button>
    </div>
  );
});
