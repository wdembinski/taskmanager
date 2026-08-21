/**
 * App shell.
 *
 * A frameless window: a custom <TitleBar> (window drag handle + min/max/close)
 * sits flush at the very top, and under it a **vertical nav rail** on the left —
 * My Tasks, Projects, Performance, the Attention inbox, Settings, a hands-on Scratch
 * run — beside the content region. The rail replaced
 * a horizontal tab strip, which cost every screen a band of height at the top,
 * where a board and a chat pane both want it most. A global usage-limit banner
 * (Phase 5) sits above the content; a Claude message bar appears only when
 * something is wrong; and a **status bar** runs the full width of the window at
 * the bottom — blue at rest, orange while anything is waiting on a human.
 *
 * The frame itself — the flex shell, the rail, the status bar — is `@tm/ui/shell`, so the
 * browser client draws the same one rather than a lookalike. What stays here is everything
 * that is the *desktop's*: the title bar, the banners, the sync rings, the usage quotas,
 * the attention subscription, and every `window.api` call behind them.
 *
 * The pattern to notice: components read request/response data via
 * `window.api.invoke(...)` and consume pushed updates via `window.api.on(...)`.
 * Those two are the whole UI↔engine vocabulary.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1,
  CounterBadge,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Spinner,
  Toast,
  ToastBody,
  ToastTitle,
  useToastController,
} from '@fluentui/react-components';
import {
  AlertRegular,
  AppsListDetailRegular,
  DataTrendingRegular,
  FolderRegular,
  PlayRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { AuthState } from '@shared/auth';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';
import { describeUpdate, type UpdateState } from '@shared/update';
import { Attention } from '@ui/Attention';
import { AuthBanner } from './AuthBanner';
import { LimitBanner } from './LimitBanner';
import { MyTasks } from './MyTasks';
import { currentSprintName } from '@ui/board/currentSprint';
// The ticket WORKSPACE (backlog table + Gantt over one ticket project's own tickets),
// distinct from the admin `Projects` screen below — see the TabId doc above.
import { Projects as TicketWorkspace } from '@ui/projects/Projects';
import { SyncRing } from './SyncRing';
import type { SyncState } from '@shared/sync';
import { Performance } from '@ui/Performance';
import { Projects } from './projects/Projects';
import { Settings } from './Settings';
import { SessionRunner } from './SessionRunner';
import { TitleBar } from './TitleBar';
import { UsageQuotaStatus, useUsageQuotas } from '@ui/UsageQuotaBars';
import { AppShell } from '@ui/shell/AppShell';
import { NavRail, type NavRailItem } from '@ui/shell/NavRail';
import { StatusBar, StatusDot, StatusSpacer } from '@ui/shell/StatusBar';
import { TOASTER_ID } from '@ui/theme';
import type { AttentionItem } from '@shared/attention';

const useStyles = makeStyles({
  /**
   * The "a new version is waiting" item — the desktop's alone, so it stays here rather
   * than in the shared `StatusBar`. It inherits the bar's own colour rather than naming
   * one, because the bar turns orange under attention and a fixed white would vanish
   * against it. Underlined so it reads as the one clickable thing down here.
   */
  update: {
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
});

/**
 * Phase 17 removed the Projects and Board screens; everything they did moved onto a
 * card, with a repo managed from Settings → Agents. This step brings Projects back as a
 * nav item of its own — one place to create and edit every project (a repo, a
 * ticket-only backlog, or both), now that a project's capabilities are derived from its
 * fields rather than picked from a `kind`. There is still no separate per-project Board
 * screen: work lives on the single My Tasks board.
 *
 * The ENGINE's notion of a project stays exactly where it is. Projects are how runs are
 * queued, how concurrency is bounded and where a worktree is cut; the personal board is
 * itself a project. Only the two screens were gone.
 *
 * Phase 24 brings a ticket workspace of its own — `TicketWorkspace` (`packages/ui/src/
 * projects/Projects.tsx`), on its own `'tickets'` tab — but it is not the Projects tab
 * above: it is the backlog/Gantt view of one ticket project's own tickets, a key prefix and
 * the tickets this app tracks itself, with no repo and no plan file. Creating and editing a
 * ticket project happens on the Projects tab like any other project; the Tickets tab is
 * purely a workspace over whichever one you pick.
 */
type TabId =
  'mytasks' | 'projects' | 'tickets' | 'performance' | 'attention' | 'settings' | 'scratch';

/** The rail, in order. The label is the tooltip and the accessible name. */
const NAV: ReadonlyArray<NavRailItem & { id: TabId }> = [
  { id: 'mytasks', label: 'My Tasks', icon: <TaskListSquareLtrRegular /> },
  { id: 'projects', label: 'Projects', icon: <FolderRegular /> },
  { id: 'tickets', label: 'Tickets', icon: <AppsListDetailRegular /> },
  { id: 'performance', label: 'Performance', icon: <DataTrendingRegular /> },
  { id: 'attention', label: 'Attention', icon: <AlertRegular /> },
  { id: 'settings', label: 'Settings', icon: <SettingsRegular /> },
  { id: 'scratch', label: 'Scratch run', icon: <PlayRegular /> },
];

/** What each kind of ask is called in a toast — short, because a toast is one glance. */
const TOAST_TITLE: Record<AttentionItem['kind'], string> = {
  permission: 'Permission needed',
  question: 'The agent has a question',
  'agent-question': 'The agent is asking you to choose',
  'plan-approval': 'A plan is ready to approve',
  'merge-conflict': 'Merge conflict',
  'task-failed': 'A run failed',
  proposal: 'A proposal needs a decision',
};

export function App(): JSX.Element {
  const styles = useStyles();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  /**
   * The account-wide sign-in gate, which OUTRANKS `claude` in the status bar.
   *
   * `claude:getStatus` answers "does a credentials file exist", which stayed true for the
   * whole outage that made this necessary — the file was there and the token inside it had
   * expired. A gate is a real run's verdict, so while one is up the bar reads signed out
   * however cheerful the file check is.
   */
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [tab, setTab] = useState<TabId>('mytasks');
  // How many tasks are waiting on a human, shown as a badge on the Attention tab.
  const [attentionCount, setAttentionCount] = useState(0);
  const { dispatchToast } = useToastController(TOASTER_ID);
  /**
   * Raise a toast for an incoming ask, if toasts are on.
   *
   * The switch is read at dispatch time rather than held in state because this fires from
   * inside a subscription that is set up once — a captured value would go stale the
   * moment the setting changed, and the toast that ignored your preference would be the
   * one you noticed.
   */
  const notify = useCallback(
    (item: AttentionItem) => {
      void window.api
        .invoke('settings:get')
        .then((settings) => {
          if (!settings.toastsEnabled) return;
          dispatchToast(
            <Toast>
              <ToastTitle>{TOAST_TITLE[item.kind] ?? 'Something needs you'}</ToastTitle>
              <ToastBody>{item.taskTitle}</ToastBody>
            </Toast>,
            { intent: item.kind === 'task-failed' ? 'error' : 'warning', timeout: 6000 },
          );
        })
        .catch(() => undefined);
    },
    [dispatchToast],
  );
  // Auto-update: only its final state earns a place in the status bar (a downloaded
  // build waiting for a restart). Progress lives in Settings, where it was asked for.
  const [update, setUpdate] = useState<UpdateState | null>(null);
  /**
   * The sprint the board is filtered to, said once here instead of on every card.
   *
   * The shell reads it rather than the board pushing it up: this way the bar is right
   * even while another tab is open, and the board keeps knowing nothing about the shell.
   * Null whenever the filter is off or the cards disagree — see `currentSprintName`.
   */
  const [sprint, setSprint] = useState<string | null>(null);

  /**
   * How fresh each tracker's mirror is, for the status bar's countdown rings. Held by the
   * shell rather than the board for the same reason `sprint` is: the bar stays right while
   * another tab is open, and it is the shell that owns the bar.
   */
  const [syncState, setSyncState] = useState<SyncState | null>(null);

  // Set when the app shell itself can't reach the engine — the clearest possible signal
  // that nothing else on screen will load either.
  const [bootError, setBootError] = useState<string | null>(null);

  /**
   * How much of the session (5h) and weekly windows is spent, for the status bar's pair
   * of bars. Held here for the same reason `sprint` and `syncState` are: the bar is the
   * shell's, and the answer has to be true with the Performance tab closed — which is
   * exactly when you most want to know it.
   */
  const quotas = useUsageQuotas();

  useEffect(() => {
    void Promise.all([
      window.api.invoke('app:getInfo').then(setInfo),
      window.api.invoke('claude:getStatus').then(setClaude),
      window.api.invoke('auth:current').then(setAuth),
      window.api.invoke('attention:list').then((items) => setAttentionCount(items.length)),
      window.api.invoke('update:get').then(setUpdate),
      window.api.invoke('sync:state').then(setSyncState),
    ]).catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));

    /** Recompute the footer's sprint from the settings flag and the board's cards. */
    const readSprint = async (): Promise<void> => {
      const [settings, tasks] = await Promise.all([
        window.api.invoke('settings:get'),
        window.api.invoke('board:tasks'),
      ]);
      setSprint(settings.jira.currentSprintOnly ? currentSprintName(tasks) : null);
    };
    void readSprint().catch(() => setSprint(null));

    const offNew = window.api.on('attention:new', (item) => {
      setAttentionCount((n) => n + 1);
      // A toast is the only part of this that can reach you while you are looking at
      // another screen — the ring and the badge both need the board to be visible. It
      // says which card, because "something needs you" with six cards open is a riddle.
      notify(item);
    });
    const offResolved = window.api.on('attention:resolved', () =>
      setAttentionCount((n) => Math.max(0, n - 1)),
    );
    const offUpdate = window.api.on('update:changed', setUpdate);
    // Signing back in re-reads the CLI too: the gate lifting means the credential is
    // believed good again, and the version/API-key half of the bar may have moved with it.
    const offAuth = window.api.on('auth:changed', (state) => {
      setAuth(state);
      if (!state) void window.api.invoke('claude:getStatus').then(setClaude);
    });
    // Fires when a sync starts, finishes or fails — the ring's own countdown between those
    // moments is a local timer inside `SyncRings`, so this is only the resets.
    const offSync = window.api.on('sync:changed', setSyncState);
    // Both signals matter: a sync replaces the board (the sprint's cards may change),
    // and the engine can rewrite settings behind the UI's back.
    const offTasks = window.api.on('project:tasksChanged', () => void readSprint());
    const offSettings = window.api.on('settings:changed', () => void readSprint());
    return () => {
      offNew();
      offResolved();
      offUpdate();
      offAuth();
      offSync();
      offTasks();
      offSettings();
    };
  }, []);

  // A live gate is hard evidence and beats every part of the file check below it.
  const signedOut = auth !== null;
  const claudeOk =
    !signedOut && claude?.installed && claude?.authenticated && !claude?.apiKeyDetected;

  return (
    <AppShell
      titleBar={<TitleBar />}
      nav={
        <NavRail
          items={NAV.map((item) =>
            // The only label the rail ever shows: a count that means "someone is waiting
            // on you". Built per render rather than in `NAV` because it moves.
            item.id === 'attention' && attentionCount > 0
              ? {
                  ...item,
                  badge: (
                    <CounterBadge
                      count={attentionCount}
                      color="danger"
                      size="small"
                      appearance="filled"
                    />
                  ),
                }
              : item,
          )}
          selected={tab}
          onSelect={(id) => setTab(id as TabId)}
        />
      }
      banners={
        <>
          {/* The engine is unreachable — every tab below will be empty, so say why once,
              at the top, rather than leaving the user to guess from seven spinners. */}
          {bootError && (
            <MessageBar intent="error">
              <MessageBarBody>
                Can&apos;t reach the app&apos;s backend, so nothing will load: {bootError}
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Surface a Claude problem prominently; when all is well the footer suffices.
              Suppressed while the sign-in gate is up: `AuthBanner` above is saying the
              same thing with the button that fixes it, and two red bars reporting one
              outage reads as two outages. */}
          {claude && !claudeOk && !signedOut && (
            <MessageBar intent="warning">
              <MessageBarBody>{claude.message}</MessageBarBody>
            </MessageBar>
          )}

          {/* Account-wide sign-in gate: all work is held until a human signs in. Above
              the limit banner because it is the one with an action on it. */}
          <AuthBanner />

          {/* Global usage-limit gate (Phase 5): a countdown while work is parked. */}
          <LimitBanner />
        </>
      }
      // Every screen but My Tasks is a document and wants a margin. My Tasks is a
      // two-panel workspace whose right pane runs to the window's edges.
      padded={tab !== 'mytasks'}
      /* Status bar: Claude readiness + app info, the full width of the window. */
      status={
        <StatusBar attention={attentionCount > 0}>
          {claude ? (
            <>
              <StatusDot ok={Boolean(claudeOk)} />
              <Caption1>
                {/* `signedOut` first: a run has PROVEN the credential is dead, so saying
                    "logged in" because the file is still on disk would be the bar's most
                    confidently wrong moment — which is exactly what it did during the
                    outage this reports. */}
                {signedOut
                  ? `Claude ${claude.version ?? '?'} · signed out — work is held`
                  : claude.installed
                    ? `Claude ${claude.version ?? '?'}${claude.authenticated ? ' · logged in' : ' · not logged in'}`
                    : 'Claude CLI not found'}
                {claude.apiKeyDetected && ' · ANTHROPIC_API_KEY set'}
              </Caption1>
            </>
          ) : bootError ? (
            <>
              <StatusDot ok={false} />
              <Caption1>Backend unavailable</Caption1>
            </>
          ) : (
            <Spinner label="Checking Claude…" labelPosition="after" size="tiny" />
          )}
          {attentionCount > 0 && <Caption1>· {attentionCount} waiting on you</Caption1>}
          {/* No colour of its own: the bar turns orange under attention, and a fixed
              white would go unreadable exactly then. */}
          {sprint && <Caption1>· {sprint}</Caption1>}
          <StatusSpacer />
          {/* A downloaded update installs itself on the next quit either way; this is
              simply the offer to have it now, and the only notice the user ever gets. */}
          {update?.status === 'downloaded' && (
            <Caption1>
              <button
                type="button"
                className={styles.update}
                title="Restart now to finish installing. Otherwise it applies the next time you quit."
                onClick={() => void window.api.invoke('update:install')}
              >
                Update {update.version ?? ''} ready — restart
              </button>
            </Caption1>
          )}
          {/* A failure used to be shown nowhere at all, which is how three releases' worth of
              refused installs went unnoticed. Still not a dialog — one line that points at the
              place where the actual reason is written down. */}
          {update?.status === 'error' && (
            <Caption1>
              <button
                type="button"
                className={styles.update}
                title={describeUpdate(update)}
                onClick={() => setTab('settings')}
              >
                Update failed — see Settings
              </button>
            </Caption1>
          )}
          {/* How much of the two metered windows is gone. Same right-hand group as the sync
              rings, and for the same reason: ambient state you glance at, never a decision.
              The full numbers and the reset countdown are in each one's tooltip, and the
              Performance tab draws the same pair at full size. */}
          <UsageQuotaStatus quotas={quotas} />
          {/* How stale the mirror is, and how long until the next refresh. On the right,
              beside the version: it is ambient state, not something that wants a decision. */}
          <SyncRing state={syncState} />
          {info && (
            <Caption1>
              v{info.version} · electron {info.electron} · node {info.node}
            </Caption1>
          )}
        </StatusBar>
      }
    >
      {tab === 'mytasks' ? (
        <MyTasks />
      ) : tab === 'projects' ? (
        <Projects />
      ) : tab === 'tickets' ? (
        <TicketWorkspace
          repo={{ onBrowseFolder: () => window.api.invoke('project:pickDirectory') }}
        />
      ) : tab === 'performance' ? (
        <Performance />
      ) : tab === 'attention' ? (
        <Attention />
      ) : tab === 'settings' ? (
        <Settings />
      ) : (
        <SessionRunner />
      )}
    </AppShell>
  );
}
