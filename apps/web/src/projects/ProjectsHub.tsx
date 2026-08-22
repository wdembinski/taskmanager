/**
 * The multi-project landing page — every project on the account, GitHub's own repo-list
 * shape: one row per project, its kind, what it holds, when it last moved, and a click
 * through to its board. `App.tsx`'s My Tasks tile stays the Personal board's own shortcut;
 * this is everything else `state.projects` carries (`projectSelectors.selectHubProjects`).
 *
 * Reading is free — the mirror already carries every project (`useCloudBoard`'s poll), so
 * there is nothing to fetch here. Writing a `kind: 'ticket'` project is the one act this
 * step gives the web a form for (`ProjectFormDialog`, over `projectsApi.ts`); `plan` and
 * `agent` rows render read-only, the same boundary `test/shell-parity.test.ts` asserts.
 */
import { useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Subtitle1,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, EditRegular } from '@fluentui/react-icons';
import type { Project, ProjectKind } from '@tm/shared/model';
import { removedAgo } from '@tm/ui/board/ArchivedCardsDialog';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { ProjectFormDialog } from './ProjectFormDialog';
import { projectStats, selectHubProjects } from './projectSelectors';
import type { ProjectsApiDeps } from './projectsApi';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', minHeight: 0 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  hint: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', flex: 1 },
  row: { padding: '4px', cursor: 'pointer' },
  rowHeader: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' },
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  name: { flex: 1, minWidth: 0 },
  meta: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '2px' },
  empty: { padding: '8px 4px' },
});

const KIND_LABEL: Record<ProjectKind, string> = {
  ticket: 'Ticket project',
  agent: 'Agent project',
  plan: 'Plan project',
};

export interface ProjectsHubProps {
  state: CloudBoardState;
  apiDeps: ProjectsApiDeps;
  onOpenProject: (projectId: string) => void;
  onProjectSaved: (project: Project) => void;
}

export function ProjectsHub({
  state,
  apiDeps,
  onOpenProject,
  onProjectSaved,
}: ProjectsHubProps): JSX.Element {
  const styles = useStyles();
  const [dialog, setDialog] = useState<{ open: boolean; project: Project | null }>({
    open: false,
    project: null,
  });

  const projects = useMemo(() => selectHubProjects(state), [state]);
  const now = useMemo(() => Date.now(), []);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title3>Projects</Title3>
        <Button
          appearance="primary"
          icon={<AddRegular />}
          onClick={() => setDialog({ open: true, project: null })}
        >
          New ticket project
        </Button>
      </div>
      <Body1 className={styles.hint}>
        Every project on the account. Ticket projects can be made and renamed from here; plan and
        agent projects are set up on the desktop app and just open into their board.
      </Body1>

      {projects.length === 0 ? (
        <Caption1 className={styles.empty}>
          No projects yet — create a ticket project, or add a plan or agent project from the desktop
          app.
        </Caption1>
      ) : (
        <div className={styles.list}>
          {projects.map((project) => {
            const stats = projectStats(state, project.id);
            const isTicketProject = project.kind === 'ticket';
            return (
              <Card
                key={project.id}
                className={styles.row}
                onClick={() => onOpenProject(project.id)}
              >
                <CardHeader
                  header={
                    <div className={styles.rowHeader}>
                      {project.color && (
                        <span
                          className={styles.colorDot}
                          style={{ backgroundColor: project.color }}
                        />
                      )}
                      <Subtitle1 className={styles.name}>{project.name}</Subtitle1>
                      <Badge appearance="tint" color="informative">
                        {KIND_LABEL[project.kind]}
                      </Badge>
                      {isTicketProject && (
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<EditRegular />}
                          title="Edit this project"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDialog({ open: true, project });
                          }}
                        />
                      )}
                    </div>
                  }
                  description={
                    <div className={styles.meta}>
                      {project.kind === 'agent' ? (
                        <Caption1>{stats.assignedCount} assigned</Caption1>
                      ) : (
                        <Caption1>{stats.ticketCount} tickets</Caption1>
                      )}
                      {project.ticketPrefix && (
                        <Caption1 className={styles.hint}>{project.ticketPrefix}-…</Caption1>
                      )}
                      <Caption1 className={styles.hint}>
                        {stats.lastActivityAt === null
                          ? 'No activity yet'
                          : `Active ${removedAgo(stats.lastActivityAt, now)}`}
                      </Caption1>
                    </div>
                  }
                />
              </Card>
            );
          })}
        </div>
      )}

      <ProjectFormDialog
        open={dialog.open}
        project={dialog.project}
        apiDeps={apiDeps}
        onClose={() => setDialog({ open: false, project: null })}
        onSaved={onProjectSaved}
      />
    </div>
  );
}
