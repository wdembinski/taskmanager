/**
 * Board view (Phase 3).
 *
 * The running dashboard: each project's tasks move through pending → running →
 * done/failed as the scheduler works the queue. Press **Run** on a project and it
 * starts its pending tasks one at a time; **Pause** stops queuing new ones (the
 * current task finishes); **Stop** halts and kills the running session.
 *
 * Everything updates live off two engine events — `task:changed` (a task's status
 * / sessionId / live runId) and `scheduler:changed` (a project's run state) — so
 * the board never polls. Selecting a task shows the Phase 1 transcript for its
 * live run, reusing `<Transcript>`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Divider,
  makeStyles,
  Spinner,
  Subtitle2,
  Switch,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ProjectWithTasks, Task } from '@shared/model';
import type { SchedulerState } from '@shared/scheduler';
import { STATUS_COLOR } from './taskStatus';
import { Transcript } from './Transcript';

const useStyles = makeStyles({
  root: { display: 'flex', gap: '16px', minHeight: 0, flex: 1 },
  left: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    overflowY: 'auto',
    minHeight: 0,
  },
  right: { flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 },
  project: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  projectHead: { display: 'flex', alignItems: 'center', gap: '10px' },
  grow: { flex: 1, minWidth: 0 },
  name: { display: 'flex', alignItems: 'center', gap: '8px' },
  controls: { display: 'flex', alignItems: 'center', gap: '6px' },
  phaseTitle: { color: tokens.colorNeutralForeground2, marginTop: '4px' },
  taskRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '4px 6px',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
  },
  taskRowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  taskTitle: { flex: 1, minWidth: 0 },
  session: {
    color: tokens.colorNeutralForeground3,
    fontFamily: 'ui-monospace, Consolas, monospace',
  },
  empty: { color: tokens.colorNeutralForeground3 },
  rightHead: { display: 'flex', alignItems: 'center', gap: '10px' },
});

const SCHEDULER_BADGE: Record<
  SchedulerState,
  { color: 'brand' | 'warning' | 'subtle'; label: string }
> = {
  running: { color: 'brand', label: 'running' },
  paused: { color: 'warning', label: 'paused' },
  idle: { color: 'subtle', label: 'idle' },
};

/** Group a project's tasks by phase, preserving plan order. */
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

export function Board(): JSX.Element {
  const styles = useStyles();
  const [projects, setProjects] = useState<ProjectWithTasks[] | null>(null);
  const [runIds, setRunIds] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, SchedulerState>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Load projects + any already-running tasks, and subscribe to live updates.
  useEffect(() => {
    void window.api.invoke('project:list').then(setProjects);
    void window.api.invoke('scheduler:activeRuns').then((runs) => {
      setRunIds(Object.fromEntries(runs.map((r) => [r.taskId, r.runId])));
    });

    const offTask = window.api.on('task:changed', ({ task, runId }) => {
      // Patch the task wherever it lives.
      setProjects((prev) =>
        prev
          ? prev.map((pt) =>
              pt.project.id === task.projectId
                ? { ...pt, tasks: pt.tasks.map((t) => (t.id === task.id ? task : t)) }
                : pt,
            )
          : prev,
      );
      // Track (or clear) the live run id for wiring the transcript.
      setRunIds((prev) => {
        const next = { ...prev };
        if (runId) next[task.id] = runId;
        else delete next[task.id];
        return next;
      });
    });

    const offScheduler = window.api.on('scheduler:changed', ({ projectId, state }) => {
      setStates((prev) => ({ ...prev, [projectId]: state }));
    });

    return () => {
      offTask();
      offScheduler();
    };
  }, []);

  const setWriteBack = useCallback(async (projectId: string, enabled: boolean) => {
    await window.api.invoke('project:setWriteBack', projectId, enabled);
    setProjects((prev) =>
      prev
        ? prev.map((pt) =>
            pt.project.id === projectId
              ? { ...pt, project: { ...pt.project, writeBackPlan: enabled } }
              : pt,
          )
        : prev,
    );
  }, []);

  const selectedRunId = selectedTaskId ? (runIds[selectedTaskId] ?? null) : null;

  if (projects === null) {
    return <Spinner label="Loading board…" labelPosition="after" size="tiny" />;
  }

  if (projects.length === 0) {
    return (
      <Body1 className={styles.empty}>
        No projects yet. Add one on the <strong>Projects</strong> tab, then come back here to run
        it.
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        {projects.map(({ project, tasks }) => {
          const state = states[project.id] ?? 'idle';
          const running = state === 'running';
          const paused = state === 'paused';
          const anyRunnable = tasks.some((t) => t.status === 'pending');
          return (
            <div key={project.id} className={styles.project}>
              <div className={styles.projectHead}>
                <div className={`${styles.name} ${styles.grow}`}>
                  <Text weight="semibold">{project.name}</Text>
                  <Badge appearance="tint" color={SCHEDULER_BADGE[state].color}>
                    {SCHEDULER_BADGE[state].label}
                  </Badge>
                </div>
                <div className={styles.controls}>
                  <Switch
                    checked={project.writeBackPlan}
                    label="write back"
                    onChange={(_e, d) => void setWriteBack(project.id, d.checked)}
                  />
                  <Button
                    size="small"
                    appearance="primary"
                    disabled={running || !anyRunnable}
                    onClick={() => void window.api.invoke('scheduler:start', project.id)}
                  >
                    {paused ? 'Resume' : 'Run'}
                  </Button>
                  <Button
                    size="small"
                    disabled={!running}
                    onClick={() => void window.api.invoke('scheduler:pause', project.id)}
                  >
                    Pause
                  </Button>
                  <Button
                    size="small"
                    disabled={!running && !paused}
                    onClick={() => void window.api.invoke('scheduler:stop', project.id)}
                  >
                    Stop
                  </Button>
                </div>
              </div>

              {tasks.length === 0 ? (
                <Caption1 className={styles.empty}>
                  No tasks — add checkboxes to the plan and Sync on the Projects tab.
                </Caption1>
              ) : (
                groupByPhase(tasks).map((group) => (
                  <div key={group.phase}>
                    <Divider />
                    <Caption1 className={styles.phaseTitle}>{group.phase}</Caption1>
                    {group.tasks.map((task) => (
                      <div
                        key={task.id}
                        className={`${styles.taskRow} ${
                          task.id === selectedTaskId ? styles.taskRowSelected : ''
                        }`}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <Badge appearance="tint" color={STATUS_COLOR[task.status]}>
                          {task.status}
                        </Badge>
                        <Text className={styles.taskTitle} truncate wrap={false}>
                          {task.title}
                        </Text>
                        {task.sessionId && (
                          <Caption1 className={styles.session} title={task.sessionId}>
                            {task.sessionId.slice(0, 8)}
                          </Caption1>
                        )}
                        {task.status === 'pending' && (
                          <Button
                            size="small"
                            appearance="subtle"
                            onClick={(e) => {
                              e.stopPropagation();
                              void window.api
                                .invoke('task:run', task.id)
                                .then(() => setSelectedTaskId(task.id));
                            }}
                          >
                            Run
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.right}>
        <div className={styles.rightHead}>
          <Subtitle2>Live output</Subtitle2>
          {selectedRunId && (
            <Caption1 className={styles.session}>run {selectedRunId.slice(0, 8)}</Caption1>
          )}
        </div>
        <Transcript
          runId={selectedRunId}
          emptyHint={
            selectedTaskId
              ? 'This task is not running right now — its live output appears here while it runs.'
              : 'Select a task to see its live output.'
          }
        />
      </div>
    </div>
  );
}
