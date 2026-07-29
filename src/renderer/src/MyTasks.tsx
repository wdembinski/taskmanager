/**
 * My Tasks — the standalone personal Kanban board (Phase C).
 *
 * A board independent of code-projects: it holds your JIRA-synced tickets and
 * internal ad-hoc tasks side by side. Columns are To Do / In Progress / Blocked,
 * plus a toggleable Done. Drag a card between columns to change its status; for a
 * JIRA ticket that also transitions the real issue (TO DO → IN PROGRESS, or → Done),
 * while Blocked is internal-only and never touches JIRA. The selected card's status
 * and activity timeline show in the right pane (`TaskDetail`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PanelRightContractRegular, PanelRightExpandRegular } from '@fluentui/react-icons';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import type { MergeRequest } from '@shared/mergeRequest';
import { AddTaskDialog } from './AddTaskDialog';
import { PaneLoading } from './PaneLoading';
import { TaskDetail } from './TaskDetail';
import { useInitialLoad } from './useInitialLoad';
import { KanbanColumn } from './board/KanbanColumn';
import { useAttentionIndex } from './useAttentionIndex';
import { useActiveRuns } from './useActiveRuns';
import {
  COLUMN_META,
  columnForTask,
  groupSubtasks,
  hasLiveSubtask,
  sortCards,
  statusForColumn,
  visibleColumns,
} from './board/boardColumns';
import type { BoardCard, BoardColumn } from './board/boardColumns';

const useStyles = makeStyles({
  // No gap: the detail pane's own surface runs to the board's edge, and the change of
  // shade is the seam.
  root: { display: 'flex', minHeight: 0, flex: 1 },
  board: {
    flex: '1 1 60%',
    // The screen owns its insets now that the shell adds none, and only the board side
    // needs them — the detail pane runs to the window's edges on purpose.
    padding: '12px 16px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
    minWidth: 0,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  grow: { flex: 1 },
  // The whole board scrolls as one — not each column on its own — so the columns stay
  // aligned with each other while you scroll. A grid (rather than a flex row) is what
  // makes that work: the single auto row sizes to the *tallest* column, every column
  // stretches to it (so a short column is still a full-height drop target), and this
  // container is the only thing that scrolls.
  columns: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    // Breathing room above the first card. Its 3px project stripe and its 3px attention
    // ring both live ON the card's top edge, and with the sticky header sitting directly
    // on top of the list they had nothing to breathe into.
    paddingTop: '4px',
  },
  right: {
    flex: '1 1 40%',
    display: 'flex',
    minHeight: 0,
    // No inset: the detail pane's top band is full-bleed (it is a section of the pane,
    // not a card in it), so each of the pane's other rows carries its own padding.
    // One surface for the whole pane, a step LIGHTER than the board — that contrast is
    // what separates the two halves of the screen, so no dividing line is needed.
    backgroundColor: tokens.colorNeutralBackground1,
  },
});

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

/** AI-owned states a human may not move by hand (mirrors the `task:setStatus` guard). */
function managedByAI(task: Task): boolean {
  return task.status === 'running' || task.status === 'waiting-input';
}

export function MyTasks(): JSX.Element {
  const styles = useStyles();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // The repos a card can be delegated to — fetched once and shared by the cards
  // (glyph tooltip) and the detail pane (assign dialog).
  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Merge requests for the WHOLE board in one array, not hung off each Task: a JIRA
  // sync rebuilds every task literal, so an array living there would be clobbered on
  // every poll. See the `gitlab:mergeRequests` contract.
  const [mergeRequests, setMergeRequests] = useState<MergeRequest[]>([]);
  /**
   * The whole inbox and the live-run set, subscribed ONCE here and passed down.
   *
   * Here rather than in the card because both the ring and the sort order read them, and
   * a per-card subscription would mean one round trip per card and N copies of a state
   * that must agree. See `useAttentionIndex` for the three bugs this replaced.
   */
  const attention = useAttentionIndex();
  const liveRuns = useActiveRuns();

  const showDone = settings?.jira.showDoneColumn ?? false;
  const jiraEnabled = settings?.jira.enabled ?? false;
  const currentSprintOnly = settings?.jira.currentSprintOnly ?? false;
  const showDetail = settings?.showTaskDetail ?? true;

  const refresh = useCallback(async () => {
    setTasks(await window.api.invoke('board:tasks'));
  }, []);

  // One seed load for all three channels, so a failure in any of them is reported
  // rather than leaving the board on its spinner.
  const seed = useCallback(async () => {
    const [board, appSettings, repos, mrs] = await Promise.all([
      window.api.invoke('board:tasks'),
      window.api.invoke('settings:get'),
      window.api.invoke('agentProject:list'),
      window.api.invoke('gitlab:mergeRequests'),
    ]);
    setTasks(board);
    setSettings(appSettings);
    setAgentProjects(repos);
    setMergeRequests(mrs);
  }, []);

  const initial = useInitialLoad(seed);

  const patchTask = useCallback((task: Task) => {
    if (task.projectId !== PERSONAL_PROJECT_ID) return; // board shows only personal tasks
    setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
  }, []);

  // Live updates: single-task changes, and whole-board replacement after a sync/add.
  // Plus the settings the ENGINE writes: dragging a card teaches it what a JIRA status
  // means, and this screen saves the whole settings blob (the two switches above), so
  // the learned map has to come back or the next toggle would write over it.
  useEffect(() => {
    const offTask = window.api.on('task:changed', ({ task }) => patchTask(task));
    const offTasks = window.api.on('project:tasksChanged', ({ projectId, tasks: next }) => {
      if (projectId === PERSONAL_PROJECT_ID) setTasks(next);
    });
    const offSettings = window.api.on('settings:changed', (next) => {
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              jira: {
                ...prev.jira,
                learnedStatusColumns: next.jira.learnedStatusColumns,
                lastCreateProjectKey: next.jira.lastCreateProjectKey,
                lastCreateIssueTypeId: next.jira.lastCreateIssueTypeId,
              },
            }
          : prev,
      );
    });
    const offMrs = window.api.on('gitlab:mergeRequestsChanged', setMergeRequests);
    return () => {
      offTask();
      offTasks();
      offSettings();
      offMrs();
    };
  }, [patchTask]);

  const selectedTask = useMemo(
    () => tasks?.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  /** taskId → its merge requests, so a card can be built in one pass. */
  const mrsByTask = useMemo(() => {
    const map = new Map<string, MergeRequest[]>();
    for (const mr of mergeRequests) {
      if (!mr.taskId) continue; // an orphan: its ticket is not on this board
      const list = map.get(mr.taskId);
      if (list) list.push(mr);
      else map.set(mr.taskId, [mr]);
    }
    return map;
  }, [mergeRequests]);

  const cardsByColumn = useMemo(() => {
    const map: Record<BoardColumn, BoardCard[]> = {
      todo: [],
      'in-progress': [],
      'in-review': [],
      blocked: [],
      done: [],
    };
    // A card's steps are not cards of their own — they render inside the parent and
    // travel with it, whatever their own status.
    for (const card of groupSubtasks(tasks ?? [], mrsByTask)) {
      map[columnForTask(card.task)].push(card);
    }
    // Cards that want you first, then by priority — see `sortCards`. The inbox's ids go
    // in too: the ordering and the orange ring are the same predicate on purpose, so
    // passing it to the card and not to the sort would have the two disagree.
    for (const col of Object.keys(map) as BoardColumn[])
      map[col] = sortCards(map[col], attention.taskIds);
    return map;
  }, [tasks, mrsByTask, attention.taskIds]);

  /**
   * The chain the selected task belongs to: a card's own steps, or — when a step is
   * selected — its siblings, so the detail pane can say "step 2 of 5" and offer the
   * way back to the parent.
   */
  const chain = useMemo(() => {
    if (!selectedTask) return [];
    const parentId = selectedTask.parentTaskId ?? selectedTask.id;
    return (tasks ?? [])
      .filter((t) => t.parentTaskId === parentId)
      .sort((a, b) => a.order - b.order);
  }, [tasks, selectedTask]);

  const parentOfSelected = useMemo(
    () =>
      selectedTask?.parentTaskId
        ? (tasks?.find((t) => t.id === selectedTask.parentTaskId) ?? null)
        : null,
    [tasks, selectedTask],
  );

  /** Cards a hand-written step can be added under: every top-level card on this board. */
  const parentCandidates = useMemo(() => (tasks ?? []).filter((t) => !t.parentTaskId), [tasks]);

  const setShowDone = useCallback((value: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, jira: { ...prev.jira, showDoneColumn: value } };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  const setShowDetail = useCallback((value: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, showTaskDetail: value };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      setTasks(await window.api.invoke('jira:sync'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  // Unlike "Show Done", which only hides a column that is already loaded, this one
  // changes the JQL the next fetch runs — so the board is re-synced immediately,
  // otherwise the switch would appear to do nothing until the next poll.
  const setCurrentSprintOnly = useCallback(
    async (value: boolean) => {
      if (!settings) return;
      const next = { ...settings, jira: { ...settings.jira, currentSprintOnly: value } };
      setSettings(next);
      await window.api.invoke('settings:save', next);
      if (next.jira.enabled) await sync();
    },
    [settings, sync],
  );

  const moveTask = useCallback(
    async (taskId: string, column: BoardColumn) => {
      const task = tasks?.find((t) => t.id === taskId);
      if (!task || columnForTask(task) === column) return;
      if (managedByAI(task)) {
        setError('Stop the running session before moving this task.');
        return;
      }
      setError(null);
      const prev = task;
      patchTask({ ...task, status: statusForColumn(column) }); // optimistic
      try {
        patchTask(await window.api.invoke('task:move', taskId, column));
      } catch (e) {
        patchTask(prev); // rollback (e.g. JIRA transition unavailable)
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [tasks, patchTask],
  );

  if (tasks === null) {
    return <PaneLoading label="Loading tasks…" error={initial.error} onRetry={initial.retry} />;
  }

  return (
    <div className={styles.root}>
      <div className={styles.board}>
        <div className={styles.toolbar}>
          <Switch
            label="Show Done"
            checked={showDone}
            onChange={(_e, d) => setShowDone(d.checked)}
          />
          {jiraEnabled && (
            <Switch
              label="Current sprint"
              checked={currentSprintOnly}
              disabled={syncing}
              onChange={(_e, d) => void setCurrentSprintOnly(d.checked)}
            />
          )}
          <span className={styles.grow} />
          {/* Fold the detail pane away. An icon button rather than a third switch: this
              one is a view control, not a filter on what the board contains. */}
          <Button
            size="small"
            appearance="subtle"
            icon={showDetail ? <PanelRightContractRegular /> : <PanelRightExpandRegular />}
            title={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
            aria-label={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
            aria-pressed={showDetail}
            onClick={() => setShowDetail(!showDetail)}
          />
          {jiraEnabled && (
            <Button size="small" disabled={syncing} onClick={() => void sync()}>
              {syncing ? 'Syncing…' : 'Sync JIRA'}
            </Button>
          )}
          <Button size="small" appearance="primary" onClick={() => setAddOpen(true)}>
            Add task…
          </Button>
        </div>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" appearance="transparent" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {/*
          The drag state is cleared HERE, not only on the card. A card dropped into
          another column is re-parented by the optimistic patch below, so React unmounts
          the node the drag started on and its `dragend` never reaches the root — the
          card would keep `styles.dragging` (half opacity) until the next drag. This
          container never unmounts, so it also catches an ESC-cancelled drag and the
          `managedByAI` early-return, both of which leaked the same state.
        */}
        <div className={styles.columns} onDragEnd={() => setDraggingId(null)}>
          {visibleColumns(showDone).map((col) => (
            <KanbanColumn
              key={col}
              column={col}
              label={COLUMN_LABEL[col]}
              cards={cardsByColumn[col]}
              projectNameOf={(t) =>
                t.externalSource === 'jira' ? t.phase || undefined : undefined
              }
              agentNameOf={(t) => agentProjects.find((p) => p.id === t.agentProjectId)?.name}
              // The stripe is the PROJECT the card is filed under, not the agent it may
              // or may not be delegated to.
              projectColorOf={(t) =>
                agentProjects.find((p) => p.id === t.projectTagId)?.color || undefined
              }
              // With the sprint filter on every card carries the same chip, so the name
              // moves to the status bar and is said once. Off, the chip earns its place.
              showSprint={!currentSprintOnly}
              statusKeywords={settings?.statusKeywords}
              attentionTaskIds={attention.taskIds}
              liveRunTaskIds={liveRuns}
              display={settings?.board}
              // A card with a live step is the runner's until the chain stops.
              canDrag={(c) => !managedByAI(c.task) && !hasLiveSubtask(c.subtasks)}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onSelectTask={setSelectedTaskId}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onDropInColumn={(taskId, column) => {
                // Before the move, not after: `moveTask` patches optimistically and the
                // dragged card is gone from this column by the time the promise settles.
                setDraggingId(null);
                void moveTask(taskId, column);
              }}
            />
          ))}
        </div>
      </div>

      {/* Unmounted rather than hidden when folded away: remounting re-runs loadActivity,
          which is cheap, and re-marks the selected card read — which is what you want
          the moment the pane comes back anyway. */}
      {showDetail && (
        <div className={styles.right}>
          <TaskDetail
            task={selectedTask}
            agentProjects={agentProjects}
            subtasks={chain}
            parentTask={parentOfSelected}
            mergeRequests={selectedTask ? (mrsByTask.get(selectedTask.id) ?? []) : []}
            statusKeywords={settings?.statusKeywords}
            onOpenTask={setSelectedTaskId}
            onStatusChanged={patchTask}
            onSubtasksChanged={() => void refresh()}
          />
        </div>
      )}

      <AddTaskDialog
        open={addOpen}
        projectId={PERSONAL_PROJECT_ID}
        phases={[]}
        parents={parentCandidates}
        jiraEnabled={jiraEnabled}
        onClose={() => setAddOpen(false)}
        onCreated={() => void refresh()}
      />
    </div>
  );
}
