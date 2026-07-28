/**
 * Settings screen (Phase 6).
 *
 * Global preferences the engine reads at runtime: the defaults applied to newly
 * added projects (model, permission mode, plan write-back) and two scheduler knobs
 * — how many tasks a project runs at once, and how much random jitter to add
 * before resuming after a usage limit resets. Loaded from and saved to the engine
 * over the `settings:*` IPC channels; the scheduler picks up concurrency/jitter on
 * the next task, so no restart is needed.
 *
 * The vertical nav also hosts the JIRA connection and the Agents pane (the
 * repositories a My Tasks card can be delegated to), which manage their own state.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  SpinButton,
  Subtitle2,
  Switch,
  Tab,
  TabList,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import type { AppSettings, JiraSettings } from '@shared/settings';
import type { JiraConfigStatus, JiraTestResult } from '@shared/ipc';
import { isCloudHost } from '@shared/jiraUrl';
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  parseExecTarget,
} from '@shared/execTarget';
import { AgentProjects } from './AgentProjects';
import { PaneLoading } from './PaneLoading';
import { ReadinessPanel } from './ReadinessPanel';
import { useInitialLoad } from './useInitialLoad';

const useStyles = makeStyles({
  // Vertical nav on the left, scrollable content pane on the right.
  row: { display: 'flex', gap: '16px', flex: 1, minHeight: 0 },
  nav: {
    minWidth: '160px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: '8px',
  },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '520px',
    // Fill the tab body and scroll internally so long sections never get clipped.
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  grid: { display: 'flex', flexDirection: 'column', gap: '16px' },
  actions: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
});

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

type SettingsSection = 'general' | 'jira' | 'agents';

export function Settings(): JSX.Element {
  const styles = useStyles();
  const [section, setSection] = useState<SettingsSection>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [jiraStatus, setJiraStatus] = useState<JiraConfigStatus | null>(null);
  const [token, setToken] = useState('');
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<JiraTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [distros, setDistros] = useState<string[]>([]);

  // Only offer targets that exist here: with no WSL installed the control never
  // appears, so the screen stays exactly as it was.
  useEffect(() => {
    void window.api.invoke('exec:listDistros').then(setDistros);
  }, []);

  const seed = useCallback(async () => {
    const [appSettings, status] = await Promise.all([
      window.api.invoke('settings:get'),
      window.api.invoke('jira:getConfigStatus'),
    ]);
    setSettings(appSettings);
    setJiraStatus(status);
  }, []);
  const initial = useInitialLoad(seed);

  // Any edit invalidates the "Saved" confirmation.
  function patch(change: Partial<AppSettings>): void {
    setSettings((prev) => (prev ? { ...prev, ...change } : prev));
    setSaved(false);
  }

  function patchJira(change: Partial<JiraSettings>): void {
    setSettings((prev) => (prev ? { ...prev, jira: { ...prev.jira, ...change } } : prev));
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (!settings) return;
    await window.api.invoke('settings:save', settings);
    setSaved(true);
    // The main process normalizes the JIRA URL on save; re-read so the field shows
    // what was actually stored rather than what was typed.
    setSettings(await window.api.invoke('settings:get'));
    setJiraStatus(await window.api.invoke('jira:getConfigStatus'));
  }

  async function saveToken(): Promise<void> {
    // Persist the form first: the main process reads the STORED settings, so saving a
    // token against an unsaved URL/deployment used to silently pair it with stale config.
    await save();
    const res = await window.api.invoke('jira:setCredentials', token);
    setTokenMsg(res.message);
    setToken('');
    setJiraStatus(await window.api.invoke('jira:getConfigStatus'));
  }

  async function clearToken(): Promise<void> {
    await window.api.invoke('jira:clearCredentials');
    setTokenMsg('Token cleared.');
    setJiraStatus(await window.api.invoke('jira:getConfigStatus'));
  }

  async function testConnection(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      // Same reason as saveToken: the test runs against stored settings, so testing an
      // edited-but-unsaved form would report on the previous configuration.
      await save();
      setTestResult(await window.api.invoke('jira:testConnection'));
    } finally {
      setTesting(false);
    }
  }

  if (!settings) {
    return <PaneLoading label="Loading settings…" error={initial.error} onRetry={initial.retry} />;
  }

  const jira = settings.jira;
  // An *.atlassian.net site configured as Server/DC is the one misconfiguration we can
  // spot for certain, and it fails as a bare 401 that reads like a bad token. Warn on
  // the field rather than silently overriding the dropdown — a vanity-domain Cloud site
  // is indistinguishable from a self-hosted one, so the user stays in charge.
  const cloudMismatch = jira.deployment === 'server' && isCloudHost(jira.baseUrl);

  return (
    <div className={styles.row}>
      <TabList
        vertical
        selectedValue={section}
        onTabSelect={(_e, d) => setSection(d.value as SettingsSection)}
        className={styles.nav}
      >
        <Tab value="general">General</Tab>
        <Tab value="jira">JIRA</Tab>
        <Tab value="agents">Agents</Tab>
      </TabList>

      {section === 'agents' ? (
        <AgentProjects />
      ) : section === 'general' ? (
        <div className={styles.pane}>
          <Subtitle2>Settings</Subtitle2>

          <div className={styles.grid}>
            <Field label="Default model for new projects">
              <Dropdown
                value={settings.defaultModel}
                selectedOptions={[settings.defaultModel]}
                onOptionSelect={(_e, d) => patch({ defaultModel: d.optionValue as ClaudeModel })}
              >
                {MODELS.map((m) => (
                  <Option key={m} value={m}>
                    {m}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            <Field label="Default permission mode for new projects">
              <Dropdown
                value={PERMISSION_MODE_LABELS[settings.defaultPermissionMode]}
                selectedOptions={[settings.defaultPermissionMode]}
                onOptionSelect={(_e, d) =>
                  patch({ defaultPermissionMode: d.optionValue as PermissionMode })
                }
              >
                {MODES.map((m) => (
                  <Option key={m} value={m}>
                    {PERMISSION_MODE_LABELS[m]}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            <Field
              label="Default concurrency for new projects"
              hint="Seeds each new project's concurrency. Existing projects keep their own value (edit it per project). 1 = strictly one at a time."
            >
              <SpinButton
                min={1}
                max={8}
                value={settings.concurrency}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n))
                    patch({ concurrency: Math.max(1, Math.round(n as number)) });
                }}
              />
            </Field>

            <Field
              label="Auto-retry failed tasks"
              hint="How many times a failed task's agent run is retried automatically before it parks in the inbox for you to resolve. 0 = park on the first failure. Merge/integration failures always park."
            >
              <SpinButton
                min={0}
                max={5}
                value={settings.maxAutoRetries}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n))
                    patch({ maxAutoRetries: Math.max(0, Math.round(n as number)) });
                }}
              />
            </Field>

            <Field
              label="Resume jitter (seconds)"
              hint="Random delay added after a usage limit resets, before work resumes."
            >
              <SpinButton
                min={0}
                max={600}
                value={Math.round(settings.limitJitterMs / 1000)}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n))
                    patch({ limitJitterMs: Math.max(0, Math.round(n as number)) * 1000 });
                }}
              />
            </Field>

            <Field label="Plan write-back">
              <Switch
                checked={settings.writeBackPlan}
                label="Tick completed checkboxes back into a new project's plan file"
                onChange={(_e, d) => patch({ writeBackPlan: d.checked })}
              />
            </Field>

            {distros.length > 0 && (
              <Field
                label="Runs on, for new projects"
                hint="Where a newly added project executes its Claude sessions, git and worktrees. Existing projects keep their own setting — a project's folder only makes sense on the machine it was picked from."
              >
                <Dropdown
                  value={execTargetLabel(settings.defaultExecTarget)}
                  selectedOptions={[formatExecTarget(settings.defaultExecTarget)]}
                  onOptionSelect={(_e, d) =>
                    patch({ defaultExecTarget: parseExecTarget(d.optionValue) })
                  }
                >
                  <Option value="local">{execTargetLabel(LOCAL_TARGET)}</Option>
                  {distros.map((distro) => (
                    <Option key={distro} value={`wsl:${distro}`}>
                      {execTargetLabel({ kind: 'wsl', distro })}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            )}

            <ReadinessPanel target={settings.defaultExecTarget} />
          </div>

          <div className={styles.actions}>
            <Button appearance="primary" onClick={save}>
              Save
            </Button>
            {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
          </div>

          <Body1 className={styles.hint}>
            These are defaults for <strong>new</strong> projects and global scheduler knobs —
            existing projects keep their own model, mode, and write-back settings.
          </Body1>
        </div>
      ) : (
        <div className={styles.pane}>
          <Subtitle2>JIRA (My Tasks board)</Subtitle2>
          <Body1 className={styles.hint}>
            Connect JIRA to mirror your assigned issues onto the My Tasks board. Save these settings
            first, then save your token and test the connection.
          </Body1>

          <div className={styles.grid}>
            <Field label="Enable JIRA integration">
              <Switch
                checked={jira.enabled}
                label="Fetch my issues onto the board"
                onChange={(_e, d) => patchJira({ enabled: d.checked })}
              />
            </Field>

            <Field
              label="Deployment"
              hint="Self-hosted Server/Data Center uses a PAT; Cloud uses your email + an API token."
            >
              <Dropdown
                value={
                  jira.deployment === 'cloud'
                    ? 'Cloud (email + API token)'
                    : 'Server / Data Center (PAT)'
                }
                selectedOptions={[jira.deployment]}
                onOptionSelect={(_e, d) =>
                  // `apiVersion` is derived from this on the main side (jiraConfig), so
                  // it is not set here — writing it too would invite the two to disagree.
                  patchJira({ deployment: d.optionValue as JiraSettings['deployment'] })
                }
              >
                <Option value="server">Server / Data Center (PAT)</Option>
                <Option value="cloud">Cloud (email + API token)</Option>
              </Dropdown>
            </Field>

            <Field
              label="Base URL"
              hint="The site root — e.g. https://acme.atlassian.net or https://jira.company.com"
              validationState={cloudMismatch ? 'warning' : 'none'}
              validationMessage={
                cloudMismatch
                  ? 'This is an Atlassian Cloud site. Cloud rejects Server/DC tokens — set Deployment to Cloud and add your account email.'
                  : undefined
              }
            >
              <Input
                value={jira.baseUrl}
                placeholder="https://acme.atlassian.net"
                onChange={(_e, d) => patchJira({ baseUrl: d.value.trim() })}
              />
            </Field>

            {jira.deployment === 'cloud' && (
              <Field
                label="Account email"
                hint="The Atlassian account the API token belongs to — Cloud needs both."
                validationState={jira.cloudEmail.trim() ? 'none' : 'warning'}
                validationMessage={
                  jira.cloudEmail.trim()
                    ? undefined
                    : 'Required for Cloud; without it JIRA returns 401.'
                }
              >
                <Input
                  value={jira.cloudEmail}
                  placeholder="you@company.com"
                  onChange={(_e, d) => patchJira({ cloudEmail: d.value.trim() })}
                />
              </Field>
            )}

            <Field
              label="JQL"
              hint={
                jira.currentSprintOnly
                  ? 'Which issues to show. The board\'s "Current sprint" switch is on, so `AND sprint in openSprints()` is added to this query at sync time.'
                  : 'Which issues to show. Default: your unresolved, assigned issues.'
              }
            >
              <Textarea
                value={jira.jql}
                resize="vertical"
                onChange={(_e, d) => patchJira({ jql: d.value })}
              />
            </Field>

            <Field label="Done column">
              <Switch
                checked={jira.showDoneColumn}
                label="Show the Done column on the board"
                onChange={(_e, d) => patchJira({ showDoneColumn: d.checked })}
              />
            </Field>

            <Field
              label="Auto-sync interval (minutes)"
              hint="How often the board fetches new/changed JIRA issues in the background. 0 = off (the Sync button still works)."
            >
              <SpinButton
                min={0}
                max={120}
                value={jira.pollIntervalMinutes}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n))
                    patchJira({ pollIntervalMinutes: Math.max(0, Math.round(n as number)) });
                }}
              />
            </Field>

            <Field
              label={jira.deployment === 'cloud' ? 'API token' : 'Personal Access Token'}
              hint={
                jiraStatus?.encryptionAvailable === false
                  ? 'OS secure storage is unavailable on this machine — the token cannot be stored securely.'
                  : jiraStatus?.hasToken
                    ? 'A token is stored. Enter a new one to replace it.'
                    : jiraStatus?.plainTextStorage
                      ? 'No OS keyring on this machine — see the note below before saving.'
                      : 'Stored encrypted via your OS secure store; never written in plaintext.'
              }
            >
              <Input
                type="password"
                value={token}
                placeholder={jiraStatus?.hasToken ? '•••••••• (stored)' : 'Paste your token'}
                onChange={(_e, d) => setToken(d.value)}
              />
            </Field>
          </div>

          {jiraStatus?.plainTextStorage && (
            <MessageBar intent="warning">
              <MessageBarBody>
                This machine has no OS keyring (typical on WSL, a headless session, or a minimal
                desktop), so the token is stored with a fixed built-in key — obfuscated on disk, but
                readable by anyone who can read your app data. Prefer a token scoped to the minimum
                you need. To get real encryption instead, install a keyring (e.g.{' '}
                <code>gnome-keyring</code> / <code>libsecret</code>) and restart the app.
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={styles.actions}>
            <Button appearance="primary" onClick={save}>
              Save
            </Button>
            {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
          </div>

          <div className={styles.actions}>
            <Button
              appearance="secondary"
              disabled={!token.trim() || jiraStatus?.encryptionAvailable === false}
              onClick={saveToken}
            >
              Save token
            </Button>
            <Button appearance="secondary" disabled={!jiraStatus?.hasToken} onClick={clearToken}>
              Clear token
            </Button>
            <Button appearance="primary" disabled={testing} onClick={testConnection}>
              Test connection
            </Button>
            {testing && <Spinner size="tiny" />}
            {tokenMsg && <Caption1 className={styles.saved}>{tokenMsg}</Caption1>}
          </div>

          {testResult && (
            <MessageBar intent={testResult.ok ? 'success' : 'error'}>
              <MessageBarBody>{testResult.message}</MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}
    </div>
  );
}
