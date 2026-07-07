/**
 * My Tasks — the personal to-do screen (Phase 9).
 *
 * A hub for every task across all projects (plan-parsed and ad-hoc alike), where
 * you drive the work by hand: set a task's status, and keep a running thread of
 * progress notes. Two panes: a filterable, grouped task list on the left, and the
 * selected task's status + activity timeline (see `TaskDetail`) on the right. The
 * Board remains the place to watch the AI run; this is where *you* track things.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Divider,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ManualStatus, ProjectWithTasks, Task, TaskStatus } from '@shared/model';
import { AddTaskDialog } from './AddTaskDialog';
import { TaskDetail } from './TaskDetail';
import { MANUAL_STATUS_OPTIONS, STATUS_COLOR, STATUS_LABEL } from './taskStatus';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '16px', minHeight: 0, flex: 1 },
  left: {
    flex: '1 1 45%',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    overflowY: 'auto',
    minHeight: 0,
  },
  right: { flex: '1 1 55%', display: 'flex', minHeight: 0 },
  filters: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  grow: { flex: 1 },
  project: { display: 'flex', flexDirection: 'column', gap: '4px' },
  projectHead: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' },
  phaseTitle: { color: tokens.colorNeutralForeground2, marginTop: '4px' },
  taskRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '4px 6px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
  },
  taskRowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  taskTitle: { flex: 1, minWidth: 0 },
  empty: { color: tokens.colorNeutralForeground3 },
});

/** Group a project's tasks by phase, preserving first-seen order. */
function groupByPhase(tasks: Task[]): Array<{ phase: string; tasks: Task[] }> {
  const groups: Array<{ phase: string; tasks: Task[] }> = [];
  const index = new Map<string, number>();
  for (const task of tasks) {
    const key = task.phase || 'Ungrouped';
    let at = index.get(key);
    if (at === undefined) {
      at = groups.length;
      index.set(key, at);
      groups.push({ phase: key, tasks: [] });
    }
    groups[at].tasks.push(task);
  }
  return groups;
}

// Filter chips: "all" plus the statuses worth filtering a to-do list by.
const FILTERS: Array<{ value: 'all' | TaskStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'To Do' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

export function MyTasks(): JSX.Element {
  const styles = useStyles();
  const [projects, setProjects] = useState<ProjectWithTasks[] | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | TaskStatus>('all');
  const [error, setError] = useState<string | null>(null);
  const [addTask, setAddTask] = useState<{ open: boolean; projectId: string | null; phases: string[] }>(
    { open: false, projectId: null, phases: [] },
  );

  const refresh = useCallback(async () => {
    setProjects(await window.api.invoke('project:list'));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Patch a single task in place wherever it lives.
  const patchTask = useCallback((task: Task) => {
    setProjects((prev) =>
      prev
        ? prev.map((pt) =>
            pt.project.id === task.projectId
              ? { ...pt, tasks: pt.tasks.map((t) => (t.id === task.id ? task : t)) }
              : pt,
          )
        : prev,
    );
  }, []);

  // Live updates: status/session changes (task:changed) and whole-list changes
  // from a plan edit or add/delete (project:tasksChanged, Phase 8).
  useEffect(() => {
    const offTask = window.api.on('task:changed', ({ task }) => patchTask(task));
    const offTasks = window.api.on('project:tasksChanged', ({ projectId, tasks }) => {
      setProjects((prev) =>
        prev ? prev.map((pt) => (pt.project.id === projectId ? { ...pt, tasks } : pt)) : prev,
      );
    });
    return () => {
      offTask();
      offTasks();
    };
  }, [patchTask]);

  const setStatus = useCallback(async (taskId: string, status: ManualStatus) => {
    setError(null);
    try {
      await window.api.invoke('task:setStatus', taskId, status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const selectedTask = useMemo(
    () =>
      projects?.flatMap((p) => p.tasks).find((t) => t.id === selectedTaskId) ?? null,
    [projects, selectedTaskId],
  );

  const matches = (t: Task): boolean => filter === 'all' || t.status === filter;

  if (projects === null) {
    return <Spinner label="Loading tasks…" labelPosition="after" size="tiny" />;
  }

  if (projects.length === 0) {
    return (
      <Body1 className={styles.empty}>
        No projects yet. Add one on the <strong>Projects</strong> tab, then track its tasks here.
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <div className={styles.filters}>
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="small"
              appearance={filter === f.value ? 'primary' : 'subtle'}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
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

        {projects.map(({ project, tasks }) => {
          const shown = tasks.filter(matches);
          return (
            <div key={project.id} className={styles.project}>
              <div className={styles.projectHead}>
                <Text weight="semibold" className={styles.grow}>
                  {project.name}
                </Text>
                <Button
                  size="small"
                  onClick={() =>
                    setAddTask({
                      open: true,
                      projectId: project.id,
                      phases: [...new Set(tasks.map((t) => t.phase).filter(Boolean))],
                    })
                  }
                >
                  Add task…
                </Button>
              </div>
              {shown.length === 0 ? (
                <Caption1 className={styles.empty}>
                  {tasks.length === 0 ? 'No tasks yet.' : 'No tasks match this filter.'}
                </Caption1>
              ) : (
                groupByPhase(shown).map((group) => (
                  <div key={group.phase}>
                    <Divider />
                    <Caption1 className={styles.phaseTitle}>{group.phase}</Caption1>
                    {group.tasks.map((task) => {
                      const managedByAI =
                        task.status === 'running' || task.status === 'waiting-input';
                      return (
                        <div
                          key={task.id}
                          className={`${styles.taskRow} ${
                            task.id === selectedTaskId ? styles.taskRowSelected : ''
                          }`}
                          onClick={() => setSelectedTaskId(task.id)}
                        >
                          <Badge appearance="tint" color={STATUS_COLOR[task.status]}>
                            {STATUS_LABEL[task.status]}
                          </Badge>
                          <Text className={styles.taskTitle} truncate wrap={false}>
                            {task.title}
                          </Text>
                          <Menu>
                            <MenuTrigger disableButtonEnhancement>
                              <MenuButton
                                size="small"
                                appearance="subtle"
                                disabled={managedByAI}
                                onClick={(e) => e.stopPropagation()}
                              >
                                Set status
                              </MenuButton>
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                {MANUAL_STATUS_OPTIONS.map((o) => (
                                  <MenuItem
                                    key={o.value}
                                    onClick={() => void setStatus(task.id, o.value)}
                                  >
                                    {o.label}
                                  </MenuItem>
                                ))}
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.right}>
        <TaskDetail task={selectedTask} onStatusChanged={patchTask} />
      </div>

      <AddTaskDialog
        open={addTask.open}
        projectId={addTask.projectId}
        phases={addTask.phases}
        onClose={() => setAddTask((a) => ({ ...a, open: false }))}
        onCreated={() => void refresh()}
      />
    </div>
  );
}
