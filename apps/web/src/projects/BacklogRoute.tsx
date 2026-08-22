/** `/projects/:projectId/backlog` — `BacklogView` under the project's tab bar. */
import { useNavigate } from 'react-router-dom';
import type { Task } from '@tm/shared/model';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { BacklogView } from './BacklogView';
import { ProjectShell } from './ProjectShell';
import type { ProjectsApiDeps } from './projectsApi';

export interface BacklogRouteProps {
  state: CloudBoardState;
  apiDeps: ProjectsApiDeps;
  onTaskSaved: (task: Task) => void;
}

export function BacklogRoute({ state, apiDeps, onTaskSaved }: BacklogRouteProps): JSX.Element {
  const navigate = useNavigate();
  return (
    <ProjectShell state={state} active="backlog">
      {(project) => (
        <BacklogView
          state={state}
          project={project}
          apiDeps={apiDeps}
          onTaskSaved={onTaskSaved}
          onOpenTicket={(taskId) => navigate(`/projects/${project.id}/tickets/${taskId}`)}
        />
      )}
    </ProjectShell>
  );
}
