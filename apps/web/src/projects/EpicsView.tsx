/**
 * A project's tickets grouped by epic (`Task.epicTaskId`) — the one grouping the backlog's
 * flat list doesn't show on its own. Each epic is a header (its own row, so it can be
 * opened just like any other ticket) plus its children indented under it; anything with no
 * epic lands in a trailing "No epic" group rather than being dropped.
 */
import { useMemo, useState } from 'react';
import {
  Button,
  Caption1,
  Subtitle2,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import type { Project, Task } from '@tm/shared/model';
import { backlogEpics, epicChildren, epicProgress, selectBacklogTasks } from './backlogSelectors';
import type { CloudBoardState } from '../board/cloudBoardStore';
import type { ProjectsApiDeps } from './projectsApi';
import { TicketFormDialog } from './TicketFormDialog';
import { TicketRow } from './TicketRow';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    padding: '12px 16px',
    overflowY: 'auto',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  group: { display: 'flex', flexDirection: 'column', gap: '2px' },
  groupHead: { display: 'flex', alignItems: 'center', gap: '8px' },
  groupHeadRow: { flex: 1, minWidth: 0 },
  progress: { color: tokens.colorNeutralForeground3 },
  children: { display: 'flex', flexDirection: 'column', marginLeft: '20px' },
  empty: { padding: '8px 4px' },
});

export interface EpicsViewProps {
  state: CloudBoardState;
  project: Project;
  apiDeps: ProjectsApiDeps;
  onTaskSaved: (task: Task) => void;
  onOpenTicket: (taskId: string) => void;
}

export function EpicsView({
  state,
  project,
  apiDeps,
  onTaskSaved,
  onOpenTicket,
}: EpicsViewProps): JSX.Element {
  const styles = useStyles();
  const [creating, setCreating] = useState(false);

  const tasks = useMemo(() => selectBacklogTasks(state, project.id), [state, project.id]);
  const epics = useMemo(() => backlogEpics(tasks), [tasks]);
  const unfiled = useMemo(
    () => tasks.filter((t) => t.issueType !== 'epic' && !t.epicTaskId),
    [tasks],
  );

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title3>Epics</Title3>
        {project.kind === 'ticket' && (
          <Button appearance="primary" icon={<AddRegular />} onClick={() => setCreating(true)}>
            New epic…
          </Button>
        )}
      </div>

      {epics.length === 0 ? (
        <Caption1 className={styles.empty}>No epics on this project yet.</Caption1>
      ) : (
        epics.map((epic) => {
          const children = epicChildren(tasks, epic.id);
          const progress = epicProgress(children);
          return (
            <div key={epic.id} className={styles.group}>
              <div className={styles.groupHead}>
                <div className={styles.groupHeadRow}>
                  <TicketRow task={epic} onOpen={onOpenTicket} />
                </div>
                <Caption1 className={styles.progress}>
                  {progress.done}/{progress.total}
                </Caption1>
              </div>
              <div className={styles.children}>
                {children.length === 0 ? (
                  <Caption1 className={styles.empty}>No tickets under this epic yet.</Caption1>
                ) : (
                  children.map((task) => (
                    <TicketRow key={task.id} task={task} onOpen={onOpenTicket} />
                  ))
                )}
              </div>
            </div>
          );
        })
      )}

      {unfiled.length > 0 && (
        <div className={styles.group}>
          <Subtitle2>No epic</Subtitle2>
          <div className={styles.children}>
            {unfiled.map((task) => (
              <TicketRow key={task.id} task={task} onOpen={onOpenTicket} />
            ))}
          </div>
        </div>
      )}

      {project.kind === 'ticket' && (
        <TicketFormDialog
          open={creating}
          projectId={project.id}
          issueType="epic"
          epics={epics}
          apiDeps={apiDeps}
          onClose={() => setCreating(false)}
          onCreated={onTaskSaved}
        />
      )}
    </div>
  );
}
