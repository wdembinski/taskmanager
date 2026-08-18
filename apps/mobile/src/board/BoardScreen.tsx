/**
 * The mobile board: My Tasks, drawn for a phone — the same cloud mirror `apps/web`'s
 * `BoardScreen` reads (`useCloudBoard`, `useBoardExtras`), the same cards
 * (`sortCards`/`groupSubtasks`/`@tm/ui`'s `TaskCard`), and the same optimistic move
 * (`useCloudBoard.setStatus` — the pending overlay, the queued command and the
 * reconciliation on the next poll are all untouched, all still in `useCloudBoard.ts`).
 *
 * What differs from the web's board is the shape, not the data: one column at a time
 * (`ColumnChips`) instead of `KanbanColumn`'s side-by-side grid, a "Move to…" menu
 * (`BoardCardRow`) instead of HTML5 drag-and-drop, and no chain overlay, no detail pane and
 * no commit-graph SIDE pane — opening a card full-screen is the next step of this phase
 * (docs/plan/README.md, Phase 27 step 7); the commit graph opens as a full-screen sheet
 * instead (`GitGraphSheet`) rather than being left off.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Button,
  Caption1,
  Spinner,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, ArchiveRegular, ArrowSyncRegular, BranchForkRegular } from '@fluentui/react-icons';
import { columnForTask, statusForColumn } from '@tm/shared/board';
import { PERSONAL_PROJECT_ID, type BoardColumn, type ManualStatus, type Task } from '@tm/shared/model';
import { COLUMN_META, groupSubtasks, hiddenDoneSummary, sortCards, visibleColumns, type BoardCard } from '@tm/ui/board/boardColumns';
import { AddTaskDialog } from '@tm/ui/AddTaskDialog';
import { archivedCards, archivedCountLabel, archivedCountTitle, ArchivedCardsDialog } from '@tm/ui/board/ArchivedCardsDialog';
import { doneSwitchLabel, doneSwitchTitle } from '@tm/ui/board/doneSwitchLabel';
import { useTransport } from '@tm/ui/transport';
import { selectArchivedTasks, selectBoardTasks } from '@tm/cloud/board/boardSelectors';
import { displayStatus, isTaskPending, type CloudBoardState } from '@tm/cloud/board/cloudBoardStore';
import { mergeRequestsByTask, useBoardExtras } from '@tm/cloud/board/useBoardExtras';
import { BoardCardRow } from './BoardCardRow';
import { ColumnChips } from './ColumnChips';
import { GitGraphSheet } from './GitGraphSheet';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minHeight: 0,
    // Room for the FAB, so the last card in a long column is never sitting under it.
    paddingBottom: '84px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '8px 12px 0',
  },
  grow: { flex: 1, minWidth: 0 },
  error: { padding: '0 12px', color: '#f1707b' },
  list: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 12px 0' },
  empty: { color: tokens.colorNeutralForeground4, padding: '16px 4px' },
  fab: {
    position: 'fixed',
    right: '16px',
    bottom: 'calc(72px + env(safe-area-inset-bottom))',
    minWidth: '56px',
    width: '56px',
    height: '56px',
    boxShadow: tokens.shadow16,
  },
});

export interface BoardScreenProps {
  state: CloudBoardState;
  everSeenClient: boolean;
  onSetStatus: (taskId: string, status: ManualStatus) => void;
}

export function BoardScreen({ state, everSeenClient, onSetStatus }: BoardScreenProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const extras = useBoardExtras();
  const [selectedColumn, setSelectedColumn] = useState<BoardColumn>('todo');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  /** See `BoardScreen.tsx` (web) — the timestamp, not a boolean, so relative labels don't
   *  re-word themselves on an unrelated render. */
  const [archivedOpenedAt, setArchivedOpenedAt] = useState<number | null>(null);

  const { settings, saveSettings } = extras;
  const showDone = settings.jira.showDoneColumn;

  const reportError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const projects = useMemo(() => Object.values(state.projects), [state.projects]);
  const boardTasks = useMemo(() => selectBoardTasks(state), [state]);
  const removedCards = useMemo(() => archivedCards(selectArchivedTasks(state)), [state]);
  const mrsByTask = useMemo(() => mergeRequestsByTask(extras.mergeRequests), [extras.mergeRequests]);

  const projectNameOf = (task: Task): string | undefined =>
    task.externalSource ? task.phase || undefined : undefined;
  const agentNameOf = (task: Task): string | undefined =>
    extras.agentProjects.find((p) => p.id === task.agentProjectId)?.name;
  const projectColorOf = (task: Task): string | undefined =>
    extras.agentProjects.find((p) => p.id === task.projectTagId)?.color || undefined;

  const cardsByColumn = useMemo(() => {
    // Same optimistic overlay the web board applies before columning: a card moved from this
    // screen jumps to its destination the instant the tap lands, from `displayStatus` rather
    // than waiting for the next poll to confirm it.
    const displayTasks = boardTasks.map((task) => ({ ...task, status: displayStatus(state, task) }));
    const byColumn = new Map<BoardColumn, BoardCard[]>();
    for (const meta of COLUMN_META) byColumn.set(meta.column, []);
    for (const card of groupSubtasks(displayTasks, mrsByTask)) {
      byColumn.get(columnForTask(card.task))?.push(card);
    }
    for (const meta of COLUMN_META) {
      byColumn.set(meta.column, sortCards(byColumn.get(meta.column) ?? [], extras.attention.taskIds));
    }
    return byColumn;
  }, [boardTasks, state, mrsByTask, extras.attention.taskIds]);

  const hiddenDone = useMemo(() => hiddenDoneSummary(cardsByColumn.get('done') ?? []), [cardsByColumn]);

  const visible = useMemo(() => visibleColumns(showDone), [showDone]);
  // Falls back to the first visible column the moment the current chip's column is hidden —
  // e.g. Show Done switched off while DONE was selected — rather than rendering a chip row
  // with nothing selected in it.
  const effectiveColumn = visible.includes(selectedColumn) ? selectedColumn : (visible[0] ?? 'todo');

  const pendingTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of Object.values(state.tasks)) {
      if (isTaskPending(state, task.id)) ids.add(task.id);
    }
    return ids;
  }, [state]);

  const parentCandidates = useMemo(() => boardTasks.filter((t) => !t.parentTaskId), [boardTasks]);
  const tasksById = useMemo(() => new Map(boardTasks.map((t) => [t.id, t])), [boardTasks]);

  const move = useCallback(
    (taskId: string, column: BoardColumn) => {
      if (!everSeenClient) return;
      if (pendingTaskIds.has(taskId)) return; // one edit in flight at a time per card
      onSetStatus(taskId, statusForColumn(column));
    },
    [everSeenClient, pendingTaskIds, onSetStatus],
  );

  const disabledReason = everSeenClient
    ? undefined
    : 'No desktop app has ever synced this account — sign in and open it once first.';

  const cards = cardsByColumn.get(effectiveColumn) ?? [];

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Switch
          label={doneSwitchLabel(showDone, hiddenDone)}
          title={doneSwitchTitle(showDone, hiddenDone) ?? undefined}
          checked={showDone}
          onChange={(_e, d) =>
            void saveSettings({
              ...settings,
              jira: { ...settings.jira, showDoneColumn: d.checked },
            }).catch(reportError)
          }
        />
        <span className={styles.grow} />
        <Button
          size="small"
          appearance="subtle"
          icon={syncing ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
          disabled={syncing}
          title={syncing ? 'Syncing…' : 'Sync the tracker now, on your desktop app'}
          aria-label="Sync now"
          onClick={() => {
            setSyncing(true);
            setError(null);
            void transport
              .invoke('jira:sync')
              .catch(reportError)
              .finally(() => setSyncing(false));
          }}
        />
        <Button
          size="small"
          appearance="subtle"
          icon={<BranchForkRegular />}
          title="Show the repository’s commit graph"
          aria-label="Show the commit graph"
          onClick={() => setGraphOpen(true)}
        />
        {removedCards.length > 0 && (
          <Button
            size="small"
            appearance="subtle"
            icon={<ArchiveRegular />}
            title={archivedCountTitle(removedCards.length)}
            aria-label={archivedCountTitle(removedCards.length)}
            onClick={() => setArchivedOpenedAt(Date.now())}
          >
            {archivedCountLabel(removedCards.length)}
          </Button>
        )}
      </div>

      {error && <Caption1 className={styles.error}>{error}</Caption1>}

      <ColumnChips
        columns={visible}
        cardsByColumn={cardsByColumn}
        selected={effectiveColumn}
        onSelect={setSelectedColumn}
      />

      <div className={styles.list}>
        {boardTasks.length === 0 ? (
          <Caption1 className={styles.empty}>
            {projects.length === 0 && Object.keys(state.tasks).length === 0
              ? 'No board data yet — waiting on the first sync from your desktop app.'
              : 'No cards on your Personal board.'}
          </Caption1>
        ) : cards.length === 0 ? (
          <Caption1 className={styles.empty}>Nothing here.</Caption1>
        ) : (
          cards.map(({ task, subtasks, mergeRequests }) => (
            <BoardCardRow
              key={task.id}
              task={task}
              projectName={projectNameOf(task)}
              agentName={agentNameOf(task)}
              projectColor={projectColorOf(task)}
              showSprint={!settings.jira.currentSprintOnly}
              subtasks={subtasks}
              mergeRequests={mergeRequests}
              statusKeywords={settings.statusKeywords}
              attentionTaskIds={extras.attention.taskIds}
              liveRunTaskIds={extras.liveRunTaskIds}
              mergingTaskIds={extras.mergingTaskIds}
              display={settings.board}
              // Nothing opens on a tap yet — that's the next step of this phase (see the file
              // header). Selection stays permanently false rather than tracking a card nothing
              // reads it back from.
              selected={false}
              onSelect={() => {}}
              column={effectiveColumn}
              moveTargets={visible}
              onMove={(column) => move(task.id, column)}
            />
          ))
        )}
      </div>

      <Button
        className={styles.fab}
        appearance="primary"
        shape="circular"
        size="large"
        icon={<AddRegular />}
        disabled={!everSeenClient}
        title={disabledReason}
        aria-label="Add task"
        onClick={() => setAddOpen(true)}
      />

      <AddTaskDialog
        open={addOpen}
        projectId={PERSONAL_PROJECT_ID}
        phases={[]}
        parents={parentCandidates}
        chainCandidates={parentCandidates}
        projects={extras.agentProjects}
        jiraEnabled={settings.jira.enabled}
        // No OS file picker and no path for a dropped `File` on a phone browser either — the
        // same reason the web's own dialog turns this off.
        filesEnabled={false}
        onClose={() => setAddOpen(false)}
        onCreated={extras.refresh}
        onNotice={setError}
      />

      <ArchivedCardsDialog
        open={archivedOpenedAt !== null}
        archived={removedCards}
        now={archivedOpenedAt ?? 0}
        onClose={() => setArchivedOpenedAt(null)}
        onRestore={(taskId) => extras.restoreTask(taskId).catch(reportError)}
      />

      <GitGraphSheet
        open={graphOpen}
        onClose={() => setGraphOpen(false)}
        projects={extras.agentProjects}
        selectedTask={null}
        tasksById={tasksById}
        runningTaskIds={extras.liveRunTaskIds}
      />
    </div>
  );
}
