/**
 * Projects screen (Phase 2; extended in Phase 8).
 *
 * Lists the projects the app tracks and, per project, the tasks parsed from its
 * plan file grouped by phase. Everything loads over the `project:*` IPC channels
 * and survives a restart. Phase 8 adds: an Add/Edit dialog (custom plan path +
 * per-project model/mode/write-back) and, per task, "Attach session…" to adopt an
 * existing Claude conversation so a run resumes it instead of starting fresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Divider,
  makeStyles,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { PlanValidation, Project, ProjectWithTasks, Task } from '@shared/model';
import { AddTaskDialog } from './AddTaskDialog';
import { AttachSessionDialog } from './AttachSessionDialog';
import { PaneLoading } from './PaneLoading';
import { useInitialLoad } from './useInitialLoad';
import { ProjectDialog } from './ProjectDialog';
import { Transcript } from './Transcript';
import { STATUS_COLOR, STATUS_LABEL } from './taskStatus';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', alignItems: 'center', gap: '12px' },
  grow: { flex: 1 },
  list: { display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', minHeight: 0 },
  card: { padding: '4px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  path: { color: tokens.colorNeutralForeground3, fontFamily: 'ui-monospace, Consolas, monospace' },
  cardActions: { display: 'flex', gap: '8px' },
  phase: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' },
  phaseTitle: { color: tokens.colorNeutralForeground2 },
  taskRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '2px 0' },
  taskTitle: { flex: 1, minWidth: 0 },
  session: {
    color: tokens.colorNeutralForeground3,
    fontFamily: 'ui-monospace, Consolas, monospace',
  },
  empty: { color: tokens.colorNeutralForeground3 },
});

/** Group a project's tasks by phase, preserving first-seen (plan) order. */
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

export function Projects(): JSX.Element {
  const styles = useStyles();
  const [projects, setProjects] = useState<ProjectWithTasks[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Add/Edit dialog (project is set only for edit) and the attach-session dialog.
  const [dialog, setDialog] = useState<{ open: boolean; mode: 'add' | 'edit'; project?: Project }>({
    open: false,
    mode: 'add',
  });
  const [attach, setAttach] = useState<{ open: boolean; task: Task | null }>({
    open: false,
    task: null,
  });
  const [addTask, setAddTask] = useState<{ open: boolean; projectId: string | null; phases: string[] }>(
    { open: false, projectId: null, phases: [] },
  );
  // Plan-validation results keyed by project id (dependency resolve + cycle checks).
  const [validations, setValidations] = useState<Record<string, PlanValidation>>({});
  // The AI-assisted "Align plan" run, shown live in a dialog.
  const [align, setAlign] = useState<{
    open: boolean;
    runId: string | null;
    projectId: string;
    project: string;
    status: 'running' | 'done' | 'error';
  }>({ open: false, runId: null, projectId: '', project: '', status: 'running' });
  // Project ids with an Align run in flight — disables the button (single-flight).
  const [aligningIds, setAligningIds] = useState<Set<string>>(new Set());
  // Maps an align run id back to its project, so we can react to its completion.
  const alignRunToProject = useRef<Map<string, string>>(new Map());

  const validateProject = useCallback(async (id: string) => {
    const result = await window.api.invoke('project:validatePlan', id);
    setValidations((prev) => ({ ...prev, [id]: result }));
  }, []);

  const refresh = useCallback(async () => {
    const list = await window.api.invoke('project:list');
    setProjects(list);
    // Validate each plan in the background so cards can flag dependency problems.
    for (const { project } of list) void validateProject(project.id);
  }, [validateProject]);

  const initial = useInitialLoad(refresh);

  // Live task-list updates (Phase 8): the plan file was edited — by a human or the
  // agent mid-run — and re-synced, or a task was created/deleted. Replace just that
  // project's tasks in place so the screen updates without a full reload.
  useEffect(() => {
    return window.api.on('project:tasksChanged', ({ projectId, tasks }) => {
      setProjects((prev) =>
        prev ? prev.map((p) => (p.project.id === projectId ? { ...p, tasks } : p)) : prev,
      );
      // The plan changed (possibly from an Align run) — re-check its dependencies.
      void validateProject(projectId);
    });
  }, [validateProject]);

  // Watch our Align runs' events so the dialog can show Done and the button can
  // re-enable when a run finishes on its own (result/exited).
  useEffect(() => {
    return window.api.on('session:event', ({ runId, event }) => {
      const projectId = alignRunToProject.current.get(runId);
      if (!projectId) return;
      if (event.kind === 'result' || event.kind === 'exited') {
        alignRunToProject.current.delete(runId);
        setAligningIds((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          return next;
        });
        const failed = event.kind === 'result' && !event.success;
        setAlign((a) => (a.runId === runId ? { ...a, status: failed ? 'error' : 'done' } : a));
        void validateProject(projectId);
      }
    });
  }, [validateProject]);

  /** Run an engine call, surfacing any failure instead of failing silently. */
  const guard = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const syncPlan = useCallback(
    (id: string) =>
      guard('Could not sync plan', async () => {
        await window.api.invoke('project:syncPlan', id);
        await refresh();
      }),
    [guard, refresh],
  );

  const removeProject = useCallback(
    (id: string) =>
      guard('Could not remove project', async () => {
        await window.api.invoke('project:remove', id);
        await refresh();
      }),
    [guard, refresh],
  );

  const alignPlan = useCallback(
    (project: Project) =>
      guard('Could not start Align plan', async () => {
        const { runId } = await window.api.invoke('project:alignPlan', project.id);
        alignRunToProject.current.set(runId, project.id);
        setAligningIds((prev) => new Set(prev).add(project.id));
        setAlign({
          open: true,
          runId,
          projectId: project.id,
          project: project.name,
          status: 'running',
        });
      }),
    [guard],
  );

  // Dismiss the "align this plan" nudge for a legacy project: mark it aligned so the
  // prompt doesn't return. Purely a UI hint — the project runs exactly as before.
  const dismissAlignNudge = useCallback(
    (id: string) =>
      guard('Could not update project', async () => {
        await window.api.invoke('project:setAligned', id, true);
        setProjects((prev) =>
          prev
            ? prev.map((p) =>
                p.project.id === id
                  ? { ...p, project: { ...p.project, planAligned: true } }
                  : p,
              )
            : prev,
        );
      }),
    [guard],
  );

  // Close the Align dialog. If its run is still going, STOP it (kill the agent) so
  // closing never leaves an invisible process editing the plan file.
  const closeAlign = useCallback(() => {
    if (align.runId && align.status === 'running') {
      void window.api.invoke('session:stop', align.runId);
      alignRunToProject.current.delete(align.runId);
      setAligningIds((prev) => {
        const next = new Set(prev);
        next.delete(align.projectId);
        return next;
      });
    }
    setAlign((a) => ({ ...a, open: false }));
  }, [align]);

  // Delete one ad-hoc task. The engine emits project:tasksChanged, so the list
  // updates via the live listener above (no explicit refresh needed).
  const deleteTask = useCallback(
    (taskId: string) =>
      guard('Could not delete task', async () => {
        await window.api.invoke('task:delete', taskId);
      }),
    [guard],
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle2 className={styles.grow}>Projects</Subtitle2>
        <Button appearance="primary" onClick={() => setDialog({ open: true, mode: 'add' })}>
          Add project…
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

      {projects === null ? (
        <PaneLoading label="Loading projects…" error={initial.error} onRetry={initial.retry} />
      ) : projects.length === 0 ? (
        <Body1 className={styles.empty}>
          No projects yet. Click <strong>Add project…</strong>, choose a folder (and optionally a
          plan file), and its checkbox items are parsed into tasks.
        </Body1>
      ) : (
        <div className={styles.list}>
          {projects.map(({ project, tasks }) => {
            const groups = groupByPhase(tasks);
            return (
              <Card key={project.id} className={styles.card}>
                <CardHeader
                  header={
                    <div className={styles.headerText}>
                      <Text weight="semibold">{project.name}</Text>
                      <Caption1 className={styles.path}>{project.path}</Caption1>
                    </div>
                  }
                  description={
                    <Caption1 className={styles.path}>
                      {tasks.length} task{tasks.length === 1 ? '' : 's'} · {project.defaultModel} ·{' '}
                      {project.defaultPermissionMode} · concurrency: {project.concurrency} · plan:{' '}
                      {project.planPath}
                    </Caption1>
                  }
                  action={
                    <div className={styles.cardActions}>
                      <Button
                        size="small"
                        onClick={() => setDialog({ open: true, mode: 'edit', project })}
                      >
                        Edit
                      </Button>
                      <Button size="small" onClick={() => syncPlan(project.id)}>
                        Sync plan
                      </Button>
                      <Button
                        size="small"
                        disabled={aligningIds.has(project.id)}
                        onClick={() => alignPlan(project)}
                      >
                        {aligningIds.has(project.id) ? 'Aligning…' : 'Align plan…'}
                      </Button>
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
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() => removeProject(project.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  }
                />

                {!project.planAligned && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <strong>Align this plan?</strong> This project predates the team-orchestration
                      features (task dependencies and a shared contract). Aligning adds{' '}
                      <code>@needs:</code> annotations so parallel agents don&apos;t collide — or
                      dismiss to keep running it as-is.
                    </MessageBarBody>
                    <MessageBarActions>
                      <Button
                        size="small"
                        disabled={aligningIds.has(project.id)}
                        onClick={() => alignPlan(project)}
                      >
                        {aligningIds.has(project.id) ? 'Aligning…' : 'Align plan…'}
                      </Button>
                      <Button
                        size="small"
                        appearance="transparent"
                        onClick={() => dismissAlignNudge(project.id)}
                      >
                        Dismiss
                      </Button>
                    </MessageBarActions>
                  </MessageBar>
                )}

                {(() => {
                  const issues = validations[project.id]?.issues ?? [];
                  if (issues.length === 0) return null;
                  const hasError = issues.some((i) => i.severity === 'error');
                  return (
                    <MessageBar intent={hasError ? 'error' : 'warning'}>
                      <MessageBarBody>
                        <strong>Plan dependencies:</strong>{' '}
                        {issues.map((i) => i.message).join(' ')}{' '}
                        {hasError && 'Fix the plan or run "Align plan…" to repair it.'}
                      </MessageBarBody>
                    </MessageBar>
                  );
                })()}

                {tasks.length === 0 ? (
                  <Caption1 className={styles.empty}>
                    No tasks yet — add checkbox items (<code>- [ ] …</code>) to the plan and Sync, or
                    click <strong>Add task…</strong> to create one directly.
                  </Caption1>
                ) : (
                  groups.map((group) => (
                    <div key={group.phase} className={styles.phase}>
                      <Divider />
                      <Caption1 className={styles.phaseTitle}>{group.phase}</Caption1>
                      {group.tasks.map((task) => {
                        const attachable =
                          task.status !== 'running' && task.status !== 'waiting-input';
                        return (
                          <div key={task.id} className={styles.taskRow}>
                            <Badge appearance="tint" color={STATUS_COLOR[task.status]}>
                              {STATUS_LABEL[task.status]}
                            </Badge>
                            <Text className={styles.taskTitle} truncate wrap={false}>
                              {task.title}
                            </Text>
                            {task.source === 'adhoc' && (
                              <Badge appearance="outline" color="informative" size="small">
                                ad-hoc
                              </Badge>
                            )}
                            {task.sessionId && (
                              <Caption1 className={styles.session} title={task.sessionId}>
                                {task.sessionId.slice(0, 8)}
                              </Caption1>
                            )}
                            {attachable && (
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => setAttach({ open: true, task })}
                              >
                                Attach session…
                              </Button>
                            )}
                            {task.source === 'adhoc' && attachable && (
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => deleteTask(task.id)}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </Card>
            );
          })}
        </div>
      )}

      <ProjectDialog
        open={dialog.open}
        mode={dialog.mode}
        project={dialog.project}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={() => void refresh()}
      />
      <AttachSessionDialog
        open={attach.open}
        task={attach.task}
        onClose={() => setAttach((a) => ({ ...a, open: false }))}
        onSaved={() => void refresh()}
      />
      <AddTaskDialog
        open={addTask.open}
        projectId={addTask.projectId}
        phases={addTask.phases}
        onClose={() => setAddTask((a) => ({ ...a, open: false }))}
        onCreated={() => void refresh()}
      />

      <Dialog
        open={align.open}
        onOpenChange={(_e, d) => {
          if (!d.open) closeAlign();
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              Align plan — {align.project}
              {align.status === 'running' && ' · running'}
              {align.status === 'done' && ' · done'}
              {align.status === 'error' && ' · error'}
            </DialogTitle>
            <DialogContent>
              {align.status === 'running' && (
                <Spinner
                  size="tiny"
                  labelPosition="after"
                  label="Claude is adding @needs: annotations to plan.md… Closing this dialog stops it."
                />
              )}
              {align.status === 'done' && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    Done. Review the changes in your <code>plan.md</code> (it&apos;s under version
                    control) — the task board has re-synced.
                  </MessageBarBody>
                </MessageBar>
              )}
              {align.status === 'error' && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    The align run ended with an error — see the transcript below.
                  </MessageBarBody>
                </MessageBar>
              )}
              <Transcript
                runId={align.runId}
                taskId={null}
                emptyHint="Starting the align session…"
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={closeAlign}>
                {align.status === 'running' ? 'Stop & close' : 'Close'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
