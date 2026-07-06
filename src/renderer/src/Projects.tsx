/**
 * Projects screen (Phase 2).
 *
 * Lists the projects the app is tracking and, for each, the tasks parsed from its
 * `plan.md` grouped by phase. This is the read side of the new persistence layer:
 * everything here is loaded over the `project:*` IPC channels and survives an app
 * restart. Running tasks is Phase 3 — for now this is add / view / sync / remove.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Divider,
  makeStyles,
  Spinner,
  Subtitle2,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { ProjectWithTasks, Task, TaskStatus } from '@shared/model';

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
  taskTitle: { flex: 1 },
  empty: { color: tokens.colorNeutralForeground3 },
});

const STATUS_COLOR: Record<
  TaskStatus,
  'brand' | 'danger' | 'important' | 'informative' | 'severe' | 'subtle' | 'success' | 'warning'
> = {
  pending: 'informative',
  running: 'brand',
  'waiting-input': 'warning',
  'blocked-by-limit': 'severe',
  done: 'success',
  failed: 'danger',
  stopped: 'subtle',
};

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
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setProjects(await window.api.invoke('project:list'));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addProject = useCallback(async () => {
    setBusy(true);
    try {
      const path = await window.api.invoke('project:pickDirectory');
      if (!path) return;
      await window.api.invoke('project:add', { path });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const syncPlan = useCallback(
    async (id: string) => {
      await window.api.invoke('project:syncPlan', id);
      await refresh();
    },
    [refresh],
  );

  const removeProject = useCallback(
    async (id: string) => {
      await window.api.invoke('project:remove', id);
      await refresh();
    },
    [refresh],
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle2 className={styles.grow}>Projects</Subtitle2>
        <Button appearance="primary" onClick={addProject} disabled={busy}>
          Add project…
        </Button>
      </div>

      {projects === null ? (
        <Spinner label="Loading projects…" labelPosition="after" size="tiny" />
      ) : projects.length === 0 ? (
        <Body1 className={styles.empty}>
          No projects yet. Click <strong>Add project…</strong>, choose a folder, and its{' '}
          <code>plan.md</code> will be parsed into tasks.
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
                      {tasks.length} task{tasks.length === 1 ? '' : 's'} · plan: {project.planPath}
                    </Caption1>
                  }
                  action={
                    <div className={styles.cardActions}>
                      <Button size="small" onClick={() => syncPlan(project.id)}>
                        Sync plan
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

                {tasks.length === 0 ? (
                  <Caption1 className={styles.empty}>
                    No tasks parsed — add checkbox items (<code>- [ ] …</code>) to the plan, then
                    Sync.
                  </Caption1>
                ) : (
                  groups.map((group) => (
                    <div key={group.phase} className={styles.phase}>
                      <Divider />
                      <Caption1 className={styles.phaseTitle}>{group.phase}</Caption1>
                      {group.tasks.map((task) => (
                        <div key={task.id} className={styles.taskRow}>
                          <Badge appearance="tint" color={STATUS_COLOR[task.status]}>
                            {task.status}
                          </Badge>
                          <Text className={styles.taskTitle}>{task.title}</Text>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
