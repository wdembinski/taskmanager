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
 * the header's pill and "…" menu (`LinkModeSwitch`, `BoardMoreMenu`), the Done entry's words
 * (`doneSwitchLabel`), the Removed-cards dialog and the commit-graph pane the menu opens.
 */
import type { ReactNode } from 'react';
import { useBoardLayoutStyles } from '@tm/ui/board/boardLayout';
import { BoardMoreMenu } from '@tm/ui/board/BoardMoreMenu';
import { LinkModeSwitch } from '@tm/ui/board/LinkModeSwitch';
import { BoardTitlePicker, BoardViewTabs } from '@tm/ui/board/BoardHeader';
import type { LinkMode } from '@tm/ui/board/linkMode';
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
    // One row (v9-7): title, tabs, spacer, the `Links:` pill, "…" and "+". Everything else is
    // behind "…" at every width — `BoardMoreMenu`, the same menu the desktop draws.
    <div className={layout.header} data-board-header="">
      {/* Which board's cards are shown, as the card's own title — the desktop's own picker
        (`MyTasks.tsx`), same options and same persisted setting. The one control in the row
        that ellipsizes when the row runs short. */}
      <BoardTitlePicker scope={scope} scopes={scopes} onScopeChange={onScopeChange} />
      {!compact && <BoardViewTabs onOpenList={onOpenList} />}
      <span className={layout.grow} />
      {/* Off/Focus/All: how the links themselves draw. `L` cycles it (`BoardScreen`). */}
      <LinkModeSwitch mode={boardLinks} onChange={onBoardLinksChange} />
      {/* Sync relays the desktop's own `jira:sync` — it is the DESKTOP that talks to JIRA —
        so the cards it changes arrive here on the next board poll rather than when it settles.
        The commit graph is a `git log` run on the desktop and relayed back. */}
      <BoardMoreMenu
        doneLabel={doneSwitchLabel(showDone, hiddenDone)}
        doneTitle={doneSwitchTitle(showDone, hiddenDone)}
        doneChecked={showDone}
        onToggleDone={() => onShowDoneChange(!showDone)}
        sprint={{
          checked: currentSprintOnly,
          disabled: syncing,
          onToggle: () => onCurrentSprintOnlyChange(!currentSprintOnly),
        }}
        chainFocus={chainFocus}
        chainFocusDisabled={!canFocusChain}
        onToggleChainFocus={() => onChainFocusChange(!chainFocus)}
        showGraph={showGraph}
        onToggleGraph={() => onShowGraphChange(!showGraph)}
        showDetail={showDetail}
        onToggleDetail={() => onShowDetailChange(!showDetail)}
        archivedCount={archivedCount}
        onOpenArchived={onOpenArchived}
        sync={{ syncing, onSync }}
      />
      {/* The row's LAST control — the v9 mockup's brand "+" at the far right edge, as
        `MyTasks` places it. Creating a card is the host's business (`BoardScreen.tsx`). */}
      {addTask}
    </div>
  );
}
