/**
 * `/projects/:projectId/tickets/:ticketId` — the dedicated ticket page (`TicketDetailPage`)
 * under the project's tab bar, one level below the Backlog/Epics rows that link to it.
 */
import { Caption1, makeStyles } from '@fluentui/react-components';
import { useNavigate, useParams } from 'react-router-dom';
import type { Task } from '@tm/shared/model';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { backlogEpics, selectBacklogTasks } from './backlogSelectors';
import { ProjectShell } from './ProjectShell';
import { TicketDetailPage } from './TicketDetailPage';
import type { ProjectsApiDeps } from './projectsApi';

const useStyles = makeStyles({
  empty: { padding: '8px 4px' },
});

export interface TicketDetailRouteProps {
  state: CloudBoardState;
  apiDeps: ProjectsApiDeps;
  onTaskSaved: (task: Task) => void;
}

export function TicketDetailRoute({
  state,
  apiDeps,
  onTaskSaved,
}: TicketDetailRouteProps): JSX.Element {
  const styles = useStyles();
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();

  return (
    <ProjectShell state={state} active="backlog">
      {(project) => {
        const task = ticketId ? state.tasks[ticketId] : undefined;
        if (!task || task.projectId !== project.id) {
          return (
            <Caption1 className={styles.empty}>
              This ticket isn&rsquo;t on this project, or hasn&rsquo;t synced down yet.
            </Caption1>
          );
        }
        const epics = backlogEpics(selectBacklogTasks(state, project.id));
        return (
          <TicketDetailPage
            task={task}
            epics={epics}
            apiDeps={apiDeps}
            onSaved={onTaskSaved}
            onBack={() => navigate(`/projects/${project.id}/backlog`)}
          />
        );
      }}
    </ProjectShell>
  );
}
