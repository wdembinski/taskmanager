/**
 * Projects screen (nav rail) — the one place a project is created and edited.
 *
 * A project here is whatever it needs to be: a bare repo an agent can work in, a
 * ticket-owning backlog with no folder at all, or both at once — capabilities are
 * derived from which fields are set (`hasRepo`/`ownsTickets` in `@shared/model`)
 * rather than picked from a `kind`. This screen replaces the old Settings → Agents
 * pane (`AgentProjects.tsx`, gone) now that a project is a first-class nav item
 * rather than something folded into settings.
 *
 * Every project `project:list` returns lands here — including one that predates
 * this screen and still carries a `plan.md` (`hasPlan`), which just means the
 * repo-only fields below apply to it exactly as they do to any other repo.
 */
import { useCallback, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Subtitle2,
  Text,
  tokens,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { Project } from '@shared/model';
import { LOCAL_TARGET, type ExecTarget } from '@shared/execTarget';
import { pathSuitsHost } from '@shared/wslPath';
import { useGitPreflight } from '../useGitPreflight';
import { modelCaption } from '@ui/modelChoice';
import { PaneLoading } from '@ui/PaneLoading';
import { ProjectForm } from '@ui/projects/ProjectForm';
import { useInitialLoad } from '@ui/useInitialLoad';

const useStyles = makeStyles({
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '760px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: { padding: '4px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  /** The project's board colour, so the list reads the way the board does. */
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  path: { color: tokens.colorNeutralForeground3, fontFamily: 'ui-monospace, Consolas, monospace' },
  epics: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

export function Projects(): JSX.Element {
  const styles = useStyles();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; project?: Project }>({ open: false });
  // Echoed up from `ProjectForm` (which owns the form's path/target state) on every change,
  // so `useGitPreflight` — host-only, since it calls `window.api` directly — has a current
  // value to run against. See `ProjectForm`'s own header for why this cannot live there.
  const [folder, setFolder] = useState<{ path: string; target: ExecTarget }>({
    path: '',
    target: LOCAL_TARGET,
  });
  const targetMismatch = !pathSuitsHost(
    folder.path,
    folder.target.kind === 'wsl' ? 'linux' : 'windows',
  );
  const preflight = useGitPreflight(folder.path, folder.target, dialog.open && !targetMismatch);

  const refresh = useCallback(async () => {
    const all = await window.api.invoke('project:list');
    setProjects(all.map((p) => p.project));
  }, []);

  const initial = useInitialLoad(refresh);

  async function remove(project: Project): Promise<void> {
    setError(null);
    try {
      await window.api.invoke('project:remove', project.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!projects) {
    return (
      <PaneLoading
        label="Loading projects…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  return (
    <div className={styles.pane}>
      <Subtitle2>Projects</Subtitle2>
      <Body1 className={styles.hint}>
        Every project the board knows about. Attach a repository so an agent can work a card&apos;s
        tickets, or leave one bare and use it purely to file and number tickets. Link the JIRA epics
        a repo owns and a ticket under one of them is assigned there automatically.
      </Body1>

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
        <Body1 className={styles.hint}>No projects yet.</Body1>
      ) : (
        <div className={styles.list}>
          {projects.map((project) => (
            <Card key={project.id} className={styles.card}>
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
                        <Badge appearance="tint" color="brand">
                          {project.ticketPrefix}
                        </Badge>
                      )}
                    </div>
                    {project.path ? (
                      <>
                        <Caption1 className={styles.path}>{project.path}</Caption1>
                        <Caption1 className={styles.hint}>
                          {modelCaption(project)} ·{' '}
                          {PERMISSION_MODE_LABELS[project.defaultPermissionMode]}
                        </Caption1>
                      </>
                    ) : (
                      <Caption1 className={styles.hint}>
                        No repository — files and numbers tickets only.
                      </Caption1>
                    )}
                  </div>
                }
                action={
                  <div className={styles.cardActions}>
                    <Button size="small" onClick={() => setDialog({ open: true, project })}>
                      Edit
                    </Button>
                    <Button size="small" onClick={() => void remove(project)}>
                      Remove
                    </Button>
                  </div>
                }
              />
              {project.jiraEpicKeys.length > 0 && (
                <div className={styles.epics}>
                  {project.jiraEpicKeys.map((key) => (
                    <Badge key={key} appearance="tint" color="informative">
                      {key}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <ProjectForm
        open={dialog.open}
        project={dialog.project}
        projects={projects}
        onClose={() => setDialog({ open: false })}
        onSaved={() => void refresh()}
        repo={{ onBrowseFolder: () => window.api.invoke('project:pickDirectory') }}
        gitPreflight={preflight}
        onFolderChange={(path, target) => setFolder({ path, target })}
      />
    </div>
  );
}
