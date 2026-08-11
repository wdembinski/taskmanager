/**
 * The web board's toolbar — the desktop's, minus everything this app cannot do.
 *
 * Kept: **Show Done** with its hidden count (the count is the control's whole point, and it
 * is if anything MORE useful here — a mirrored card that failed lands in DONE with nobody
 * having dragged it there, and nothing on this side is watching the engine), the **Display**
 * menu, the detail-pane fold, the **Removed cards** button, and Add task.
 *
 * Dropped, each because the action behind it does not exist in a browser: the Current-sprint
 * switch (it re-runs the JQL, and only the desktop talks to JIRA), the Chain toggle and its
 * overlay (no links are mirrored, so a Chain button could only ever blank the board), the
 * commit graph (a `git log` on a machine this app has no access to) and Sync (the desktop's
 * poll is what refreshes the mirror).
 *
 * A separate component from `MyTasks`'s toolbar rather than one shared `BoardToolbar` with a
 * dozen optional props: with the list above absent, a shared one would be twelve props the
 * web passes none of — a worse contract than two toolbars that each say what their host can
 * do. What IS shared is everything with a rule in it: the layout (`boardLayout`), the Done
 * switch's words (`doneSwitchLabel`), the Display menu and the Removed-cards dialog.
 */
import type { ReactNode } from 'react';
import { Button, Switch } from '@fluentui/react-components';
import {
  ArchiveRegular,
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
      <span className={layout.grow} />
      <BoardDisplayMenu display={display} onChange={onDisplayChange} />
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
          has gone missing. Read-only here — putting a card back is a write to the desktop's
          own database, and no command on the wire carries one. */}
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
