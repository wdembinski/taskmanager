/**
 * The lookup and empty state every `/projects/:projectId/...` screen needs, plus the tab
 * bar (`ProjectTabs`) that ties the Board, Backlog and Epics views together as one project
 * rather than three unrelated pages.
 *
 * Split out of what used to be `ProjectBoardRoute`'s own body: three more routes
 * (`BacklogRoute`, `EpicsRoute`, and `TicketDetailRoute`'s own project half) needed the
 * exact same "no such project, or it hasn't synced down yet" branch, and a copy per route
 * is how that message quietly drifts from itself.
 */
import { Caption1, makeStyles } from '@fluentui/react-components';
import { useParams } from 'react-router-dom';
import type { Project } from '@tm/shared/model';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { ProjectTabs, type ProjectTab } from './ProjectTabs';

const useStyles = makeStyles({
  empty: { padding: '8px 4px' },
  root: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
});

export interface ProjectShellProps {
  state: CloudBoardState;
  active: ProjectTab;
  /** Rendered once the project has been found — the screen itself. */
  children: (project: Project) => JSX.Element;
}

export function ProjectShell({ state, active, children }: ProjectShellProps): JSX.Element {
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
    <div className={styles.root}>
      <ProjectTabs projectId={project.id} active={active} />
      {children(project)}
    </div>
  );
}
