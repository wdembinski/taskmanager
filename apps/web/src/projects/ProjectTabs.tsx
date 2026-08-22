/**
 * The sub-nav a project's own screens share: Board (the Kanban, `ProjectBoardRoute`),
 * Backlog (`BacklogRoute`) and Epics (`EpicsRoute`) — JIRA's own three, minus Sprints,
 * which this app has no concept of outside the JIRA-mirrored `currentSprintOnly` toggle.
 *
 * A `TabList` rather than three `NavRail` tiles: these are views of the SAME project, not
 * separate destinations — the rail already answers "which project", and this answers
 * "which view of it", one level down.
 */
import { Tab, TabList, makeStyles } from '@fluentui/react-components';
import { useNavigate } from 'react-router-dom';

const useStyles = makeStyles({
  root: { padding: '8px 12px 0' },
});

export type ProjectTab = 'board' | 'backlog' | 'epics';

const TAB_PATH: Record<ProjectTab, (projectId: string) => string> = {
  board: (projectId) => `/projects/${projectId}`,
  backlog: (projectId) => `/projects/${projectId}/backlog`,
  epics: (projectId) => `/projects/${projectId}/epics`,
};

export interface ProjectTabsProps {
  projectId: string;
  active: ProjectTab;
}

export function ProjectTabs({ projectId, active }: ProjectTabsProps): JSX.Element {
  const styles = useStyles();
  const navigate = useNavigate();
  return (
    <div className={styles.root}>
      <TabList
        size="small"
        selectedValue={active}
        onTabSelect={(_e, data) => navigate(TAB_PATH[data.value as ProjectTab](projectId))}
      >
        <Tab value="board">Board</Tab>
        <Tab value="backlog">Backlog</Tab>
        <Tab value="epics">Epics</Tab>
      </TabList>
    </div>
  );
}
