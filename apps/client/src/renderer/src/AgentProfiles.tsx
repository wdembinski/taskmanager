/**
 * Agent profiles pane (Settings → Agent profiles).
 *
 * A reusable run configuration (`@shared/agent`'s own docstring has the full
 * "profile + assignment queue, not `agentProjectId`" story) a ticket can be queued
 * against — from the web fleet view, or a ticket's own "assign to an agent" picker,
 * once one of those exists. A profile has no local row of its own: it lives on the
 * cloud server only, so this pane talks to it over the plain REST calls in
 * `agentProfilesApi.ts` (relayed through IPC) rather than the local SQLite store —
 * the same list every desktop and the web app's Fleet view read.
 *
 * `AgentProfile.defaultProjectId` names one of the ordinary projects `project:list`
 * already returns (there is no separate "agent project" list any more — the
 * single-board refactor folded that distinction away), so this pane's default-project
 * picker reads the same channel every other project picker in this app does.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Dropdown,
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Option,
  OverlayDrawer,
  Subtitle2,
  Text,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import { MODELS, type Project } from '@shared/model';
import type { AgentProfile } from '@shared/agent';
import { PaneLoading } from '@ui/PaneLoading';
import { useInitialLoad } from '@ui/useInitialLoad';

const useStyles = makeStyles({
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '520px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: { padding: '4px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  cardActions: { display: 'flex', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  row: { display: 'flex', gap: '8px' },
  grow: { flex: 1 },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

/** The dropdown's "no default project" option — distinct from any real project id. */
const NO_PROJECT = '__none__';

export function AgentProfiles(): JSX.Element {
  const styles = useStyles();
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; profile?: AgentProfile }>({
    open: false,
  });

  const refresh = useCallback(async () => {
    const [loadedProfiles, projectsWithTasks] = await Promise.all([
      window.api.invoke('agentProfile:list'),
      window.api.invoke('project:list'),
    ]);
    setProfiles(loadedProfiles);
    setProjects(projectsWithTasks.map((p) => p.project));
  }, []);

  const initial = useInitialLoad(refresh);

  async function remove(profile: AgentProfile): Promise<void> {
    setError(null);
    try {
      await window.api.invoke('agentProfile:remove', profile.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!profiles) {
    return (
      <PaneLoading
        label="Loading agent profiles…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  function projectName(id: string | null): string | null {
    if (!id) return null;
    return projects.find((p) => p.id === id)?.name ?? id;
  }

  return (
    <div className={styles.pane}>
      <Subtitle2>Agent profiles</Subtitle2>
      <Body1 className={styles.hint}>
        Reusable run configurations a ticket can be queued against — from the web fleet view, or a
        ticket&apos;s own assign-to-an-agent picker. A profile lives on the cloud server, not on
        this machine, so it&apos;s the same list every desktop and the web app see.
      </Body1>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div>
        <Button appearance="primary" onClick={() => setDialog({ open: true })}>
          Add agent profile
        </Button>
      </div>

      {profiles.length === 0 ? (
        <Body1 className={styles.hint}>No agent profiles yet.</Body1>
      ) : (
        <div className={styles.list}>
          {profiles.map((profile) => {
            const defaultProject = projectName(profile.defaultProjectId);
            return (
              <Card key={profile.id} className={styles.card}>
                <CardHeader
                  header={
                    <div className={styles.headerText}>
                      <Text weight="semibold">{profile.name}</Text>
                      <Caption1 className={styles.hint}>
                        {profile.model} · {PERMISSION_MODE_LABELS[profile.permissionMode]}
                        {defaultProject ? ` · ${defaultProject}` : ''}
                      </Caption1>
                    </div>
                  }
                  action={
                    <div className={styles.cardActions}>
                      <Button size="small" onClick={() => setDialog({ open: true, profile })}>
                        Edit
                      </Button>
                      <Button size="small" onClick={() => void remove(profile)}>
                        Remove
                      </Button>
                    </div>
                  }
                />
              </Card>
            );
          })}
        </div>
      )}

      <AgentProfileDialog
        open={dialog.open}
        profile={dialog.profile}
        projects={projects}
        onClose={() => setDialog({ open: false })}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

interface AgentProfileDialogProps {
  open: boolean;
  /** The profile being edited; absent means "add". */
  profile?: AgentProfile;
  /** Ticket projects, for the default-project picker. */
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}

function AgentProfileDialog({
  open,
  profile,
  projects,
  onClose,
  onSaved,
}: AgentProfileDialogProps): JSX.Element {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [model, setModel] = useState<ClaudeModel>('sonnet');
  const [permMode, setPermMode] = useState<PermissionMode>('acceptEdits');
  const [defaultProjectId, setDefaultProjectId] = useState<string>(NO_PROJECT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed each time it opens — from the profile when editing, blank defaults when adding.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (profile) {
      setName(profile.name);
      setModel(profile.model);
      setPermMode(profile.permissionMode);
      setDefaultProjectId(profile.defaultProjectId ?? NO_PROJECT);
    } else {
      setName('');
      setModel('sonnet');
      setPermMode('acceptEdits');
      setDefaultProjectId(NO_PROJECT);
    }
  }, [open, profile]);

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give this profile a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const defaultProject = defaultProjectId === NO_PROJECT ? null : defaultProjectId;
      if (profile) {
        await window.api.invoke('agentProfile:update', profile.id, {
          name: trimmed,
          model,
          permissionMode: permMode,
          defaultProjectId: defaultProject,
        });
      } else {
        await window.api.invoke('agentProfile:add', {
          name: trimmed,
          model,
          permissionMode: permMode,
          defaultProjectId: defaultProject,
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

  const selectedProject = projects.find((p) => p.id === defaultProjectId) ?? null;

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
          {profile ? 'Edit agent profile' : 'Add agent profile'}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.form}>
          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          <Field label="Name" required>
            <Input value={name} onChange={(_e, d) => setName(d.value)} placeholder="Reviewer" />
          </Field>

          <div className={styles.row}>
            <Field label="Model" className={styles.grow}>
              <Dropdown
                className={styles.grow}
                value={model}
                selectedOptions={[model]}
                onOptionSelect={(_e, d) => setModel(d.optionValue as ClaudeModel)}
              >
                {MODELS.map((m) => (
                  <Option key={m} value={m}>
                    {m}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Permission mode" className={styles.grow}>
              <Dropdown
                className={styles.grow}
                value={PERMISSION_MODE_LABELS[permMode]}
                selectedOptions={[permMode]}
                onOptionSelect={(_e, d) => setPermMode(d.optionValue as PermissionMode)}
              >
                {MODES.map((m) => (
                  <Option key={m} value={m}>
                    {PERMISSION_MODE_LABELS[m]}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>

          <Field
            label="Default project"
            hint="Which project an assignment queued against this profile belongs to, when nothing else says otherwise."
          >
            <Dropdown
              value={selectedProject?.name ?? 'None'}
              selectedOptions={[defaultProjectId]}
              onOptionSelect={(_e, d) => d.optionValue && setDefaultProjectId(d.optionValue)}
            >
              <Option value={NO_PROJECT}>None</Option>
              {projects.map((p) => (
                <Option key={p.id} value={p.id}>
                  {p.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button appearance="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button appearance="primary" onClick={() => void save()} disabled={saving}>
          {profile ? 'Save' : 'Add agent profile'}
        </Button>
      </DrawerFooter>
    </OverlayDrawer>
  );
}
