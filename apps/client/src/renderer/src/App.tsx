/**
 * App shell.
 *
 * A frameless window: a custom <TitleBar> (window drag handle + min/max/close)
 * sits flush at the very top, and under it a **vertical nav rail** on the left — every
 * destination `SHELL_NAV` lists except Fleet (the web's own), in `shellNav.ts`'s own order.
 * The rail replaced a horizontal tab strip, which cost every screen a band of height at the
 * top, where a board and a chat pane both want it most. A global usage-limit banner
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
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { AuthState } from '@shared/auth';
import { ACTIVITY_PAGE_MAX, type ActivityCursor } from '@shared/activity';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';
import { hasPlan, hasRepo, type Project, type Task } from '@shared/model';
import { describeUpdate, type UpdateState } from '@shared/update';
import { Attention } from '@ui/Attention';
import { ActivityScreen } from '@ui/activity/ActivityScreen';
import { unreadActivityCount } from '@ui/activity/activityUnread';
import { AutomationsView } from '@ui/automations/AutomationsView';
import { IssuesScreen } from '@ui/issues/IssuesScreen';
import { CommandPalette } from '@ui/palette/CommandPalette';
import { useGlobalShortcut } from '@ui/palette/shortcut';
import { shortcutLabel } from '@ui/palette/shortcutLabel';
import { NewTicketDialog } from '@ui/projects/NewTicketDialog';
import { AuthBanner } from './AuthBanner';
import { LimitBanner } from './LimitBanner';
import { MyTasks } from './MyTasks';
import {
  buildDesktopCommands,
  type DesktopPaletteSnapshot,
  type DesktopPaletteTab,
} from './paletteSource';
import { currentSprintName } from '@ui/board/currentSprint';
// The ticket WORKSPACE (backlog table + Gantt over one ticket project's own tickets),
// distinct from the admin `Projects` screen below — see the TabId doc above.
import { Projects as TicketWorkspace, type ProjectView } from '@ui/projects/Projects';
import { SyncRing } from './SyncRing';
import type { SyncState } from '@shared/sync';
import { Performance } from '@ui/Performance';
import { Projects } from './projects/Projects';
import { Settings, type SettingsSection } from './Settings';
import { SessionRunner } from './SessionRunner';
import { TitleBar } from './TitleBar';
import { useActiveRuns } from './useActiveRuns';
import { UsageQuotaStatus, useUsageQuotas } from '@ui/UsageQuotaBars';
import { AppShell } from '@ui/shell/AppShell';
import { NavRail } from '@ui/shell/NavRail';
import { Sidebar, type SidebarNavTarget, type SidebarSelection } from '@ui/shell/Sidebar';
import { useDeviceFolds } from '@ui/shell/sidebarFolds';
import { openTicketCounts } from '@ui/shell/sidebarProject';
import { SHELL_NAV } from '@ui/shell/shellNav';
import { StatusBar, StatusDot, StatusSpacer } from '@ui/shell/StatusBar';
import { useSidebarData } from '@ui/shell/useSidebarData';
import { useTrackerProject } from '@ui/shell/useTrackerProject';
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
 *
 * Issues (F5.10) browses tracker issues outside the sync query and hands one to an agent.
 */
// Also the command palette's own vocabulary for a screen (F9.4): defined once as
// `DesktopPaletteTab` in `paletteSource.ts` so a screen added there is a screen the rail
// already knows about, and the two can never drift apart.
type TabId = DesktopPaletteTab;

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
  // A card opened from a tab other than My Tasks — Automations' run log is the first
  // caller — queued for My Tasks to select once it's the active tab. See `MyTasks`'
  // `openTaskId`/`onOpenTaskIdHandled`.
  const [pendingOpenTaskId, setPendingOpenTaskId] = useState<string | null>(null);
  const openTaskOnBoard = useCallback((taskId: string) => {
    setPendingOpenTaskId(taskId);
    setTab('mytasks');
  }, []);
  // Add task, queued for My Tasks the same one-shot way `pendingOpenTaskId` is — the
  // command palette's "Add task" (F9.4) is the first caller from outside that screen.
  const [pendingAddTask, setPendingAddTask] = useState(false);
  // A Settings section another screen wants open — the palette's "Settings: …" commands.
  // See `Settings`' own `initialSection`/`onInitialSectionHandled`.
  const [pendingSettingsSection, setPendingSettingsSection] = useState<SettingsSection | null>(
    null,
  );
  /**
   * The board's own cards and delegable repos, read here ONLY so the command palette
   * (F9.4) has something to search and act on from any tab — the board itself (`MyTasks`)
   * keeps its own copies for everything it actually renders. Fetched the same way
   * `readSprint` below already fetches `tasks` for the sprint name; this just keeps the
   * result instead of discarding it.
   */
  const [paletteTasks, setPaletteTasks] = useState<Task[]>([]);
  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  // The card selected on the My Tasks board, reported up by `MyTasks` itself — what the
  // palette's "Start/Stop selected card" acts on, wherever the palette happens to be opened.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /**
   * `paletteTasks`, read fresh at the moment a palette command actually RUNS rather than at
   * the moment the palette opened. `CommandPalette` snapshots its commands once per open, so
   * a card deleted while the palette is still sitting there open would otherwise be resolved
   * against the stale array captured at open time — exactly the "stale rows" failure mode
   * the command palette's design calls out. Assigned every render, the same pattern
   * `MyTasks`' own `scopeRef` uses for the same reason.
   */
  const paletteTasksRef = useRef<Task[]>(paletteTasks);
  paletteTasksRef.current = paletteTasks;
  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalShortcut('mod+k', () => setPaletteOpen(true));
  const { ids: liveRunTaskIds } = useActiveRuns();
  // The v10 mockup's palette context chip ("on TM-71") — the selected card's own tracker key,
  // or `null` for a card with neither (or no card selected at all).
  const selectedPaletteTask = paletteTasks.find((t) => t.id === selectedTaskId);
  const paletteSubjectLabel =
    selectedPaletteTask?.ticketKey ?? selectedPaletteTask?.externalKey ?? null;
  const paletteSnapshot: DesktopPaletteSnapshot = {
    tasks: paletteTasks,
    agentProjects,
    liveRunTaskIds,
    selectedTaskId,
    getTask: (taskId) => paletteTasksRef.current.find((t) => t.id === taskId),
    onNavigate: setTab,
    onOpenTask: openTaskOnBoard,
    onOpenSettingsSection: (section) => {
      setPendingSettingsSection(section);
      setTab('settings');
    },
    onAddTask: () => {
      setPendingAddTask(true);
      setTab('mytasks');
    },
    runTask: async (taskId) => {
      await window.api.invoke('task:run', taskId);
    },
    stopTask: async (taskId) => {
      await window.api.invoke('task:stopAgent', taskId);
    },
  };
  // How many tasks are waiting on a human, shown as a badge on the Attention tab.
  const [attentionCount, setAttentionCount] = useState(0);
  /**
   * The sidebar's own tree (F13.11) is one ticket project's milestones/epics/tickets — the
   * ticket project `useTrackerProject` resolves (F13.17): this device's own remembered
   * choice, or else whichever ticket project has the most open tickets. `trackerProjects`
   * is `null` until the boot effect below resolves, or forever if this machine has no
   * ticket project at all; `openCounts` is kept current by the same `project:tasksChanged`
   * subscription that already refreshes the footer's sprint.
   */
  const [trackerProjects, setTrackerProjects] = useState<Project[] | null>(null);
  const [openCounts, setOpenCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const tracker = useTrackerProject(trackerProjects, openCounts);
  const [sidebarFolds, toggleSidebarFold] = useDeviceFolds('sidebar-folds');
  const sidebarData = useSidebarData(tracker.projectId, { attentionCount, folds: sidebarFolds });
  // The Tickets workspace's own Backlog/Timeline/Graph/Archived view (F14.8) — lifted here so
  // the sidebar's "Archived" row can land on it directly, the same `tab`-lifting reason
  // `tracker.projectId` is lifted rather than left to `TicketWorkspace`'s own default.
  const [ticketsView, setTicketsView] = useState<ProjectView>('backlog');
  const [newIssueDialogOpen, setNewIssueDialogOpen] = useState(false);
  /**
   * The Activity tab's persisted unread baseline (F2.13) — read once at boot, and advanced
   * forward-only by `onSeen` below, which always holds whatever `activity:setLastSeen`
   * actually persisted rather than the raw value `ActivityScreen` reported.
   */
  const [lastSeen, setLastSeen] = useState<ActivityCursor | null>(null);
  const onSeen = useCallback((cursor: ActivityCursor) => {
    void window.api.invoke('activity:setLastSeen', cursor).then(setLastSeen);
  }, []);
  // The Activity tab's unread badge — hidden below while 0 or while that tab is open.
  const [unreadCount, setUnreadCount] = useState(0);
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
      window.api.invoke('activity:getLastSeen').then(setLastSeen),
      // The repos a command palette "Start/Stop selected card" (F9.4) may legally act on —
      // the same filter `MyTasks` applies to its own copy of this list.
      window.api.invoke('project:list').then((projects) => {
        const projectList = projects.map((p) => p.project);
        setAgentProjects(projectList.filter((p) => hasRepo(p) && !hasPlan(p)));
        setTrackerProjects(projectList);
        setOpenCounts(openTicketCounts(projects.flatMap((p) => p.tasks)));
      }),
    ]).catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));

    /** Recompute the footer's sprint from the settings flag and the board's cards — and,
     *  for the same fetch, keep the palette's own copy of the board's cards current. */
    const readSprint = async (): Promise<void> => {
      const [settings, tasks] = await Promise.all([
        window.api.invoke('settings:get'),
        window.api.invoke('board:tasks'),
      ]);
      setSprint(settings.jira.currentSprintOnly ? currentSprintName(tasks) : null);
      setPaletteTasks(tasks);
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
    const offTasks = window.api.on('project:tasksChanged', ({ projectId, tasks }) => {
      void readSprint();
      // Patch just the changed project's count rather than re-reading every project's
      // tasks — the same per-project patch `useSidebarData`'s own `project:tasksChanged`
      // subscription already makes for its tree.
      setOpenCounts((counts) => {
        const next = new Map(counts);
        next.set(projectId, openTicketCounts(tasks).get(projectId) ?? 0);
        return next;
      });
    });
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

  // A project archived (or restored) on the Projects tab changes which projects the
  // switcher should offer — `archive:apply`/`archive:restore` carry no push of their own
  // (see `project:list`'s own doc comment), so re-read it on every tab change instead.
  useEffect(() => {
    void window.api.invoke('project:list').then((projects) => {
      const projectList = projects.map((p) => p.project);
      setTrackerProjects(projectList);
      setOpenCounts(openTicketCounts(projects.flatMap((p) => p.tasks)));
    });
  }, [tab]);

  // The Activity tab's unread badge count. Re-reads whenever `lastSeen` moves and on every
  // `activity:appended` push, with a trailing debounce so a burst of appends (a chain
  // tearing through several steps) triggers one re-read, not one per row.
  useEffect(() => {
    if (!lastSeen) {
      setUnreadCount(0);
      return;
    }
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = (): void => {
      if (pending) return;
      pending = true;
      void window.api
        .invoke('activity:list', { sinceMs: lastSeen.at, limit: ACTIVITY_PAGE_MAX })
        .then((page) => setUnreadCount(unreadActivityCount(page.rows, lastSeen)))
        .catch(() => undefined)
        .finally(() => {
          pending = false;
        });
    };

    refresh();
    const offAppended = window.api.on('activity:appended', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 500);
    });
    return () => {
      offAppended();
      if (timer) clearTimeout(timer);
    };
  }, [lastSeen]);

  // A live gate is hard evidence and beats every part of the file check below it.
  const signedOut = auth !== null;
  const claudeOk =
    !signedOut && claude?.installed && claude?.authenticated && !claude?.apiKeyDetected;

  /** The sidebar's own navigation targets (F13.11), mapped onto this host's `tab` — the same
   *  destinations `shellNav.ts`'s now-deleted `interim` group used to reach from a rail tile.
   *  `machineProject` is a ruling: nothing has asked for a per-project board filter yet, so it
   *  opens the Projects admin tab the same as the team header's own Projects link. */
  const handleSidebarNavigate = (target: SidebarNavTarget): void => {
    switch (target.kind) {
      case 'inbox':
        setTab('attention');
        return;
      case 'myIssues':
        setTab('mytasks');
        return;
      case 'reviews':
        return; // F15 — reviewsEnabled is off, so this never fires yet.
      case 'issues':
        setTab('issues');
        return;
      case 'fleet':
        return; // showFleet is off below — the desktop has no Fleet screen.
      case 'projects':
      case 'machineProject':
        setTab('projects');
        return;
      case 'archived':
        setTicketsView('archived');
        setTab('tickets');
        return;
    }
  };

  /** Which sidebar row reads as selected — the ticket open on the board outranks the plain
   *  "My issues" row once one actually is open, same precedence a Linear-style sidebar gives
   *  the open item over the list it came from. */
  const sidebarSelectedView: SidebarSelection | null =
    tab === 'attention'
      ? { kind: 'inbox' }
      : tab === 'mytasks'
        ? selectedTaskId
          ? { kind: 'ticket', taskId: selectedTaskId }
          : { kind: 'myIssues' }
        : tab === 'issues'
          ? { kind: 'issues' }
          : tab === 'projects'
            ? { kind: 'projects' }
            : tab === 'tickets' && ticketsView === 'archived'
              ? { kind: 'archived' }
              : null;

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sources={[() => buildDesktopCommands(paletteSnapshot)]}
        context={{ currentProjectId: null, subjectLabel: paletteSubjectLabel }}
      />
      <NewTicketDialog
        open={newIssueDialogOpen}
        projectId={tracker.projectId ?? ''}
        tickets={sidebarData.tickets}
        onClose={() => setNewIssueDialogOpen(false)}
      />
      <AppShell
        titleBar={<TitleBar />}
        nav={
          <NavRail
            items={SHELL_NAV}
            // The only label the rail still shows on a tile of its own: Activity's unread
            // rows, hidden while that tab is the one already open — see
            // `unreadActivityCount`'s own docstring on why a human move is excluded from it.
            // Attention's own count moved onto the sidebar's Inbox row (F13.11) along with
            // its rail tile.
            badges={{
              activity: unreadCount > 0 && tab !== 'activity' && (
                <CounterBadge
                  count={unreadCount}
                  color="informative"
                  size="small"
                  appearance="filled"
                />
              ),
            }}
            selected={tab}
            onSelect={(id) => setTab(id as TabId)}
            paletteHint={{
              label: shortcutLabel('mod+k', window),
              onClick: () => setPaletteOpen(true),
            }}
          />
        }
        sidebar={
          <Sidebar
            sections={sidebarData.sections}
            selectedView={sidebarSelectedView}
            onNavigate={handleSidebarNavigate}
            onOpenTicket={openTaskOnBoard}
            onNewIssue={() => {
              if (tracker.projectId) setNewIssueDialogOpen(true);
            }}
            onToggleFold={toggleSidebarFold}
            projectOptions={tracker.projectOptions}
            selectedProjectId={tracker.projectId}
            onSelectProject={tracker.selectProject}
            loading={!sidebarData.loaded}
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
          <MyTasks
            openTaskId={pendingOpenTaskId}
            onOpenTaskIdHandled={() => setPendingOpenTaskId(null)}
            openAddTask={pendingAddTask}
            onOpenAddTaskHandled={() => setPendingAddTask(false)}
            onSelectedTaskIdChange={setSelectedTaskId}
          />
        ) : tab === 'projects' ? (
          <Projects />
        ) : tab === 'tickets' ? (
          <TicketWorkspace
            onShowOnBoard={openTaskOnBoard}
            selectedProjectId={tracker.projectId}
            onSelectProject={tracker.selectProject}
            view={ticketsView}
            onViewChange={setTicketsView}
          />
        ) : tab === 'issues' ? (
          <IssuesScreen onOpenTask={openTaskOnBoard} />
        ) : tab === 'automations' ? (
          <AutomationsView onOpenTask={openTaskOnBoard} />
        ) : tab === 'performance' ? (
          <Performance />
        ) : tab === 'activity' ? (
          <ActivityScreen lastSeen={lastSeen} onSeen={onSeen} onOpenTask={openTaskOnBoard} />
        ) : tab === 'attention' ? (
          <Attention />
        ) : tab === 'settings' ? (
          <Settings
            initialSection={pendingSettingsSection}
            onInitialSectionHandled={() => setPendingSettingsSection(null)}
          />
        ) : (
          <SessionRunner />
        )}
      </AppShell>
    </>
  );
}
