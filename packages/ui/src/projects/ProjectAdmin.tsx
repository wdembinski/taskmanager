/**
 * ProjectAdmin — the browser's Projects tab: the list of every project, and the drawer that
 * adds or edits one.
 *
 * The shared half of what the desktop's own admin pane
 * (`apps/client/src/renderer/src/projects/Projects.tsx`) draws — the same two-part shape (a
 * `Card` per row, an `OverlayDrawer` form) over the same `project:*` transport calls — but with
 * everything about a REPO cut away: no folder field, no "Runs on" target picker, no
 * `BaseBranchField`, no models, no permission mode, no JIRA epics. A repo is configured on the
 * desktop client that owns the folder it points at — that machine is the only one that can
 * browse it, run git against it or execute an agent in it — so this drawer never sends `path`,
 * `target`, `baseBranch`, `defaultModel`, `planningModel`, `defaultPermissionMode` or
 * `jiraEpicKeys`, and never opens a native folder picker. `test/shell-parity.test.ts` asserts
 * this structurally rather than trusting the comment.
 *
 * What IS shared with every host, because it is nothing but a row in the store: a project's
 * name, its colour, and the tickets-or-personal choice `ProjectBasicsFields` draws — so a
 * browser can create a ticket project, rename one, or flip a project between Personal and its
 * own ticket board, exactly as the desktop can. Editing a project that already has a repo is
 * the same form; the repo itself just isn't part of it, and the list shows that project's path
 * read-only, since a browser can see what is configured even though it cannot set it.
 *
 * `project:add` still forces `path: ''` / `planPath: ''`, the same as it always has: this
 * drawer creates a repo-less project. Turning one into a repo project happens on the desktop
 * that will run it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  OverlayDrawer,
  Subtitle2,
  Text,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { hasRepo, ownsTickets, type Project } from '@tm/shared/model';
import { PaneLoading } from '../PaneLoading';
import { useInitialLoad } from '../useInitialLoad';
import { useTransport } from '../transport';
import { ProjectBasicsFields } from './ProjectBasicsFields';
import { ticketPrefixError, ticketModeOf, type TicketMode } from './projectBasics';

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: '16px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { padding: '4px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  prefix: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground3,
  },
  path: { color: tokens.colorNeutralForeground3, fontFamily: 'ui-monospace, Consolas, monospace' },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '380px' },
});

export function ProjectAdmin(): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; project?: Project }>({ open: false });

  const refresh = useCallback(async () => {
    const all = await transport.invoke('project:list');
    setProjects(all.map((p) => p.project));
  }, [transport]);
  const initial = useInitialLoad(refresh);

  async function remove(project: Project): Promise<void> {
    setError(null);
    try {
      await transport.invoke('project:remove', project.id);
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
        Every project the board knows about. Give one its own key prefix to file and number tickets
        under it, or leave it Personal and use it purely to group cards. A project&apos;s
        repository, execution target and models are configured on the desktop client that owns that
        folder — this pane manages everything else.
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
                        <Badge appearance="tint" color="informative" className={styles.prefix}>
                          {project.ticketPrefix}
                        </Badge>
                      )}
                    </div>
                    {/* Read-only: a browser can see what a repo project is configured with
                        even though it cannot set any of it — see the file header. */}
                    {hasRepo(project) && (
                      <Caption1 className={styles.path}>{project.path}</Caption1>
                    )}
                    {!ownsTickets(project) && (
                      <Caption1 className={styles.hint}>
                        Personal space — no tickets of its own.
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
            </Card>
          ))}
        </div>
      )}

      <ProjectDialog
        open={dialog.open}
        project={dialog.project}
        projects={projects}
        onClose={() => setDialog({ open: false })}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

interface ProjectDialogProps {
  open: boolean;
  /** The project being edited; absent means "add". */
  project?: Project;
  /** Every other project, so a chosen ticket prefix can be checked against theirs. */
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}

/** Add / edit drawer — `ProjectBasicsFields` and nothing about a repo. See the file header. */
function ProjectDialog({
  open,
  project,
  projects,
  onClose,
  onSaved,
}: ProjectDialogProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<TicketMode>('personal');
  const [ticketPrefix, setTicketPrefix] = useState('');
  const [color, setColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form each time it opens — from the project when editing, blank when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(project?.name ?? '');
    setMode(project ? ticketModeOf(project) : 'personal');
    setTicketPrefix(project?.ticketPrefix ?? '');
    setColor(project?.color ?? '');
  }, [open, project]);

  const prefixError = ticketPrefixError({
    mode,
    prefix: ticketPrefix,
    projects,
    editingId: project?.id,
  });

  async function save(): Promise<void> {
    if (prefixError) {
      setError(prefixError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (project) {
        const updated = await transport.invoke('project:update', project.id, {
          name: name.trim() || undefined,
          ticketPrefix: mode === 'tickets' ? ticketPrefix : '',
          color,
        });
        if (!updated) throw new Error('That project no longer exists.');
      } else {
        await transport.invoke('project:add', {
          // A project created from a browser has no folder — the store forces `path`/
          // `planPath` to `''` regardless of what is sent, but both default to `''` here for
          // clarity, and neither this call nor the update above ever sends `target`,
          // `baseBranch`, `defaultModel`, `planningModel`, `defaultPermissionMode` or
          // `jiraEpicKeys`: those are configured on the desktop client that owns the repo.
          path: '',
          planPath: '',
          name: name.trim() || undefined,
          ticketPrefix: mode === 'tickets' ? ticketPrefix : '',
          color,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <OverlayDrawer
      open={open}
      position="end"
      size="medium"
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Close"
              onClick={onClose}
            />
          }
        >
          {project ? 'Edit project' : 'Add project'}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.form}>
          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          <ProjectBasicsFields
            name={name}
            onNameChange={setName}
            mode={mode}
            onModeChange={setMode}
            ticketPrefix={ticketPrefix}
            onTicketPrefixChange={setTicketPrefix}
            color={color}
            onColorChange={setColor}
            projects={projects}
            editingId={project?.id}
            hasIssuedTickets={Boolean(project && ownsTickets(project))}
          />

          {project && hasRepo(project) && (
            <Field label="Repository folder">
              <Input value={project.path} readOnly className={styles.path} />
              <Caption1 className={styles.hint}>
                Set on the desktop client that owns this folder, along with its execution target,
                models and permission mode — not editable from here.
              </Caption1>
            </Field>
          )}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button appearance="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          appearance="primary"
          onClick={() => void save()}
          disabled={saving || Boolean(prefixError)}
        >
          {project ? 'Save' : 'Add project'}
        </Button>
      </DrawerFooter>
    </OverlayDrawer>
  );
}
