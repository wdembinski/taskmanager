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
 * the Done switch's words (`doneSwitchLabel`), the Display menu, the Removed-cards dialog and
 * the commit-graph pane the button here opens.
 */
import type { ReactNode } from 'react';
import { Button, Spinner, Switch, ToggleButton } from '@fluentui/react-components';
import {
  ArchiveRegular,
  ArrowRoutingRegular,
  ArrowSyncRegular,
  BranchForkRegular,
  PanelRightContractRegular,
  PanelRightExpandRegular,
} from '@fluentui/react-icons';
import { useBoardLayoutStyles } from '@tm/ui/board/boardLayout';
import { BoardDisplayMenu } from '@tm/ui/board/BoardDisplayMenu';
import { archivedCountLabel, archivedCountTitle } from '@tm/ui/board/ArchivedCardsDialog';
import {
  doneSwitchLabel,
  doneSwitchTitle,
  type HiddenDoneSummary,
} from '@tm/ui/board/doneSwitchLabel';
import type { BoardDisplaySettings } from '@tm/shared/settings';

export interface BoardToolbarProps {
  showDone: boolean;
  /** What the DONE column is holding while it is shut — see `hiddenDoneSummary`. */
  hiddenDone: HiddenDoneSummary;
  onShowDoneChange: (value: boolean) => void;
  display: BoardDisplaySettings;
  onDisplayChange: (value: BoardDisplaySettings) => void;
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
  showDone,
  hiddenDone,
  onShowDoneChange,
  display,
  onDisplayChange,
  showDetail,
  onShowDetailChange,
  showGraph,
  onShowGraphChange,
  chainFocus,
  onChainFocusChange,
  canFocusChain,
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
    <div className={layout.toolbar}>
      <Switch
        label={doneSwitchLabel(showDone, hiddenDone)}
        title={doneSwitchTitle(showDone, hiddenDone) ?? undefined}
        checked={showDone}
        onChange={(_e, d) => onShowDoneChange(d.checked)}
      />
      <Switch
        label="Current sprint"
        checked={currentSprintOnly}
        disabled={syncing}
        onChange={(_e, d) => onCurrentSprintOnlyChange(d.checked)}
      />
      <span className={layout.grow} />
      {/* Focus the board on ONE route through it — the desktop's own reasoning, and its own
          `disabledFocusable`: with nothing selected the control has something to SAY, and a
          plainly disabled button can be neither hovered for its tooltip nor tabbed to. */}
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
      <BoardDisplayMenu display={display} onChange={onDisplayChange} />
      {/* Sync the tracker now. It is the DESKTOP that talks to JIRA — this relays the same
          `jira:sync` its own button calls — so the cards it changes arrive here on the next
          board poll rather than when this settles. */}
      <Button
        size="small"
        appearance="subtle"
        icon={syncing ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
        disabled={syncing}
        title={syncing ? 'Syncing…' : 'Sync the tracker now, on your desktop app'}
        aria-label="Sync now"
        onClick={onSync}
      />
      {/* What actually happened in the repo, beside what the board believes about it — the
          desktop's own control, and its own reasoning: a view rather than a filter, and off
          by default because it costs a `git log`. Here that log runs on the desktop and the
          answer comes back over the relay, which is the only difference between the two. */}
      <Button
        size="small"
        appearance="subtle"
        icon={<BranchForkRegular />}
        title={showGraph ? 'Hide the commit graph' : 'Show the repository’s commit graph'}
        aria-label={showGraph ? 'Hide the commit graph' : 'Show the commit graph'}
        aria-pressed={showGraph}
        onClick={() => onShowGraphChange(!showGraph)}
      />
      <Button
        size="small"
        appearance="subtle"
        icon={showDetail ? <PanelRightContractRegular /> : <PanelRightExpandRegular />}
        title={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
        aria-label={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
        aria-pressed={showDetail}
        onClick={() => onShowDetailChange(!showDetail)}
      />
      {/* Only when something has left the board: on a healthy board this is an empty list,
          and a permanent button for one is a permanent invitation to check whether anything
          has gone missing. */}
      {archivedCount > 0 && (
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
      )}
      {addTask}
    </div>
  );
}
