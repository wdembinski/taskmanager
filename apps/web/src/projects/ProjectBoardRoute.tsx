/**
 * `/projects/:projectId` — the same `BoardScreen` My Tasks renders (`App.tsx`'s `/tasks`),
 * pointed at a different project's queue. The only thing this wrapper adds is the lookup
 * from the URL's id to the mirrored `Project` row, and the one case `BoardScreen` cannot
 * itself tell apart from an empty board: a project this account doesn't have, or one the
 * mirror hasn't delivered yet.
 */
import { Caption1, makeStyles } from '@fluentui/react-components';
import { useParams } from 'react-router-dom';
import type { ManualStatus } from '@tm/shared/model';
import { BoardScreen } from '../board/BoardScreen';
import type { CloudBoardState } from '../board/cloudBoardStore';

const useStyles = makeStyles({
  empty: { padding: '8px 4px' },
});

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
  const styles = useStyles();
  const { projectId } = useParams<{ projectId: string }>();
  const project = projectId ? state.projects[projectId] : undefined;

  if (!project) {
    return (
      <Caption1 className={styles.empty}>
        {Object.keys(state.projects).length === 0
          ? 'No board data yet — waiting on the first sync from your desktop app.'
          : "This project isn't on this account, or hasn't synced down yet."}
      </Caption1>
    );
  }

  return (
    <BoardScreen
      state={state}
      projectId={project.id}
      projectName={project.name}
      everSeenClient={everSeenClient}
      onSetStatus={onSetStatus}
      onStatusNoted={onStatusNoted}
    />
  );
}
