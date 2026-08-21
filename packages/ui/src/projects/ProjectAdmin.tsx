/**
 * ProjectAdmin — the ticket-project list, and the drawer that adds or edits one.
 *
 * The same two-part shape as the desktop's `Projects` admin pane (a `Card` per row, an
 * `OverlayDrawer` form) — embedded directly in the ticket workspace so a project can be
 * created without leaving it. The drawer itself is `ProjectForm`, the same one that pane
 * uses: whether it offers anything about a REPO — a folder field, `BaseBranchField`, a
 * "Runs on" target picker — is the host's call, not this file's, made by whether `repo` is
 * passed down (see `ProjectFormProps.repo`). A ticket project (`ownsTickets(project)`, no
 * `hasRepo`) never needs one — `path` and `planPath` are forced to `''` by the store
 * regardless of what is sent — but a host that CAN browse for a folder (the desktop) may
 * still offer to attach one here, same as its own admin pane.
 *
 * Both list and drawer go through the unified `project:*` channels — the same ones the
 * desktop's own admin pane uses — since a ticket project is simply a project with a prefix and
 * no repo, not a separate kind with its own channel set.
 *
 * Lives in `packages/ui` because both hosts manage ticket projects the same way: unlike an
 * agent project (a folder on a machine, desktop-only by decision — see `shell-parity.test.ts`),
 * a ticket project is nothing but rows in the shared store, reachable over the same relayed
 * channels either host can call.
 */
import { useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { Project } from '@tm/shared/model';
import { ProjectForm, type ProjectFormRepoCapability } from './ProjectForm';
import { useTransport } from '../transport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { padding: '4px', cursor: 'pointer' },
  cardSelected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  prefix: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground3,
  },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface ProjectAdminProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
  /** Re-read the project list — there is no `ticketProject:changed`-style push for a plain
   *  `project:*` write, so the caller re-fetches after each one, like the desktop's own
   *  admin pane does. */
  onProjectsChanged: () => void;
  /** Present only for a host that can attach a repo to a project — see `ProjectForm`'s own
   *  `repo` prop and this file's header. Absent on the web, so its drawer stays repo-free. */
  repo?: ProjectFormRepoCapability;
}

export function ProjectAdmin({
  projects,
  selectedProjectId,
  onSelect,
  onProjectsChanged,
  repo,
}: ProjectAdminProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; project?: Project }>({ open: false });

  async function remove(project: Project): Promise<void> {
    setError(null);
    try {
      await transport.invoke('project:remove', project.id);
      onProjectsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={styles.root}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Button appearance="primary" onClick={() => setDialog({ open: true })}>
          Add project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Body1 className={styles.hint}>
          No ticket projects yet — add one to start filing tickets this app tracks itself.
        </Body1>
      ) : (
        <div className={styles.list}>
          {projects.map((project) => (
            <Card
              key={project.id}
              className={
                project.id === selectedProjectId
                  ? `${styles.card} ${styles.cardSelected}`
                  : styles.card
              }
              onClick={() => onSelect(project.id)}
              selected={project.id === selectedProjectId}
            >
              <CardHeader
                header={
                  <div className={styles.headerText}>
                    <div className={styles.nameRow}>
                      {project.color && (
                        <span
                          className={styles.colorDot}
                          style={{ backgroundColor: project.color }}
                          title={`Board colour ${project.color}`}
                        />
                      )}
                      <Text weight="semibold">{project.name}</Text>
                      {project.ticketPrefix && (
                        <Badge appearance="tint" color="informative" className={styles.prefix}>
                          {project.ticketPrefix}
                        </Badge>
                      )}
                    </div>
                  </div>
                }
                action={
                  <div className={styles.cardActions}>
                    <Button
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialog({ open: true, project });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(project);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                }
              />
            </Card>
          ))}
        </div>
      )}

      <ProjectForm
        open={dialog.open}
        project={dialog.project}
        projects={projects}
        onClose={() => setDialog({ open: false })}
        onSaved={(saved) => {
          onProjectsChanged();
          onSelect(saved.id);
        }}
        repo={repo}
      />
    </div>
  );
}
