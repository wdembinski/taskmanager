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
  Spinner,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import type { AppSettings } from '@shared/settings';
import { AddTaskDialog } from './AddTaskDialog';
import { TaskDetail } from './TaskDetail';
import { KanbanColumn } from './board/KanbanColumn';
import {
  COLUMN_META,
  columnForTask,
  groupSubtasks,
  hasLiveSubtask,
  statusForColumn,
  visibleColumns,
} from './board/boardColumns';
import type { BoardCard, BoardColumn } from './board/boardColumns';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '16px', minHeight: 0, flex: 1 },
  board: {
    flex: '1 1 60%',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
    minWidth: 0,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  grow: { flex: 1 },
  columns: { display: 'flex', gap: '12px', flex: 1, minHeight: 0 },
  right: {
    flex: '1 1 40%',
    display: 'flex',
    minHeight: 0,
    paddingLeft: '16px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
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

  const showDone = settings?.jira.showDoneColumn ?? false;
  const jiraEnabled = settings?.jira.enabled ?? false;

  const refresh = useCallback(async () => {
    setTasks(await window.api.invoke('board:tasks'));
  }, []);

  useEffect(() => {
    void refresh();
    void window.api.invoke('settings:get').then(setSettings);
    void window.api.invoke('agentProject:list').then(setAgentProjects);
  }, [refresh]);

  const patchTask = useCallback((task: Task) => {
    if (task.projectId !== PERSONAL_PROJECT_ID) return; // board shows only personal tasks
    setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
  }, []);

  // Live updates: single-task changes, and whole-board replacement after a sync/add.
  useEffect(() => {
    const offTask = window.api.on('task:changed', ({ task }) => patchTask(task));
    const offTasks = window.api.on('project:tasksChanged', ({ projectId, tasks: next }) => {
      if (projectId === PERSONAL_PROJECT_ID) setTasks(next);
    });
    return () => {
      offTask();
      offTasks();
    };
  }, [patchTask]);

  const selectedTask = useMemo(
    () => tasks?.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const cardsByColumn = useMemo(() => {
    const map: Record<BoardColumn, BoardCard[]> = {
      todo: [],
      'in-progress': [],
      blocked: [],
      done: [],
    };
    // A card's steps are not cards of their own — they render inside the parent and
    // travel with it, whatever their own status.
    for (const card of groupSubtasks(tasks ?? [])) map[columnForTask(card.task)].push(card);
    for (const col of Object.keys(map) as BoardColumn[])
      map[col].sort((a, b) => a.task.order - b.task.order);
    return map;
  }, [tasks]);

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
    return <Spinner label="Loading tasks…" labelPosition="after" size="tiny" />;
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
          <span className={styles.grow} />
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

        <div className={styles.columns}>
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
              // A card with a live step is the runner's until the chain stops.
              canDrag={(c) => !managedByAI(c.task) && !hasLiveSubtask(c.subtasks)}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onSelectTask={setSelectedTaskId}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onDropInColumn={(taskId, column) => void moveTask(taskId, column)}
            />
          ))}
        </div>
      </div>

      <div className={styles.right}>
        <TaskDetail
          task={selectedTask}
          agentProjects={agentProjects}
          subtasks={chain}
          parentTask={parentOfSelected}
          onOpenTask={setSelectedTaskId}
          onStatusChanged={patchTask}
          onSubtasksChanged={() => void refresh()}
        />
      </div>

      <AddTaskDialog
        open={addOpen}
        projectId={PERSONAL_PROJECT_ID}
        phases={[]}
        parents={parentCandidates}
        onClose={() => setAddOpen(false)}
        onCreated={() => void refresh()}
      />
    </div>
  );
}
