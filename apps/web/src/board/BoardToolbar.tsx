/**
 * The web board's toolbar — the desktop's, and now with the same controls on it.
 *
 * It used to be the desktop's toolbar minus four things, each dropped because the action
 * behind it did not exist in a browser: the Current-sprint switch (it re-runs the JQL, and
 * only the desktop talks to JIRA), the Chain toggle (no links were mirrored, so it could
 * only ever blank the board), Sync (the desktop's own poll was the only thing that refreshed
 * anything) and the commit graph (a `git log` on a machine this app could not reach).
 *
 * All four have a relayable channel behind them now — `settings:save`, `chain:links`,
 * `jira:sync`, `git:graph` — so all four are here, the commit graph included. It is the
 * desktop's repository being read either way: the browser asks for `git:graph` over the
 * relay and draws what comes back in the desktop's own pane (`@tm/ui/GitGraphPane`). It is
 * off by default and shares the desktop's `showGitGraph` setting, so opening it here opens
 * it there — the same bargain the Done column and the detail pane already made.
 *
 * Still a separate component from `MyTasks`'s toolbar rather than one shared `BoardToolbar`.
 * The two are now close enough that sharing is tempting, and it is still the wrong call for
 * the reason this repo's own rule gives: the desktop's is inline in a 1200-line screen with
 * a dozen closures over its state, and lifting it would be a refactor of `MyTasks` rather
 * than a reuse. What IS shared is everything with a rule in it: the layout (`boardLayout`),
 * the Done switch's words (`doneSwitchLabel`), the Removed-cards dialog and the commit-graph
 * pane the button here opens.
 */
import type { ReactNode } from 'react';
import {
  Button,
  Overflow,
  OverflowItem,
  Spinner,
  Switch,
  ToggleButton,
} from '@fluentui/react-components';
import {
  ArchiveRegular,
  ArrowRoutingRegular,
  ArrowSyncRegular,
  BranchForkRegular,
  PanelRightContractRegular,
  PanelRightExpandRegular,
} from '@fluentui/react-icons';
import { useBoardLayoutStyles } from '@tm/ui/board/boardLayout';
import { LinkModeSwitch } from '@tm/ui/board/LinkModeSwitch';
import { BoardTitlePicker, BoardViewTabs } from '@tm/ui/board/BoardHeader';
import { nextLinkMode, type LinkMode } from '@tm/ui/board/linkMode';
import {
  TOOLBAR_OVERFLOW_PADDING,
  ToolbarOverflowMenu,
  ToolbarOverflowMenuItem,
} from '@tm/ui/board/ToolbarOverflow';
import { archivedCountLabel, archivedCountTitle } from '@tm/ui/board/ArchivedCardsDialog';
import {
  doneSwitchLabel,
  doneSwitchTitle,
  type HiddenDoneSummary,
} from '@tm/ui/board/doneSwitchLabel';
import type { BoardScope } from '@tm/shared/ipc';

export interface BoardToolbarProps {
  /** The compact (phone) board: no Board/List tabs — a phone has no room for them, and its
   *  own tab bar already reaches the list. */
  compact?: boolean;
  /** The List tab: leave the board for the Tickets screen. Absent, the tab is disabled. */
  onOpenList?: () => void;
  /** Which board is open — `'all'` unions every board's cards, or one board's own project
   *  id. The desktop's own scope picker, mirrored from `settings.boardScopeId`. */
  scope: string;
  /** The boards the title picker offers, beyond the built-in "All boards" option — `board:scopes`'
   *  own list, derived here from the mirrored projects. */
  scopes: BoardScope[];
  onScopeChange: (scope: string) => void;
  showDone: boolean;
  /** What the DONE column is holding while it is shut — see `hiddenDoneSummary`. */
  hiddenDone: HiddenDoneSummary;
  onShowDoneChange: (value: boolean) => void;
  showDetail: boolean;
  onShowDetailChange: (value: boolean) => void;
  /** The commit-graph pane. Off by default — it costs a `git log` on the desktop's machine. */
  showGraph: boolean;
  onShowGraphChange: (value: boolean) => void;
  /** Narrow the board to the selected card's chain — the desktop's own Chain toggle. */
  chainFocus: boolean;
  onChainFocusChange: (value: boolean) => void;
  /** False with nothing selected: focus follows the selection, so there is nothing to focus. */
  canFocusChain: boolean;
  /** The Off/Focus/All switch — how the chain links themselves draw, distinct from
   *  `chainFocus` above, which filters which CARDS are on the board at all. */
  boardLinks: LinkMode;
  onBoardLinksChange: (mode: LinkMode) => void;
  currentSprintOnly: boolean;
  onCurrentSprintOnlyChange: (value: boolean) => void;
  /** A relayed `jira:sync` is in flight — the ring spins and the sprint switch is held. */
  syncing: boolean;
  onSync: () => void;
  /** Cards that have left the board. The button is only offered when there are some. */
  archivedCount: number;
  onOpenArchived: () => void;
  /** The Add-task control, passed in whole: creating a card is the host's business. */
  addTask: ReactNode;
}

export function BoardToolbar({
  compact = false,
  onOpenList,
  scope,
  scopes,
  onScopeChange,
  showDone,
  hiddenDone,
  onShowDoneChange,
  showDetail,
  onShowDetailChange,
  showGraph,
  onShowGraphChange,
  chainFocus,
  onChainFocusChange,
  canFocusChain,
  boardLinks,
  onBoardLinksChange,
  currentSprintOnly,
  onCurrentSprintOnlyChange,
  syncing,
  onSync,
  archivedCount,
  onOpenArchived,
  addTask,
}: BoardToolbarProps): JSX.Element {
  const layout = useBoardLayoutStyles();
  return (
    // One row, never two or three (the 2026-10-18 screenshot review) — `Overflow` hides
    // whichever `OverflowItem`s below no longer fit behind the "···" menu at the end.
    //
    // EVERY real control is an `OverflowItem`, the always-visible ones included (`pinned`) —
    // the overflow manager's `occupiedSize()` only sums the width of REGISTERED items against
    // the container's full width (`@fluentui/priority-overflow`'s `overflowManager.js`), so an
    // unwrapped child is invisible to its budget math and the row overflows the viewport
    // instead of the menu. Only the spacer stays unregistered — see `ToolbarOverflow.tsx`.
    <Overflow minimumVisible={1} padding={TOOLBAR_OVERFLOW_PADDING}>
      <div className={layout.header} data-board-header="">
        {/* Which board's cards are shown, as the card's own title (v9-7) — the desktop's own
          picker (`MyTasks.tsx`), same options and same persisted setting. Pinned: it is the
          heading, and the one pinned item that may ellipsize (`layout.titleSlot`). */}
        <OverflowItem id="scope" pinned>
          <BoardTitlePicker scope={scope} scopes={scopes} onScopeChange={onScopeChange} />
        </OverflowItem>
        {!compact && (
          <OverflowItem id="view" pinned>
            <BoardViewTabs onOpenList={onOpenList} />
          </OverflowItem>
        )}
        <OverflowItem id="done" pinned>
          <Switch
            label={doneSwitchLabel(showDone, hiddenDone)}
            title={doneSwitchTitle(showDone, hiddenDone) ?? undefined}
            checked={showDone}
            onChange={(_e, d) => onShowDoneChange(d.checked)}
          />
        </OverflowItem>
        <OverflowItem id="sprint">
          <Switch
            label="Current sprint"
            checked={currentSprintOnly}
            disabled={syncing}
            onChange={(_e, d) => onCurrentSprintOnlyChange(d.checked)}
          />
        </OverflowItem>
        <span className={layout.grow} />
        {/* Focus the board on ONE route through it — the desktop's own reasoning, and its own
          `disabledFocusable`: with nothing selected the control has something to SAY, and a
          plainly disabled button can be neither hovered for its tooltip nor tabbed to. */}
        <OverflowItem id="chain">
          <ToggleButton
            size="small"
            appearance="subtle"
            icon={<ArrowRoutingRegular />}
            checked={chainFocus}
            disabledFocusable={!canFocusChain}
            title={
              !canFocusChain
                ? 'Pick a card first — focus follows the selected card’s chain'
                : chainFocus
                  ? 'Showing this card’s chain only — click for the whole board'
                  : 'Show only this card’s chain: what it waits for, and what waits on it'
            }
            onClick={() => onChainFocusChange(!chainFocus)}
          >
            Chain
          </ToggleButton>
        </OverflowItem>
        {/* Off/Focus/All: how the links themselves draw, distinct from Chain above — that one
          filters which cards are on the board, this one changes how the links between
          whatever cards ARE there look. `L` cycles it (`BoardScreen`'s own shortcut). */}
        <OverflowItem id="linkmode">
          <LinkModeSwitch mode={boardLinks} onChange={onBoardLinksChange} />
        </OverflowItem>
        {/* What actually happened in the repo, beside what the board believes about it — the
          desktop's own control, and its own reasoning: a view rather than a filter, and off
          by default because it costs a `git log`. Here that log runs on the desktop and the
          answer comes back over the relay, which is the only difference between the two. */}
        <OverflowItem id="graph">
          <Button
            size="small"
            appearance="subtle"
            icon={<BranchForkRegular />}
            title={showGraph ? 'Hide the commit graph' : 'Show the repository’s commit graph'}
            aria-label={showGraph ? 'Hide the commit graph' : 'Show the commit graph'}
            aria-pressed={showGraph}
            onClick={() => onShowGraphChange(!showGraph)}
          />
        </OverflowItem>
        <OverflowItem id="detail">
          <Button
            size="small"
            appearance="subtle"
            icon={showDetail ? <PanelRightContractRegular /> : <PanelRightExpandRegular />}
            title={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
            aria-label={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
            aria-pressed={showDetail}
            onClick={() => onShowDetailChange(!showDetail)}
          />
        </OverflowItem>
        {/* Only when something has left the board: on a healthy board this is an empty list,
          and a permanent button for one is a permanent invitation to check whether anything
          has gone missing. */}
        {archivedCount > 0 && (
          <OverflowItem id="archived">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArchiveRegular />}
              title={archivedCountTitle(archivedCount)}
              aria-label={archivedCountTitle(archivedCount)}
              onClick={onOpenArchived}
            >
              {archivedCountLabel(archivedCount)}
            </Button>
          </OverflowItem>
        )}
        {/* Sync the tracker now. It is the DESKTOP that talks to JIRA — this relays the same
          `jira:sync` its own button calls — so the cards it changes arrive here on the next
          board poll rather than when this settles. */}
        <OverflowItem id="sync">
          <Button
            size="small"
            appearance="subtle"
            icon={syncing ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
            disabled={syncing}
            title={syncing ? 'Syncing…' : 'Sync the tracker now, on your desktop app'}
            aria-label="Sync now"
            onClick={onSync}
          />
        </OverflowItem>
        <ToolbarOverflowMenu>
          <ToolbarOverflowMenuItem
            id="sprint"
            onClick={() => onCurrentSprintOnlyChange(!currentSprintOnly)}
          >
            {currentSprintOnly ? '✓ ' : ''}Current sprint
          </ToolbarOverflowMenuItem>
          <ToolbarOverflowMenuItem id="chain" onClick={() => onChainFocusChange(!chainFocus)}>
            {chainFocus ? '✓ ' : ''}Focus this card’s chain
          </ToolbarOverflowMenuItem>
          <ToolbarOverflowMenuItem
            id="linkmode"
            onClick={() => onBoardLinksChange(nextLinkMode(boardLinks))}
          >
            Chain links: {boardLinks === 'off' ? 'Off' : boardLinks === 'focus' ? 'Focus' : 'All'}
          </ToolbarOverflowMenuItem>
          <ToolbarOverflowMenuItem id="graph" onClick={() => onShowGraphChange(!showGraph)}>
            {showGraph ? 'Hide' : 'Show'} the commit graph
          </ToolbarOverflowMenuItem>
          <ToolbarOverflowMenuItem id="detail" onClick={() => onShowDetailChange(!showDetail)}>
            {showDetail ? 'Hide' : 'Show'} the detail pane
          </ToolbarOverflowMenuItem>
          {archivedCount > 0 && (
            <ToolbarOverflowMenuItem id="archived" onClick={onOpenArchived}>
              {archivedCountLabel(archivedCount)}
            </ToolbarOverflowMenuItem>
          )}
          <ToolbarOverflowMenuItem id="sync" onClick={onSync}>
            {syncing ? 'Syncing…' : 'Sync the tracker now'}
          </ToolbarOverflowMenuItem>
        </ToolbarOverflowMenu>
        {/* The row's LAST control, after the "···" menu — the v9 mockup's brand "+" at the far
            right edge, as `MyTasks` places it. `addTask` is a `ReactNode` from the host
            (`BoardScreen.tsx`'s own `<Button>`), not necessarily a single `ReactElement` by
            its type — `OverflowItem` clones and refs its one child, which a bare `ReactNode`
            cannot always satisfy, so it is wrapped in a plain `<div>` here rather than passed
            straight through. */}
        <OverflowItem id="add" pinned>
          <div>{addTask}</div>
        </OverflowItem>
      </div>
    </Overflow>
  );
}
