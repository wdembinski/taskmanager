/** `/projects/:projectId/epics` — `EpicsView` under the project's tab bar. */
import { useNavigate } from 'react-router-dom';
import type { Task } from '@tm/shared/model';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { EpicsView } from './EpicsView';
import { ProjectShell } from './ProjectShell';
import type { ProjectsApiDeps } from './projectsApi';

export interface EpicsRouteProps {
  state: CloudBoardState;
  apiDeps: ProjectsApiDeps;
  onTaskSaved: (task: Task) => void;
}

export function EpicsRoute({ state, apiDeps, onTaskSaved }: EpicsRouteProps): JSX.Element {
  const navigate = useNavigate();
  return (
    <ProjectShell state={state} active="epics">
      {(project) => (
        <EpicsView
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
