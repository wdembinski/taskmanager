/**
 * `/projects/:projectId` — the same `BoardScreen` My Tasks renders (`App.tsx`'s `/tasks`),
 * pointed at a different project's queue, under the tab bar (`ProjectShell`) that also
 * reaches the Backlog and Epics views of the same project.
 */
import type { ManualStatus } from '@tm/shared/model';
import { BoardScreen } from '../board/BoardScreen';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { ProjectShell } from './ProjectShell';

export interface ProjectBoardRouteProps {
  state: CloudBoardState;
  everSeenClient: boolean;
  onSetStatus: (taskId: string, status: ManualStatus) => void;
  onStatusNoted: (taskId: string, status: ManualStatus) => void;
}

export function ProjectBoardRoute({
  state,
  everSeenClient,
  onSetStatus,
  onStatusNoted,
}: ProjectBoardRouteProps): JSX.Element {
  return (
    <ProjectShell state={state} active="board">
      {(project) => (
        <BoardScreen
          state={state}
          projectId={project.id}
          projectName={project.name}
          everSeenClient={everSeenClient}
          onSetStatus={onSetStatus}
          onStatusNoted={onStatusNoted}
        />
      )}
    </ProjectShell>
  );
}
