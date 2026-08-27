/**
 * The browser's Settings — a FORK of the desktop's shell, not a share of it.
 *
 * WHY A FORK, WHEN EVERY OTHER SCREEN IS SHARED
 * ---------------------------------------------
 * `apps/client/src/renderer/src/Settings.tsx` is 1478 lines in ONE component, and nine of
 * its twenty-one channels are host-bound: the credential writes (`jira:setCredentials`,
 * `gitlab:*`, `github:*`), the updater (`update:install` quits the app), the exec-target
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
 * THE ONE SECTION THAT IS NOT SHARED, AND THE READ-ONLY HALF THAT IS
 * ---------------------------------------------------------------------
 * A project's IDENTITY — name, colour, the tickets-or-personal choice — is nothing but a row
 * in the store, and the web's own Projects tab (`@tm/ui/projects/ProjectAdmin`, rendered from
 * `App.tsx`) manages it exactly as the desktop's own admin pane does, over the same `project:*`
 * transport calls. It is that project's REPO half that stays desktop-only:
 * `apps/client/src/renderer/src/projects/Projects.tsx` reaches the engine through `window.api`
 * directly rather than through the transport, and its first act when adding a folder is
 * `project:pickDirectory` — a native folder picker for a directory on the machine the engine
 * runs on, which is why that channel is `host-only` while `project:add` itself is not.
 * Choosing the folder is very nearly the whole of attaching a repo, so there is no useful half
 * of *that* a browser could draw: it would be an empty path field asking somebody to type an
 * absolute path on a computer they cannot see. Repository settings therefore appear in
 * {@link HOST_ONLY_SECTIONS} instead, which is a decision rather than a gap.
 *
 * *Looking* at what a repo is configured with is the useful half, and it is the `'projects'`
 * tab below. It needs no picker, no `window.api` and no write channel: `ProjectsSection` is a
 * list and nothing else, fed from the same two sources the board resolves its repo pickers
 * from — the relayed `project:list` (filtered to a repo project) when a desktop answers, and
 * the mirrored `projects` rows when none does (`selectAgentProjects`). So the pane survives a
 * sleeping desktop.
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
  Subtitle2,
  Switch,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular, DismissRegular } from '@fluentui/react-icons';
import { ColorSwatches, PALETTE } from '@tm/ui/ColorSwatches';
import { PeopleSettings } from '@tm/ui/projects/PeopleSettings';
import { PlanningModelField } from '@tm/ui/PlanningModelField';
import { PaneLoading } from '@tm/ui/PaneLoading';
import { useInitialLoad } from '@tm/ui/useInitialLoad';
import { useTransport } from '@tm/ui/transport';
import { hasPlan, hasRepo, MODELS } from '@tm/shared/model';
import type { Project } from '@tm/shared/model';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';
import { clampSyncInterval, MAX_SYNC_INTERVAL_MINUTES } from '@tm/shared/settings';
import type { AppSettings } from '@tm/shared/settings';
import { selectAgentProjects } from '../board/boardSelectors';
import { ProjectsEmpty, ProjectsSection } from './ProjectsSection';
import { sectionNeedsSettings, type SettingsSection } from './settingsSections';
import { TokensSection } from './TokensSection';

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
});

const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

type Section = SettingsSection;

export interface SettingsScreenProps {
  /**
   * The MIRRORED `projects` rows, in `CloudBoardState`'s own by-id shape — passed straight
   * through from `App`, which already holds them for the board. Not a list, because that is
   * exactly what {@link selectAgentProjects} takes as its fallback source, and re-shaping it
   * here and back there would be two conversions to say one thing.
   */
  projects: Record<string, Project>;
  /** Where `TokensSection` calls `POST`/`GET`/`DELETE /v1/tokens` — `config.cloudApiBase`. */
  apiBase: string;
  /** This tab's own bearer, for the same three calls — `AuthedApp`'s `auth.getAccessToken`. */
  getAccessToken: () => Promise<string | null>;
}

export function SettingsScreen({
  projects,
  apiBase,
  getAccessToken,
}: SettingsScreenProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [section, setSection] = useState<Section>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * This screen's own agent-project read, and its own "did anybody answer" flag.
   *
   * One call, not a subscription: the screen unmounts when you leave it (`App.tsx`), agent
   * projects are edited on the desktop rather than from here, and a list that changes while
   * you look at it is worth exactly one relayed read on arrival. Deliberately NOT
   * `useBoardExtras` — that hook fires eight reads and owns the board's liveness, and
   * mounting it from Settings would put a second copy of all eight behind this tab.
   */
  const [relayedProjects, setRelayedProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const load = useCallback(async () => {
    setSettings(await transport.invoke('settings:get'));
  }, [transport]);
  const initial = useInitialLoad(load);

  // Fails soft, like every relayed read in this app: a desktop that is not answering leaves
  // the flag `false`, and the pane falls back to the mirrored rows rather than to "none".
  useEffect(() => {
    let live = true;
    void transport
      .invoke('project:list')
      .then((list) => {
        if (!live) return;
        // A repo directory with no plan file — the same set `agentProject:list` used to
        // answer, before the two channel sets merged into `project:*`.
        setRelayedProjects(list.map((p) => p.project).filter((p) => hasRepo(p) && !hasPlan(p)));
        setProjectsLoaded(true);
      })
      .catch(() => {
        // Silent on purpose. The Projects pane below says which of the two answers it is
        // showing, which is the only thing a banner here could add.
      });
    return () => {
      live = false;
    };
  }, [transport]);

  const agentProjects = selectAgentProjects(projects, relayedProjects, projectsLoaded);

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

  // NOT an early return over the whole screen any more. `settings` comes from the relayed
  // `settings:get`, which a browser with no desktop polling never gets an answer to — and
  // gating the shell on it trapped the Personal access tokens pane, the one page that exists
  // to connect the FIRST desktop. Only the panes that render `AppSettings` fields wait; the
  // rest draw regardless. See `settingsSections.ts` for the seam and its test.
  const waitingForSettings = sectionNeedsSettings(section) && !settings;

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
        <Tab value="projects">Projects</Tab>
        <Tab value="jira">JIRA</Tab>
        <Tab value="tokens">Personal access tokens</Tab>
        <Tab value="people">People</Tab>
        <Tab value="desktop">Desktop only</Tab>
      </TabList>

      {waitingForSettings && (
        <div className={styles.pane}>
          <PaneLoading label="Loading settings…" error={initial.error} onRetry={initial.retry} />
        </div>
      )}

      {section === 'general' && settings && (
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
                min={0}
                max={MAX_SYNC_INTERVAL_MINUTES}
                value={String(settings.syncIntervalMinutes)}
                // `clampSyncInterval`: a plain number input has no upper bound of its own, and
                // an unclamped value reaches `SyncPoller` on the desktop — see its docstring
                // for why that overflows the timer's delay into "sync continuously" rather
                // than failing loud.
                onChange={(_e, d) =>
                  patch({ syncIntervalMinutes: clampSyncInterval(Number(d.value) || 0) })
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

      {section === 'board' && settings && (
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

      {section === 'projects' && (
        <div className={styles.pane}>
          <Subtitle2>Repository settings</Subtitle2>
          <Body1 className={styles.hint}>
            The repositories an agent can work in, and what each one runs with. A project&apos;s
            name, colour and ticket prefix are on the Projects tab — this is where you check what
            its repository is actually configured to do.
          </Body1>

          {/* The refusal, stated before the list rather than on a button that is not there:
              a pane with no controls in it reads as unfinished unless it says it is not. */}
          <MessageBar intent="info">
            <MessageBarBody>
              Attaching or changing a repository happens on the desktop app. A repository
              <strong> is</strong> a folder on the machine the engine runs on, so choosing one
              starts with that machine’s own folder picker — which is most of what attaching one is.
            </MessageBarBody>
          </MessageBar>

          {agentProjects.length === 0 ? (
            // Two different sentences, and the difference is the whole point of the flag: a
            // desktop that answered with nothing means there are none, while a mirror that has
            // never carried a row means nobody has told this browser anything yet.
            <ProjectsEmpty synced={projectsLoaded || Object.keys(projects).length > 0} />
          ) : (
            <ProjectsSection projects={agentProjects} />
          )}
        </div>
      )}

      {section === 'jira' && settings && (
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

      {section === 'tokens' && (
        <div className={styles.pane}>
          <TokensSection apiBase={apiBase} getAccessToken={getAccessToken} />
        </div>
      )}

      {section === 'people' && (
        <div className={styles.pane}>
          <PeopleSettings />
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
    title: 'Repository settings',
    why:
      'a repo IS a folder on that machine, so attaching one starts with a native folder ' +
      'picker there, and the rest — the execution target, the base branch, the models, the ' +
      'permission mode, the epics it owns — is configured beside it. A project’s name, ' +
      'colour and ticket prefix are not part of this: those are rows in the store, and the ' +
      'Projects tab lets you set them from here just as it does on the desktop.',
  },
];
