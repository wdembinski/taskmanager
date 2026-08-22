/**
 * The browser's Settings — a FORK of the desktop's shell, not a share of it.
 *
 * WHY A FORK, WHEN EVERY OTHER SCREEN IS SHARED
 * ---------------------------------------------
 * `apps/client/src/renderer/src/Settings.tsx` is 1478 lines in ONE component, and nine of
 * its twenty-one channels are host-bound: the credential writes (`jira:setCredentials`,
 * `gitlab:*`, `iam:signOut`), the updater (`update:install` quits the app), the exec-target
 * pickers (`exec:listDistros` asks THIS machine what WSL distros it has), the sign-in flows,
 * and the font size (which scales an Electron window, not a browser tab). Sharing it whole
 * would mean roughly eight optional capability props the web passes `false` for — which is
 * precisely the shape this repo's own rule says to fork instead.
 *
 * So the split is by SECTION. Everything with a rule in it is shared as a real component
 * from `@tm/ui` — `ColorSwatches` and its palette and `PlanningModelField` here,
 * `StatusMapViewer` with `buildStatusMapRows` and `BaseBranchField` for the sections that
 * stayed on the desktop — and this file is the shell plus the plain `AppSettings` fields,
 * which are a form over a JSON blob and carry no rule at all.
 *
 * THE ONE SECTION THAT IS NOT SHARED, AND WILL NOT BE
 * ---------------------------------------------------
 * `AgentProjects` is not in `@tm/ui` and does not belong there. It lives in
 * `apps/client/src/renderer/src/AgentProjects.tsx`, reaches the engine through `window.api`
 * directly rather than through the transport, and its first act is `project:pickDirectory` —
 * a native folder picker for a directory on the machine the engine runs on, which is why that
 * channel is `host-only` while `agentProject:add` itself is not. Choosing the folder is very
 * nearly the whole of creating one, so there is no useful half of this pane a browser could
 * draw: it would be an empty path field asking somebody to type an absolute path on a
 * computer they cannot see. It appears in {@link HOST_ONLY_SECTIONS} instead, which is a
 * decision rather than a gap — see the plan doc, "What is deliberately out of scope".
 *
 * WHAT THE HOST-ONLY SECTIONS DO INSTEAD
 * --------------------------------------
 * They say so, by name, and say where to go. A section quietly missing reads as a screen
 * that is broken; a card that says "set this from the desktop app" reads as a decision. The
 * refusal text comes from `@tm/shared/ipcRelay` wherever a channel is involved, so the reason
 * here and the reason a click would have produced are the same sentence.
 *
 * SAVING MERGES
 * -------------
 * `settings:save` writes the WHOLE blob, and this tab may have been open for an hour. The
 * engine merges a relayed save over its current copy (`cloudCommands.ts`), so a stale field
 * here cannot erase something the engine learned in between — which matters a great deal
 * more in a browser than it ever did in a window that got `settings:changed` pushed at it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Subtitle2,
  Switch,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, CopyRegular, DismissRegular } from '@fluentui/react-icons';
import { ColorSwatches, PALETTE } from '@tm/ui/ColorSwatches';
import { PlanningModelField } from '@tm/ui/PlanningModelField';
import { PaneLoading } from '@tm/ui/PaneLoading';
import { useInitialLoad } from '@tm/ui/useInitialLoad';
import { useTransport } from '@tm/ui/transport';
import { MODELS } from '@tm/shared/model';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';
import type { AppSettings } from '@tm/shared/settings';
import {
  createDeviceToken,
  listDeviceTokens,
  revokeDeviceToken,
  type DeviceToken,
} from '../auth/deviceTokens';

const useStyles = makeStyles({
  row: { display: 'flex', gap: '16px', height: '100%', minHeight: 0 },
  nav: {
    minWidth: '160px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: '8px',
  },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '1100px',
    width: '100%',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  grid: { display: 'flex', flexDirection: 'column', gap: '16px' },
  mapList: { display: 'flex', flexDirection: 'column', gap: '6px' },
  mapRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  mapName: { flex: 1, minWidth: 0 },
  actions: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' },
  switchRow: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
  secretRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  secretValue: { fontFamily: 'monospace', wordBreak: 'break-all' },
  tokenList: { display: 'flex', flexDirection: 'column', gap: '8px' },
  tokenRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 0',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tokenName: { flex: 1, minWidth: 0 },
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

type Section = 'general' | 'board' | 'jira' | 'link' | 'desktop';

export interface SettingsScreenProps {
  /** The same accessor `CloudAuth.getAccessToken` exposes — this tab's own bearer, used to
   *  authenticate the "Link desktop" pane's calls to vipper.iam. */
  getAccessToken: () => Promise<string | null>;
  /** `WebConfig.iamApiBase` — vipper.iam's REST API base. */
  iamApiBase: string;
}

export function SettingsScreen({ getAccessToken, iamApiBase }: SettingsScreenProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [section, setSection] = useState<Section>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Link desktop": the tokens this account already holds, a name field for a new one, and
  // the one-time secret from the most recent create — kept separate from `tokens` because it
  // has to survive a list refresh (the create response is the ONLY time the secret is ever
  // seen; a re-fetched list never carries it again).
  const [deviceTokens, setDeviceTokens] = useState<DeviceToken[] | null>(null);
  const [deviceTokensError, setDeviceTokensError] = useState<string | null>(null);
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSettings(await transport.invoke('settings:get'));
  }, [transport]);
  const initial = useInitialLoad(load);

  // The engine can change settings under an open screen — it learns a JIRA status→column
  // mapping from a successful drag, for one — and this tab may sit here for an hour.
  useEffect(() => transport.on('settings:changed', setSettings), [transport]);

  const patch = (next: Partial<AppSettings>): void => {
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (!settings) return;
    setError(null);
    try {
      await transport.invoke('settings:save', settings);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deviceTokenDeps = { apiBase: iamApiBase, getAccessToken };

  const refreshDeviceTokens = useCallback(async () => {
    const result = await listDeviceTokens(deviceTokenDeps);
    if (result.ok) {
      setDeviceTokens(result.tokens);
      setDeviceTokensError(null);
    } else {
      setDeviceTokensError(result.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `getAccessToken` is a stable
    // per-mount accessor (App.tsx's `auth` is memoized); only `iamApiBase` ever actually changes.
  }, [iamApiBase]);

  // Lazy: the pane's first visit is what loads the list, not mount — a tab nobody opens
  // should not spend a vipper.iam round trip on every Settings load.
  useEffect(() => {
    if (section === 'link' && deviceTokens === null) {
      void refreshDeviceTokens();
    }
  }, [section, deviceTokens, refreshDeviceTokens]);

  const createToken = async (): Promise<void> => {
    setCreatingToken(true);
    setDeviceTokensError(null);
    try {
      const result = await createDeviceToken(deviceTokenDeps, newTokenName);
      if (result.ok) {
        setCreatedSecret(result.secret);
        setNewTokenName('');
        await refreshDeviceTokens();
      } else {
        setDeviceTokensError(result.message);
      }
    } finally {
      setCreatingToken(false);
    }
  };

  const revokeToken = async (id: string): Promise<void> => {
    setRevokingId(id);
    try {
      const result = await revokeDeviceToken(deviceTokenDeps, id);
      if (result.ok) {
        await refreshDeviceTokens();
      } else {
        setDeviceTokensError(result.message);
      }
    } finally {
      setRevokingId(null);
    }
  };

  if (!settings) {
    return <PaneLoading label="Loading settings…" error={initial.error} onRetry={initial.retry} />;
  }

  const actions = (
    <div className={styles.actions}>
      <Button appearance="primary" onClick={() => void save()}>
        Save
      </Button>
      {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
      {error && <Caption1>{error}</Caption1>}
    </div>
  );

  return (
    <div className={styles.row}>
      <TabList
        vertical
        selectedValue={section}
        onTabSelect={(_e, d) => setSection(d.value as Section)}
        className={styles.nav}
      >
        <Tab value="general">General</Tab>
        <Tab value="board">Board</Tab>
        <Tab value="jira">JIRA</Tab>
        <Tab value="link">Link desktop</Tab>
        <Tab value="desktop">Desktop only</Tab>
      </TabList>

      {section === 'general' && (
        <div className={styles.pane}>
          <Subtitle2>Settings</Subtitle2>
          <Body1 className={styles.hint}>
            The defaults new work starts with, and the two scheduler knobs. Saved on your desktop
            app — these are the same settings it reads.
          </Body1>

          <div className={styles.grid}>
            <Field
              label="Default model"
              hint="What a new project runs on unless it says otherwise."
            >
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

            <PlanningModelField
              label="Default planning model for new projects"
              value={settings.defaultPlanningModel}
              executionModel={settings.defaultModel}
              onChange={(defaultPlanningModel) => patch({ defaultPlanningModel })}
              hint="Planning is the run whose whole output is judgement: it reads a repo and decides what the work is, where a step is handed a brief that already says what to do. Leave it following execution to keep planning priced exactly as it is today."
            />

            <Field
              label="Default permission mode"
              hint="How much a new project's agent may do without asking."
            >
              <Dropdown
                value={settings.defaultPermissionMode}
                selectedOptions={[settings.defaultPermissionMode]}
                onOptionSelect={(_e, d) =>
                  patch({ defaultPermissionMode: d.optionValue as PermissionMode })
                }
              >
                {MODES.map((m) => (
                  <Option key={m} value={m}>
                    {m}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            <Field
              label="Tasks at once"
              hint="How many sessions the scheduler runs in parallel, across all projects."
            >
              <Input
                type="number"
                value={String(settings.concurrency)}
                onChange={(_e, d) => patch({ concurrency: Math.max(1, Number(d.value) || 1) })}
              />
            </Field>

            <Field
              label="Sync every (minutes)"
              hint="How often the desktop app refreshes JIRA and GitLab. 0 turns background sync off."
            >
              <Input
                type="number"
                value={String(settings.syncIntervalMinutes)}
                onChange={(_e, d) =>
                  patch({ syncIntervalMinutes: Math.max(0, Number(d.value) || 0) })
                }
              />
            </Field>

            <Field
              label="Branch prefix"
              hint="What a card's working branch is named after. Blank uses the app's own default."
            >
              <Input
                value={settings.branchPrefix}
                onChange={(_e, d) => patch({ branchPrefix: d.value })}
              />
            </Field>

            <div className={styles.switchRow}>
              <Switch
                label="Merge a finished card automatically"
                checked={settings.autoIntegrate}
                onChange={(_e, d) => patch({ autoIntegrate: d.checked })}
              />
              <Switch
                label="Show the detail pane"
                checked={settings.showTaskDetail}
                onChange={(_e, d) => patch({ showTaskDetail: d.checked })}
              />
            </div>
          </div>

          {actions}
        </div>
      )}

      {section === 'board' && (
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
              hint="A status update containing one of these takes its colour. The first match in this list wins, so put the one that matters most at the top."
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

            <div className={styles.switchRow}>
              <Switch
                label="Show labels on cards"
                checked={settings.board.showLabels}
                onChange={(_e, d) => patch({ board: { ...settings.board, showLabels: d.checked } })}
              />
              <Switch
                label="Show the project name"
                checked={settings.board.showProjectName}
                onChange={(_e, d) =>
                  patch({ board: { ...settings.board, showProjectName: d.checked } })
                }
              />
              <Switch
                label="Show the epic name"
                checked={settings.board.showEpicName}
                onChange={(_e, d) =>
                  patch({ board: { ...settings.board, showEpicName: d.checked } })
                }
              />
            </div>
          </div>

          {actions}
        </div>
      )}

      {section === 'jira' && (
        <div className={styles.pane}>
          <Subtitle2>JIRA (My Tasks board)</Subtitle2>
          <Body1 className={styles.hint}>
            Which issues reach the board, and how the columns read. The connection itself — the
            site, the account and the token — is set on the desktop app; see the Desktop-only tab
            for why.
          </Body1>

          <div className={styles.grid}>
            <Field
              label="JQL"
              hint="The query that selects your issues. The desktop app runs it; this is the same field it reads."
            >
              <Input
                value={settings.jira.jql}
                onChange={(_e, d) => patch({ jira: { ...settings.jira, jql: d.value } })}
              />
            </Field>

            <Field
              label="Keep finished cards for (days)"
              hint="How long a card stays in Done after its issue stops matching the JQL. 0 removes it the moment it does."
            >
              <Input
                type="number"
                value={String(settings.jira.doneRetentionDays)}
                onChange={(_e, d) =>
                  patch({
                    jira: {
                      ...settings.jira,
                      doneRetentionDays: Math.max(0, Number(d.value) || 0),
                    },
                  })
                }
              />
            </Field>

            <div className={styles.switchRow}>
              <Switch
                label="Current sprint only"
                checked={settings.jira.currentSprintOnly}
                onChange={(_e, d) =>
                  patch({ jira: { ...settings.jira, currentSprintOnly: d.checked } })
                }
              />
              <Switch
                label="Show the Done column"
                checked={settings.jira.showDoneColumn}
                onChange={(_e, d) =>
                  patch({ jira: { ...settings.jira, showDoneColumn: d.checked } })
                }
              />
            </div>
          </div>

          {actions}
        </div>
      )}

      {section === 'link' && (
        <div className={styles.pane}>
          <Subtitle2>Link desktop</Subtitle2>
          <Body1 className={styles.hint}>
            The desktop app normally signs in to the cloud itself, opening a browser of its own. On
            a machine that can't do that, create a token here instead — this tab is already signed
            in — and paste it into the desktop app's Cloud settings under "Link with a token".
          </Body1>

          <div className={styles.grid}>
            <Field
              label="New token"
              hint="A name to recognise it by later, e.g. the machine it's for."
            >
              <div className={styles.actions}>
                <Input
                  value={newTokenName}
                  placeholder="My laptop"
                  onChange={(_e, d) => setNewTokenName(d.value)}
                />
                <Button
                  appearance="primary"
                  disabled={creatingToken || !newTokenName.trim()}
                  onClick={() => void createToken()}
                >
                  Create token
                </Button>
                {creatingToken && <Spinner size="tiny" />}
              </div>
            </Field>

            {createdSecret && (
              <MessageBar intent="success">
                <MessageBarBody>
                  <strong>Copy this now</strong> — it's shown once and never again.
                  <div className={styles.secretRow}>
                    <Caption1 className={styles.secretValue}>{createdSecret}</Caption1>
                    <Button
                      size="small"
                      icon={<CopyRegular />}
                      onClick={() => void navigator.clipboard.writeText(createdSecret)}
                    >
                      Copy
                    </Button>
                  </div>
                </MessageBarBody>
              </MessageBar>
            )}

            {deviceTokensError && (
              <MessageBar intent="error">
                <MessageBarBody>{deviceTokensError}</MessageBarBody>
              </MessageBar>
            )}

            <Field label="Tokens on this account">
              <div className={styles.tokenList}>
                {deviceTokens === null ? (
                  <Spinner size="tiny" label="Loading…" />
                ) : deviceTokens.length === 0 ? (
                  <Caption1 className={styles.hint}>No tokens yet.</Caption1>
                ) : (
                  deviceTokens.map((t) => (
                    <div key={t.id} className={styles.tokenRow}>
                      <div className={styles.tokenName}>
                        <Body1>{t.name}</Body1>
                        <Caption1 className={styles.hint}>
                          {t.tokenPrefix} · created {new Date(t.createdAt).toLocaleDateString()}
                          {t.revokedAt ? ' · revoked' : ''}
                        </Caption1>
                      </div>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<DismissRegular />}
                        disabled={revokingId === t.id || t.revokedAt !== null}
                        onClick={() => void revokeToken(t.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </Field>
          </div>
        </div>
      )}

      {section === 'desktop' && (
        <div className={styles.pane}>
          <Subtitle2>Set these from the desktop app</Subtitle2>
          <Body1 className={styles.hint}>
            Not missing, and not coming: each of these does something to the MACHINE the desktop app
            runs on, and a browser tab has no business doing it from here.
          </Body1>
          {HOST_ONLY_SECTIONS.map((s) => (
            <MessageBar key={s.title} intent="info">
              <MessageBarBody>
                <strong>{s.title}</strong> — {s.why}
              </MessageBarBody>
            </MessageBar>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The sections that stay on the desktop, and the reason each does.
 *
 * Written as prose rather than pulled from `hostOnlyMessage`, because these describe a
 * SECTION rather than a channel — "Credentials" covers four channels and a form — and the
 * reason a human wants here is about the section, not about which call was refused. The
 * per-channel sentence still shows if something in the shared UI does attempt one.
 */
const HOST_ONLY_SECTIONS: ReadonlyArray<{ title: string; why: string }> = [
  {
    title: 'JIRA and GitLab credentials',
    why:
      'a token typed here would cross the network inside a relayed command and land in the ' +
      'server’s audit trail. The desktop app writes it straight into your machine’s own ' +
      'credential store and it never leaves.',
  },
  {
    title: 'Cloud sign-in',
    why:
      'signing the DESKTOP app in is a different act from signing this tab in, and this tab ' +
      'is already signed in. Use the desktop app’s Cloud section for its own connection, or ' +
      'the Link desktop tab here to hand it a token instead.',
  },
  {
    title: 'Updates',
    why: 'installing one quits and restarts the app, on somebody else’s screen.',
  },
  {
    title: 'Execution targets and WSL',
    why:
      'the list of distros is a fact about the machine the app is installed on, and this tab ' +
      'is not on it.',
  },
  {
    title: 'Interface font size',
    why:
      'it scales the desktop window’s own type ramp. A browser has its own zoom, which is ' +
      'the control you actually want here.',
  },
  {
    title: 'Agent projects',
    why:
      'one IS a folder on that machine, so adding it starts with a native folder picker there ' +
      'and the rest — its defaults, its base branch, the epics it owns — is configured beside ' +
      'it. What you can do from here is use them: file a card under one, or assign a card to ' +
      'one and override the model and permission mode for that card.',
  },
];
