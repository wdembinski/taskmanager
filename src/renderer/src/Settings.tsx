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
 * The vertical nav also hosts the Board pane (the status keywords that colour a card's
 * progress line), the JIRA connection — including the status-name → column map, the
 * only route to the IN REVIEW column — and the Agents pane (the repositories a My Tasks
 * card can be filed under or delegated to), which manages its own state.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Combobox,
  Dropdown,
  Field,
  Input,
  Link,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Option,
  ProgressBar,
  Spinner,
  SpinButton,
  Subtitle2,
  Switch,
  Tab,
  TabList,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, DismissRegular } from '@fluentui/react-icons';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import type { AppSettings, GitLabSettings, JiraSettings, PriorityDisplay } from '@shared/settings';

/**
 * The three priority indicators, in the order they are offered. Keyed by the stored value,
 * so the dropdown's options and its current label come from one place.
 */
const PRIORITY_DISPLAY_LABELS: Record<PriorityDisplay, string> = {
  color: 'Colour square',
  mono: 'Rank glyph (no colour)',
  off: 'Don’t show it',
};
import type { BoardColumn } from '@shared/model';
import type { AppInfo, JiraConfigStatus, JiraStatusOption, JiraTestResult } from '@shared/ipc';
import { describeUpdate, type UpdateState } from '@shared/update';
import { isCloudHost } from '@shared/jiraUrl';
import { COLUMN_META, statusForColumn } from './board/boardColumns';
import { STATUS_LABEL } from './taskStatus';
import { MAPPABLE_COLUMNS, rowsToStatusMap, statusMapToRows, type StatusMapRow } from './statusMap';
import {
  execTargetLabel,
  formatExecTarget,
  LOCAL_TARGET,
  parseExecTarget,
  type ExecTarget,
} from '@shared/execTarget';
import { AgentProjects } from './AgentProjects';
import { ColorSwatches, PALETTE } from './ColorSwatches';
import { PaneLoading } from './PaneLoading';
import { ReadinessPanel } from './ReadinessPanel';
import { StatusMapViewer } from './StatusMapViewer';
import { BASE_FONT_PX, FONT_SIZE_OPTIONS } from './theme';
import { validateBranchName } from '@shared/branchName';
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
    // Full width, capped only where a line of prose stops being readable. At 520 the
    // pane was a column down the left of a wide window, and the status-map table — which
    // is the widest thing in here by far — had to wrap to fit a box half the size of the
    // space available to it.
    maxWidth: '1100px',
    width: '100%',
    // Fill the tab body and scroll internally so long sections never get clipped.
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  grid: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // The status-map editor: one row per mapping, the name growing to fill the width so
  // long workflow names ("Waiting for code review") stay readable.
  mapList: { display: 'flex', flexDirection: 'column', gap: '6px' },
  mapRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  mapName: { flex: 1, minWidth: 0 },
  mapColumn: { minWidth: '132px' },
  actions: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' },
  /** Several related switches on one line, rather than three stacked Fields. */
  switchRow: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' },
  // The update state, its progress bar and its button, stacked as one block.
  updateBlock: { display: 'flex', flexDirection: 'column', gap: '8px' },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
});

/**
 * Which machines to report readiness for: every one a project runs on, plus the
 * default for new projects (so a target you are about to use can be checked before
 * you commit to it). De-duplicated, default first.
 */
function readinessTargets(defaultTarget: ExecTarget, inUse: ExecTarget[]): ExecTarget[] {
  const byKey = new Map<string, ExecTarget>();
  for (const target of [defaultTarget, ...inUse]) byKey.set(formatExecTarget(target), target);
  return [...byKey.values()];
}

/** Where an install that can't update itself goes to fetch a new build by hand. */
const RELEASES_URL = 'https://github.com/wdembinski/taskmanager/releases';

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

/**
 * Column labels for the status-mapping dropdown. The board's own `COLUMN_META`
 * labels are shouted ("IN PROGRESS") because they head a column; in a dropdown they
 * should read as prose, and `STATUS_LABEL` already spells each one that way.
 */
const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, STATUS_LABEL[statusForColumn(c.column)]]),
) as Record<BoardColumn, string>;

type SettingsSection = 'general' | 'board' | 'jira' | 'gitlab' | 'agents';

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
  const [targetsInUse, setTargetsInUse] = useState<ExecTarget[]>([]);
  // The status map is edited as an ordered list (see `statusMap.ts`) and serialised
  // into `jira.statusCategoryOverrides` on every change, so Save carries it like any
  // other field. Seeded once from storage; never re-seeded from a save's re-read,
  // which would drop the blank row the user is part-way through filling in.
  const [statusRows, setStatusRows] = useState<StatusMapRow[]>([]);
  // The instance's own workflow statuses, so the map is picked rather than typed. Read
  // from the SAVED settings (main talks to the stored config), so it arrives once the
  // connection works and is re-read after every Save.
  const [jiraStatuses, setJiraStatuses] = useState<JiraStatusOption[]>([]);
  // Why that list is empty, when it is. An empty table with no reason is a shrug.
  const [jiraStatusError, setJiraStatusError] = useState<string | null>(null);
  // Auto-update. Kept out of `settings` on purpose: none of it is saved — it is the
  // engine's live state, seeded once and then pushed.
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  // GitLab: the same three pieces the JIRA pane keeps — config status, a write-only
  // token field, and the last test result.
  const [gitlabStatus, setGitlabStatus] = useState<JiraConfigStatus | null>(null);
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabMsg, setGitlabMsg] = useState<string | null>(null);
  const [gitlabTest, setGitlabTest] = useState<JiraTestResult | null>(null);

  // Only offer targets that exist here: with no WSL installed the control never
  // appears, so the screen stays exactly as it was.
  useEffect(() => {
    void window.api.invoke('exec:listDistros').then(setDistros);
    void window.api.invoke('exec:targetsInUse').then(setTargetsInUse);
    void window.api.invoke('app:getInfo').then(setAppInfo);
  }, []);

  useEffect(() => {
    void window.api.invoke('update:get').then(setUpdate);
    return window.api.on('update:changed', setUpdate);
  }, []);

  const seed = useCallback(async () => {
    const [appSettings, status] = await Promise.all([
      window.api.invoke('settings:get'),
      window.api.invoke('jira:getConfigStatus'),
    ]);
    setSettings(appSettings);
    setStatusRows(statusMapToRows(appSettings.jira.statusCategoryOverrides));
    setJiraStatus(status);
    setGitlabStatus(await window.api.invoke('gitlab:getConfigStatus'));
    void loadJiraStatuses();
  }, []);

  function patchGitLab(change: Partial<GitLabSettings>): void {
    setSettings((prev) => (prev ? { ...prev, gitlab: { ...prev.gitlab, ...change } } : prev));
    setSaved(false);
  }

  async function saveGitLabToken(): Promise<void> {
    // Save the form first, exactly as the JIRA path does: main reads the STORED
    // settings, so a token saved against an unsaved URL would be paired with stale
    // config and fail in a way that looks like a bad token.
    await save();
    const res = await window.api.invoke('gitlab:setCredentials', gitlabToken);
    setGitlabMsg(res.message);
    setGitlabToken('');
    setGitlabStatus(await window.api.invoke('gitlab:getConfigStatus'));
  }

  async function clearGitLabToken(): Promise<void> {
    await window.api.invoke('gitlab:clearCredentials');
    setGitlabMsg('Token cleared.');
    setGitlabStatus(await window.api.invoke('gitlab:getConfigStatus'));
  }

  async function testGitLab(): Promise<void> {
    setGitlabTest(null);
    setGitlabTest(await window.api.invoke('gitlab:testConnection'));
  }

  /** Fetch the instance's statuses. Fails soft — the field stays typeable regardless. */
  async function loadJiraStatuses(): Promise<void> {
    try {
      const list = await window.api.invoke('jira:statuses');
      setJiraStatuses(list.statuses);
      setJiraStatusError(list.error);
    } catch (e) {
      setJiraStatuses([]);
      setJiraStatusError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Promote a resolved row into the explicit map. Replaces any row for the same name
   * (mapping a name twice does nothing — the later row would win anyway) rather than
   * appending a duplicate the user then has to clean up.
   */
  function pinStatus(name: string, column: BoardColumn): void {
    const others = statusRows.filter((r) => r.name.trim().toLowerCase() !== name.toLowerCase());
    patchStatusRows([...others, { name, column }]);
  }

  /**
   * What to offer under a half-typed status name: the instance's statuses, minus the
   * ones already mapped on another row (mapping the same name twice does nothing — the
   * later row wins), narrowed by what has been typed so far. The row's OWN current
   * value is kept, so the box doesn't empty itself the moment it matches.
   */
  function suggestionsFor(current: string): JiraStatusOption[] {
    const taken = new Set(
      statusRows
        .map((r) => r.name.trim().toLowerCase())
        .filter((n) => n && n !== current.trim().toLowerCase()),
    );
    const typed = current.trim().toLowerCase();
    return jiraStatuses.filter(
      (s) => !taken.has(s.name.toLowerCase()) && (!typed || s.name.toLowerCase().includes(typed)),
    );
  }
  const initial = useInitialLoad(seed);

  // The engine writes one field of its own — the status→column map it learns from a
  // successful drag — and this screen saves the WHOLE settings blob, so without taking
  // that field back the next Save would write a stale copy over it. Only that field is
  // merged: replacing the blob outright would throw away whatever is half-typed here.
  useEffect(() => {
    return window.api.on('settings:changed', (next) => {
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              jira: {
                ...prev.jira,
                learnedStatusColumns: next.jira.learnedStatusColumns,
                lastCreateProjectKey: next.jira.lastCreateProjectKey,
                lastCreateIssueTypeId: next.jira.lastCreateIssueTypeId,
              },
            }
          : prev,
      );
    });
  }, []);

  /**
   * The prefix is a path segment of a real git ref, so it is validated with the same
   * rules the branch itself gets — against a sample name, because a bare prefix is not a
   * ref and `validateBranchName` rightly rejects one.
   */
  const prefixError = ((): string | null => {
    const raw = settings?.branchPrefix.trim() ?? '';
    if (!raw) return null;
    const check = validateBranchName(`${raw.replace(/^\/+|\/+$/g, '')}/feat/sample`);
    return check.ok ? null : `That prefix won't work: ${check.reason}.`;
  })();

  // Any edit invalidates the "Saved" confirmation.
  function patch(change: Partial<AppSettings>): void {
    setSettings((prev) => (prev ? { ...prev, ...change } : prev));
    setSaved(false);
  }

  function patchJira(change: Partial<JiraSettings>): void {
    setSettings((prev) => (prev ? { ...prev, jira: { ...prev.jira, ...change } } : prev));
    setSaved(false);
  }

  /** Edit the status-map rows and mirror them into the settings blob in one step. */
  function patchStatusRows(next: StatusMapRow[]): void {
    setStatusRows(next);
    patchJira({ statusCategoryOverrides: rowsToStatusMap(next) });
  }

  async function save(): Promise<void> {
    if (!settings) return;
    await window.api.invoke('settings:save', settings);
    setSaved(true);
    // The main process normalizes the JIRA URL on save; re-read so the field shows
    // what was actually stored rather than what was typed.
    setSettings(await window.api.invoke('settings:get'));
    setJiraStatus(await window.api.invoke('jira:getConfigStatus'));
    // A save may be the moment the connection first works (or points somewhere new),
    // so this is when an empty status list is worth retrying.
    await loadJiraStatuses();
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
  const gitlab = settings.gitlab;
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
        <Tab value="board">Board</Tab>
        <Tab value="jira">JIRA</Tab>
        <Tab value="gitlab">GitLab</Tab>
        <Tab value="agents">Agents</Tab>
      </TabList>

      {section === 'agents' ? (
        <AgentProjects />
      ) : section === 'board' ? (
        <div className={styles.pane}>
          <Subtitle2>Board</Subtitle2>
          <Body1 className={styles.hint}>
            How the My Tasks board reads. Status updates you post on a card show as one line on it —
            give the words you use most a colour, and a column tells you where everything stands
            without opening anything.
          </Body1>

          <div className={styles.grid}>
            <Field
              label="Status keywords"
              hint="A status update containing one of these takes its colour. The first match in this list wins, so put the one that matters most at the top. An update matching nothing reads in the card's ordinary colour."
            >
              <div className={styles.mapList}>
                {settings.statusKeywords.map((k, i) => (
                  <div key={i} className={styles.mapRow}>
                    <Input
                      className={styles.mapName}
                      value={k.keyword}
                      placeholder="Word to look for, e.g. blocked"
                      onChange={(_e, d) =>
                        patch({
                          statusKeywords: settings.statusKeywords.map((x, j) =>
                            j === i ? { ...x, keyword: d.value } : x,
                          ),
                        })
                      }
                    />
                    <ColorSwatches
                      value={k.color}
                      onChange={(color) =>
                        patch({
                          statusKeywords: settings.statusKeywords.map((x, j) =>
                            j === i ? { ...x, color } : x,
                          ),
                        })
                      }
                    />
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DismissRegular />}
                      title="Remove this keyword"
                      onClick={() =>
                        patch({
                          statusKeywords: settings.statusKeywords.filter((_x, j) => j !== i),
                        })
                      }
                    />
                  </div>
                ))}
                <div>
                  <Button
                    size="small"
                    icon={<AddRegular />}
                    onClick={() =>
                      patch({
                        statusKeywords: [
                          ...settings.statusKeywords,
                          { keyword: '', color: PALETTE[0] },
                        ],
                      })
                    }
                  >
                    Add keyword
                  </Button>
                </div>
              </div>
            </Field>
          </div>

          <div className={styles.actions}>
            <Button appearance="primary" onClick={save}>
              Save
            </Button>
            {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
          </div>
        </div>
      ) : section === 'general' ? (
        <div className={styles.pane}>
          <Subtitle2>Settings</Subtitle2>

          <div className={styles.grid}>
            <Field
              label="Interface font size"
              hint="Scales every size in the app, not just body text. 14 is the default."
            >
              <Dropdown
                value={`${settings.fontSizePx} px`}
                selectedOptions={[String(settings.fontSizePx)]}
                onOptionSelect={(_e, d) => patch({ fontSizePx: Number(d.optionValue) })}
              >
                {FONT_SIZE_OPTIONS.map((px) => (
                  <Option key={px} value={String(px)} text={`${px} px`}>
                    {px === BASE_FONT_PX ? `${px} px (default)` : `${px} px`}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            <Field
              label="Branch prefix"
              hint="Leads every branch an agent works on, e.g. “wd” gives wd/feat/abc-123/add-sso. Leave empty for no prefix — and no leading slash."
              validationState={prefixError ? 'error' : 'none'}
              validationMessage={prefixError ?? undefined}
            >
              <Input
                value={settings.branchPrefix}
                placeholder="none"
                onChange={(_e, d) => patch({ branchPrefix: d.value })}
              />
            </Field>

            <Field
              label="Merging a finished branch"
              hint="When off, a finished run leaves its branch alone and the card offers a Merge button — so you merge work you have looked at. Nothing is discarded either way. This is the default: each project can decide for itself in its dialog, and each card on the board, and changing this still moves everything that never disagreed with it."
            >
              <Switch
                checked={settings.autoIntegrate}
                label={
                  settings.autoIntegrate
                    ? 'Merge automatically when a run finishes'
                    : 'I merge it myself from the card'
                }
                onChange={(_e, d) => patch({ autoIntegrate: d.checked })}
              />
            </Field>

            <Field
              label="Toasts"
              hint="Brief pop-ups when something wants you. Everything they say is also on the board and in the Attention screen, so turning them off loses nothing."
            >
              <Switch
                checked={settings.toastsEnabled}
                label={settings.toastsEnabled ? 'Show toasts' : 'No toasts'}
                onChange={(_e, d) => patch({ toastsEnabled: d.checked })}
              />
            </Field>

            <Field
              label="On each card"
              hint="The same switches live in the board's Display menu, where you notice the noise."
            >
              <div className={styles.switchRow}>
                <Switch
                  checked={settings.board.showLabels}
                  label="JIRA labels"
                  onChange={(_e, d) =>
                    patch({ board: { ...settings.board, showLabels: d.checked } })
                  }
                />
                <Switch
                  checked={settings.board.showProjectName}
                  label="Project name"
                  onChange={(_e, d) =>
                    patch({ board: { ...settings.board, showProjectName: d.checked } })
                  }
                />
                <Switch
                  checked={settings.board.showEpicName}
                  label="Epic"
                  onChange={(_e, d) =>
                    patch({ board: { ...settings.board, showEpicName: d.checked } })
                  }
                />
              </div>
            </Field>

            <Field
              label="Auto-sync interval (minutes)"
              hint="How often every connected tracker is refreshed in the background — JIRA, GitLab and anything added later share one timer. 0 = off; the Sync button always works. The status bar's ring counts down to the next one."
            >
              <SpinButton
                min={0}
                max={120}
                value={settings.syncIntervalMinutes}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n))
                    patch({ syncIntervalMinutes: Math.max(0, Math.round(n as number)) });
                }}
              />
            </Field>

            <Field
              label="Priority on a card"
              hint="A board already spends colour on step dots, pipeline dots and the running band. This is the one place that colour is optional — the sort order honours priority either way."
            >
              <Dropdown
                value={PRIORITY_DISPLAY_LABELS[settings.board.priorityDisplay]}
                selectedOptions={[settings.board.priorityDisplay]}
                onOptionSelect={(_e, d) =>
                  patch({
                    board: {
                      ...settings.board,
                      priorityDisplay: d.optionValue as PriorityDisplay,
                    },
                  })
                }
              >
                {(Object.keys(PRIORITY_DISPLAY_LABELS) as PriorityDisplay[]).map((mode) => (
                  <Option key={mode} value={mode} text={PRIORITY_DISPLAY_LABELS[mode]}>
                    {PRIORITY_DISPLAY_LABELS[mode]}
                  </Option>
                ))}
              </Dropdown>
            </Field>

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

            {/* One panel per machine actually in use, plus the default for new
                projects. Showing only the default hid the very target the user had
                configured, so a WSL distro was never actually checked. */}
            {readinessTargets(settings.defaultExecTarget, targetsInUse).map((target) => (
              <ReadinessPanel key={formatExecTarget(target)} target={target} />
            ))}
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

          {/* Updates. Nothing here is a saved setting, so it sits below the Save row
              rather than inside it — the buttons act immediately. */}
          <Subtitle2>Updates</Subtitle2>
          <div className={styles.grid}>
            <Field label={appInfo ? `You are running v${appInfo.version}` : 'Version'}>
              <div className={styles.updateBlock}>
                <Caption1>{update ? describeUpdate(update) : 'Checking…'}</Caption1>
                {update?.status === 'downloading' && (
                  <ProgressBar
                    // An indeterminate bar is the honest rendering when the feed sends
                    // no percentage, rather than a bar frozen at zero.
                    value={typeof update.percent === 'number' ? update.percent / 100 : undefined}
                  />
                )}
                {/* A `manual` install gets a link, never a button that could not work.
                    A development run (`off`) gets neither — there is nothing to update. */}
                {update?.mode === 'auto' && (
                  <div className={styles.actions}>
                    {update.status === 'downloaded' ? (
                      <Button
                        appearance="primary"
                        onClick={() => void window.api.invoke('update:install')}
                      >
                        Restart and install
                      </Button>
                    ) : (
                      <Button
                        disabled={update.status === 'checking' || update.status === 'downloading'}
                        onClick={() => void window.api.invoke('update:check')}
                      >
                        Check now
                      </Button>
                    )}
                  </div>
                )}
                {/* An install that CAN update itself still needs this link when the update
                    failed — otherwise the only way out of a broken updater is to know the
                    releases URL by heart. */}
                {(update?.mode === 'manual' || update?.status === 'error') && (
                  <div className={styles.actions}>
                    <Link href={RELEASES_URL} target="_blank" rel="noreferrer">
                      Open the releases page
                    </Link>
                  </div>
                )}
                {update?.mode === 'auto' && (
                  <Caption1 className={styles.hint}>
                    New versions download in the background and install when you quit — nothing to
                    confirm. Windows SmartScreen only appears if you install a build downloaded from
                    the releases page by hand, because the installer is not code-signed: choose{' '}
                    <strong>More info → Run anyway</strong> that one time.
                  </Caption1>
                )}
                {update?.mode === 'manual' && (
                  <Caption1 className={styles.hint}>
                    This build is installed by something else — a package manager on Linux, or an
                    unsigned macOS bundle — so it will not replace itself. Download the new one and
                    install it the way you installed this one.
                  </Caption1>
                )}
              </div>
            </Field>
          </div>
        </div>
      ) : section === 'gitlab' ? (
        <div className={styles.pane}>
          <Subtitle2>GitLab</Subtitle2>
          <Body1 className={styles.hint}>
            Puts your open merge requests on the card whose ticket key they name — in the branch,
            the title or the description. A red pipeline, a review comment or a request for changes
            then raises the same orange ring an unread ticket comment does, so one board answers “is
            this actually done?”.
          </Body1>

          <div className={styles.grid}>
            <Field label="Enable GitLab">
              <Switch
                checked={gitlab.enabled}
                onChange={(_e, d) => patchGitLab({ enabled: d.checked })}
              />
            </Field>

            <Field
              label="GitLab URL"
              hint="gitlab.com or your own instance — e.g. https://gitlab.example.com"
            >
              <Input
                value={gitlab.baseUrl}
                placeholder="https://gitlab.com"
                onChange={(_e, d) => patchGitLab({ baseUrl: d.value })}
              />
            </Field>

            <Field
              label="Personal access token"
              hint={
                gitlabStatus?.encryptionAvailable === false
                  ? 'The OS secure store is unavailable, so a token cannot be saved on this machine.'
                  : gitlabStatus?.plainTextStorage
                    ? 'No keyring on this machine, so the token is obfuscated on disk rather than kept secret. Needs the read_api scope.'
                    : `Needs the read_api scope.${gitlabStatus?.hasToken ? ' A token is stored.' : ''}`
              }
            >
              <Input
                type="password"
                value={gitlabToken}
                placeholder={gitlabStatus?.hasToken ? '•••••••• (stored)' : 'glpat-…'}
                onChange={(_e, d) => setGitlabToken(d.value)}
              />
            </Field>
          </div>

          <div className={styles.actions}>
            <Button appearance="primary" onClick={() => void save()}>
              Save
            </Button>
            {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
          </div>

          <div className={styles.actions}>
            <Button
              appearance="secondary"
              disabled={!gitlabToken.trim() || gitlabStatus?.encryptionAvailable === false}
              onClick={() => void saveGitLabToken()}
            >
              Save token
            </Button>
            <Button
              appearance="secondary"
              disabled={!gitlabStatus?.hasToken}
              onClick={() => void clearGitLabToken()}
            >
              Clear token
            </Button>
            <Button appearance="primary" onClick={() => void testGitLab()}>
              Test connection
            </Button>
            {gitlabMsg && <Caption1 className={styles.saved}>{gitlabMsg}</Caption1>}
          </div>

          {gitlabTest && (
            <MessageBar intent={gitlabTest.ok ? 'success' : 'error'}>
              <MessageBarBody>{gitlabTest.message}</MessageBarBody>
            </MessageBar>
          )}
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

            <Field
              label="Status mapping"
              hint={
                jiraStatuses.length
                  ? `Which board column each JIRA workflow status means — ${jiraStatuses.length} statuses read from your instance, so pick rather than type. Matched on the name, ignoring case, so "Review" and "Code Review" can both land in In Review. Anything unmapped falls back to the issue's JIRA category; Blocked is internal-only and never comes from JIRA.`
                  : 'Which board column each JIRA workflow status means. Save a working connection and this offers your instance\'s own statuses; until then, type the name. Matched ignoring case, so "Review" and "Code Review" can both land in In Review. Anything unmapped falls back to the issue\'s JIRA category; Blocked is internal-only and never comes from JIRA.'
              }
            >
              <div className={styles.mapList}>
                {statusRows.map((row, i) => (
                  <div key={i} className={styles.mapRow}>
                    {/* Freeform, not a plain Dropdown: the list is a convenience, and a
                        status must stay mappable when JIRA is unreachable, no token is
                        stored yet, or the instance simply didn't return it. */}
                    <Combobox
                      className={styles.mapName}
                      freeform
                      value={row.name}
                      placeholder={
                        jiraStatuses.length
                          ? 'Pick a status, or type one'
                          : 'JIRA status name, e.g. Code Review'
                      }
                      onChange={(e) =>
                        patchStatusRows(
                          statusRows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                        )
                      }
                      onOptionSelect={(_e, d) =>
                        d.optionValue &&
                        patchStatusRows(
                          statusRows.map((r, j) =>
                            j === i ? { ...r, name: d.optionValue as string } : r,
                          ),
                        )
                      }
                    >
                      {suggestionsFor(row.name).map((s) => (
                        <Option key={s.name} value={s.name} text={s.name}>
                          {`${s.name} — ${s.category} by default`}
                        </Option>
                      ))}
                    </Combobox>
                    <Dropdown
                      className={styles.mapColumn}
                      value={COLUMN_LABEL[row.column]}
                      selectedOptions={[row.column]}
                      onOptionSelect={(_e, d) =>
                        d.optionValue &&
                        patchStatusRows(
                          statusRows.map((r, j) =>
                            j === i ? { ...r, column: d.optionValue as BoardColumn } : r,
                          ),
                        )
                      }
                    >
                      {MAPPABLE_COLUMNS.map((c) => (
                        <Option key={c} value={c}>
                          {COLUMN_LABEL[c]}
                        </Option>
                      ))}
                    </Dropdown>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DismissRegular />}
                      title="Remove this mapping"
                      onClick={() => patchStatusRows(statusRows.filter((_r, j) => j !== i))}
                    />
                  </div>
                ))}
                <div>
                  <Button
                    size="small"
                    icon={<AddRegular />}
                    onClick={() =>
                      patchStatusRows([...statusRows, { name: '', column: 'in-review' }])
                    }
                  >
                    Add mapping
                  </Button>
                </div>
              </div>
            </Field>

            {/* What the engine will actually do with the map above — including the
                statuses nothing in it mentions. Shares the already-fetched status list
                and the same resolver the sync runs, so it cannot drift from reality. */}
            <Field
              label="How your statuses resolve"
              hint="Every status your instance defines, the column it lands in, and which rule decided. A row that says “Name says review” is a guess the app made for you — pin it to make it yours."
            >
              <StatusMapViewer
                statuses={jiraStatuses}
                error={jiraStatusError}
                map={jira.statusCategoryOverrides}
                learned={jira.learnedStatusColumns}
                columnLabel={COLUMN_LABEL}
                onPin={pinStatus}
              />
            </Field>

            <Field
              label="Transition names (optional)"
              hint="Only needed when your workflow's transition names can't be worked out from the status they lead to. Leave blank to auto-detect."
            >
              <div className={styles.mapList}>
                {/* First, because it is the one workflows least agree on: moving a card
                    back to TO DO can be "Reopen", "Stop Progress" or "Back to backlog",
                    none of which name the status they lead to. */}
                <Input
                  value={jira.todoTransitionName ?? ''}
                  placeholder="Move back to To Do — e.g. Reopen"
                  onChange={(_e, d) => patchJira({ todoTransitionName: d.value })}
                />
                <Input
                  value={jira.inProgressTransitionName ?? ''}
                  placeholder="Move to In Progress — e.g. Start work"
                  onChange={(_e, d) => patchJira({ inProgressTransitionName: d.value })}
                />
                <Input
                  value={jira.inReviewTransitionName ?? ''}
                  placeholder="Move to In Review — e.g. Submit for review"
                  onChange={(_e, d) => patchJira({ inReviewTransitionName: d.value })}
                />
                <Input
                  value={jira.doneTransitionName ?? ''}
                  placeholder="Move to Done — e.g. Resolve"
                  onChange={(_e, d) => patchJira({ doneTransitionName: d.value })}
                />
              </div>
            </Field>

            <Field label="Done column">
              <Switch
                checked={jira.showDoneColumn}
                label="Show the Done column on the board"
                onChange={(_e, d) => patchJira({ showDoneColumn: d.checked })}
              />
            </Field>

            <Field
              label="Keep finished cards for (days)"
              hint="Most JQL (`resolution = Unresolved`) stops matching an issue the moment you finish it, which would empty the Done column as fast as you filled it. A finished card is kept this long past the query instead, and re-read by key each sync — so moving the ticket back out of Done in JIRA still moves the card. 0 = drop it as soon as the query does."
            >
              <SpinButton
                min={0}
                max={365}
                value={jira.doneRetentionDays}
                onChange={(_e, d) => {
                  const n = d.value ?? Number(d.displayValue);
                  if (Number.isFinite(n))
                    patchJira({ doneRetentionDays: Math.max(0, Math.round(n as number)) });
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
