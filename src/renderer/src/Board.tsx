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
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Divider,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Switch,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ProjectWithTasks, Task } from '@shared/model';
import type { SchedulerState } from '@shared/scheduler';
import { STATUS_COLOR, STATUS_LABEL } from './taskStatus';
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
  branch: {
    color: tokens.colorNeutralForeground3,
    fontFamily: 'ui-monospace, Consolas, monospace',
    whiteSpace: 'nowrap',
  },
  empty: { color: tokens.colorNeutralForeground3 },
  waiting: { color: tokens.colorPaletteYellowForeground2, whiteSpace: 'nowrap' },
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

/**
 * Which of a task's `@needs:` prerequisites are not yet satisfied — i.e. titles
 * with no matching task, or a matching task that isn't `done`. Mirrors the
 * scheduler's eligibility rule (`selectNextPending`) so the UI explains a hold.
 */
function unmetDeps(task: Task, all: Task[]): string[] {
  if (!task.dependsOn?.length) return [];
  return task.dependsOn.filter((dep) => {
    const withTitle = all.filter((t) => t.title === dep);
    return withTitle.length === 0 || !withTitle.every((t) => t.status === 'done');
  });
}

/**
 * Of a task's unmet dependencies, the titles that will never resolve on their own
 * because a prerequisite task ended in a non-recoverable state (`failed`/`stopped`/
 * `cancelled`). Surfaced so the Board explains a permanent block instead of an
 * open-ended "waiting on".
 */
const DEAD_STATUSES = new Set<Task['status']>(['failed', 'stopped', 'cancelled']);
function failedDeps(unmet: string[], all: Task[]): string[] {
  return unmet.filter((dep) => {
    const withTitle = all.filter((t) => t.title === dep);
    return withTitle.length > 0 && withTitle.some((t) => DEAD_STATUSES.has(t.status));
  });
}

/** The orchestrator branch a worktree task runs on (mirrors `taskBranch` in the engine). */
function taskBranch(taskId: string): string {
  return `orch/${taskId.slice(0, 8)}`;
}

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
  // Inbox item id → {task, kind} for tasks parked on a merge conflict or a failure,
  // so the board can flag them. Keyed by item id so `attention:resolved` (which
  // carries only the id) can clear the right one.
  const [parked, setParked] = useState<
    Record<string, { taskId: string; kind: 'merge-conflict' | 'task-failed' }>
  >({});
  // The "align this plan first?" prompt shown when Run is pressed for a legacy
  // (unaligned) project. Null when no prompt is open.
  const [runNudge, setRunNudge] = useState<{ projectId: string; projectName: string } | null>(null);

  // Load projects + any already-running tasks, and subscribe to live updates.
  useEffect(() => {
    void window.api.invoke('project:list').then(setProjects);
    void window.api.invoke('scheduler:activeRuns').then((runs) => {
      setRunIds(Object.fromEntries(runs.map((r) => [r.taskId, r.runId])));
    });
    // Seed run state from the (long-lived) scheduler so the Run/Pause/Stop buttons
    // reflect reality after a tab switch remounts this view — not a stale idle.
    void window.api.invoke('scheduler:states').then((rows) => {
      setStates(Object.fromEntries(rows.map((r) => [r.projectId, r.state])));
    });
    // Seed + track merge-conflict / task-failed parks so the board can badge tasks.
    void window.api.invoke('attention:list').then((items) => {
      setParked(
        Object.fromEntries(
          items
            .filter((i) => i.kind === 'merge-conflict' || i.kind === 'task-failed')
            .map((i) => [
              i.id,
              { taskId: i.taskId, kind: i.kind as 'merge-conflict' | 'task-failed' },
            ]),
        ),
      );
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

    const offAttentionNew = window.api.on('attention:new', (item) => {
      if (item.kind !== 'merge-conflict' && item.kind !== 'task-failed') return;
      const kind = item.kind; // capture the narrowed kind for the setState closure
      setParked((prev) => ({ ...prev, [item.id]: { taskId: item.taskId, kind } }));
    });
    const offAttentionResolved = window.api.on('attention:resolved', ({ id }) => {
      setParked((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    // Phase 8: the plan was edited (possibly by the agent mid-run) and re-synced, or
    // a task was created/deleted. Replace that project's whole task list so new
    // milestones/tasks appear on the board live.
    const offTasks = window.api.on('project:tasksChanged', ({ projectId, tasks }) => {
      setProjects((prev) =>
        prev ? prev.map((pt) => (pt.project.id === projectId ? { ...pt, tasks } : pt)) : prev,
      );
    });

    return () => {
      offTask();
      offScheduler();
      offTasks();
      offAttentionNew();
      offAttentionResolved();
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

  // Mark a project aligned locally (mirrors the engine) so its Run nudge doesn't
  // return this session; the flag is a pure UI hint and never gates the run.
  const markAlignedLocally = useCallback((projectId: string) => {
    setProjects((prev) =>
      prev
        ? prev.map((pt) =>
            pt.project.id === projectId
              ? { ...pt, project: { ...pt.project, planAligned: true } }
              : pt,
          )
        : prev,
    );
  }, []);

  // Run a project. Legacy (unaligned) plans first raise the align nudge; everything
  // else starts the scheduler immediately.
  const runProject = useCallback(
    (project: ProjectWithTasks['project']) => {
      if (!project.planAligned) {
        setRunNudge({ projectId: project.id, projectName: project.name });
        return;
      }
      void window.api.invoke('scheduler:start', project.id);
    },
    [],
  );

  // "Run anyway" from the nudge: dismiss the prompt permanently (mark aligned) and
  // start the scheduler as-is.
  const runNudgeAnyway = useCallback(async () => {
    if (!runNudge) return;
    const { projectId } = runNudge;
    setRunNudge(null);
    await window.api.invoke('project:setAligned', projectId, true);
    markAlignedLocally(projectId);
    await window.api.invoke('scheduler:start', projectId);
  }, [runNudge, markAlignedLocally]);

  // "Align first" from the nudge: kick off the AI Align pass (its live transcript is
  // on the Projects tab); the rewritten plan re-syncs and confirms alignment.
  const runNudgeAlign = useCallback(async () => {
    if (!runNudge) return;
    const { projectId } = runNudge;
    setRunNudge(null);
    await window.api.invoke('project:alignPlan', projectId);
  }, [runNudge]);

  const selectedRunId = selectedTaskId ? (runIds[selectedTaskId] ?? null) : null;
  const conflictTaskIds = new Set(
    Object.values(parked)
      .filter((p) => p.kind === 'merge-conflict')
      .map((p) => p.taskId),
  );
  const failedTaskIds = new Set(
    Object.values(parked)
      .filter((p) => p.kind === 'task-failed')
      .map((p) => p.taskId),
  );

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
                    onClick={() => runProject(project)}
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
                    {group.tasks.map((task) => {
                      const unmet = task.status === 'pending' ? unmetDeps(task, tasks) : [];
                      const blockedByFail = failedDeps(unmet, tasks);
                      const waitingOn = unmet.filter((d) => !blockedByFail.includes(d));
                      const inConflict = conflictTaskIds.has(task.id);
                      const parkedFailed = failedTaskIds.has(task.id);
                      // A worktree task shows its branch while it's live (or parked).
                      const showBranch =
                        project.useWorktrees &&
                        (task.status === 'running' || task.status === 'waiting-input');
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
                          {task.isContract && (
                            <Badge
                              appearance="tint"
                              color="brand"
                              title="Authors the milestone's shared CONTRACT.md; runs first, before its sibling tasks"
                            >
                              contract
                            </Badge>
                          )}
                          {inConflict && (
                            <Badge
                              appearance="tint"
                              color="danger"
                              title="Branch integration hit a merge conflict — resolve it in the Attention inbox"
                            >
                              merge conflict
                            </Badge>
                          )}
                          {parkedFailed && (
                            <Badge
                              appearance="tint"
                              color="danger"
                              title="Task failed — choose how to resolve it in the Attention inbox"
                            >
                              needs attention
                            </Badge>
                          )}
                          <Text className={styles.taskTitle} truncate wrap={false}>
                            {task.title}
                          </Text>
                          {showBranch && (
                            <Caption1
                              className={styles.branch}
                              title={`Working on branch ${taskBranch(task.id)}`}
                            >
                              {taskBranch(task.id)}
                            </Caption1>
                          )}
                          {blockedByFail.length > 0 && (
                            <Caption1
                              className={styles.waiting}
                              title={`Prerequisite failed: ${blockedByFail.join(', ')}`}
                            >
                              blocked: prerequisite {blockedByFail.join(', ')} failed
                            </Caption1>
                          )}
                          {waitingOn.length > 0 && (
                            <Caption1
                              className={styles.waiting}
                              title={`Waiting on: ${waitingOn.join(', ')}`}
                            >
                              waiting on: {waitingOn.join(', ')}
                            </Caption1>
                          )}
                          {task.sessionId && (
                            <Caption1 className={styles.session} title={task.sessionId}>
                              {task.sessionId.slice(0, 8)}
                            </Caption1>
                          )}
                          {task.status === 'pending' && (
                            <Button
                              size="small"
                              appearance="subtle"
                              disabled={unmet.length > 0}
                              title={
                                unmet.length > 0
                                  ? `Blocked until prerequisites are done: ${unmet.join(', ')}`
                                  : undefined
                              }
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
        <div className={styles.rightHead}>
          <Subtitle2>Live output</Subtitle2>
          {selectedRunId && (
            <Caption1 className={styles.session}>run {selectedRunId.slice(0, 8)}</Caption1>
          )}
        </div>
        <Transcript
          runId={selectedRunId}
          taskId={selectedTaskId}
          emptyHint={
            selectedTaskId
              ? 'No output recorded for this task yet — it appears here once the task runs.'
              : 'Select a task to see its transcript.'
          }
        />
      </div>

      <Dialog
        open={runNudge !== null}
        onOpenChange={(_e, d) => {
          if (!d.open) setRunNudge(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Align this plan first?</DialogTitle>
            <DialogContent>
              <MessageBar intent="info">
                <MessageBarBody>
                  <strong>{runNudge?.projectName}</strong> predates the team-orchestration features.
                  Its tasks declare no dependencies, so parallel agents may collide. Align adds{' '}
                  <code>@needs:</code> annotations first (its transcript shows on the Projects tab),
                  or run it as-is.
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRunNudge(null)}>
                Not now
              </Button>
              <Button appearance="secondary" onClick={() => void runNudgeAnyway()}>
                Run anyway
              </Button>
              <Button appearance="primary" onClick={() => void runNudgeAlign()}>
                Align plan…
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
