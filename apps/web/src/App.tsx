/**
 * The browser client's shell.
 *
 * Structurally the desktop's, drawn by the same `@tm/ui/shell` pieces: nav rail on the
 * left, screen in the middle, status bar across the bottom. The one slot left empty is
 * `titleBar` — the desktop runs in a frameless window and has to paint its own drag region
 * and min/max/close; a browser tab already has all three above the page.
 *
 * The rail is `SHELL_NAV` (F13.8), the one list both hosts render, even though one of its
 * entries — Scratch run — stays off here. A tile that is present-but-off with "desktop only"
 * in its tooltip is honest where a missing one is merely silent. Fleet is the one tile the
 * desktop does not have at all (cloud as central control for projects, step 6) — a
 * cross-project view of agent profiles and the assignment queue, which only makes sense once
 * an account has more than one desktop serving it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Caption1, makeStyles } from '@fluentui/react-components';
import { BOARD_COLUMNS } from '@tm/shared/model';
import { useLayoutMode } from '@tm/ui/layout/viewport';
import { openCardId, wideSelectionRoute } from '@tm/ui/layout/compactRoute';
import { CommandPalette } from '@tm/ui/palette/CommandPalette';
import { useGlobalShortcut } from '@tm/ui/palette/shortcut';
import { shortcutLabel } from '@tm/ui/palette/shortcutLabel';
import { AppShell } from '@tm/ui/shell/AppShell';
import { Attention } from '@tm/ui/Attention';
import { GateTrustHostProvider } from '@tm/ui/gateTrustHost';
import { Performance } from '@tm/ui/Performance';
import { NewTicketDialog } from '@tm/ui/projects/NewTicketDialog';
import { ProjectAdmin } from '@tm/ui/projects/ProjectAdmin';
import { Projects, type ProjectView } from '@tm/ui/projects/Projects';
import { NavRail } from '@tm/ui/shell/NavRail';
import { Sidebar, type SidebarNavTarget, type SidebarSelection } from '@tm/ui/shell/Sidebar';
import { useDeviceFolds } from '@tm/ui/shell/sidebarFolds';
import { openTicketCounts } from '@tm/ui/shell/sidebarProject';
import { SHELL_NAV, type ShellNavId } from '@tm/ui/shell/shellNav';
import { StatusBar, StatusBusy, StatusDot, StatusSpacer } from '@tm/ui/shell/StatusBar';
import { useSidebarData } from '@tm/ui/shell/useSidebarData';
import { useTrackerProject } from '@tm/ui/shell/useTrackerProject';
import { SyncCurtain } from '@tm/ui/SyncCurtain';
import { TransportProvider } from '@tm/ui/transport';
import { useDelayedFlag } from '@tm/ui/useDelayedFlag';
import { Fleet } from './agents/Fleet';
import { webPaletteSource, type WebPaletteActions } from './palette/webPaletteSource';
import { AutomationsScreen } from './automations/AutomationsScreen';
import { activityGate } from './activity/activityGate';
import { useWebLastSeen } from './activity/useWebLastSeen';
import { WebActivityScreen } from './activity/WebActivityScreen';
import { WebIssuesScreen } from './issues/WebIssuesScreen';
import { CloudAuth } from './auth/cloudAuth';
import { SignInScreen } from './auth/SignInScreen';
import { useCloudAuth } from './auth/useCloudAuth';
import { BoardScreen } from './board/BoardScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { ClientPicker } from './board/ClientPicker';
import { worstConnectionState, type ConnectionState } from './board/connectionState';
import { desktopPresence } from './board/desktopPresence';
import { SkewBanner } from './board/SkewBanner';
import { StaleBanner } from './board/StaleBanner';
import { boardIsReady, syncBusyLabel, syncCurtainText, syncStatusLabel } from './board/syncGate';
import { UnreachableBanner } from './board/UnreachableBanner';
import { describeClient, versionSkew } from './board/targetClient';
import { useCloudBoard, type CloudBoardApi } from './board/useCloudBoard';
import { CompactApp } from './compact/CompactApp';
import { useHashRoute } from './compact/useHashRoute';
import { loadWebConfig } from './env';

/** The wide layout's banner strip, moved onto `worstConnectionState`'s single verdict rather
 *  than the nested ternary it used to be — same three components, same props, so the
 *  rendered tree is unchanged; only the ordering rule's home moves to `connectionState.ts`. */
function connectionBanner(connection: ConnectionState | null): JSX.Element | null {
  switch (connection?.kind) {
    case undefined:
      return null;
    case 'unreachable':
      return <UnreachableBanner message={connection.message} />;
    case 'stale':
      return <StaleBanner everSeenClient={connection.everSeenClient} />;
    case 'skew':
      return <SkewBanner skew={connection.skew} client={connection.client} />;
  }
}

const useStyles = makeStyles({
  /**
   * The Client picker's own link styling, in the status bar. Same treatment as the
   * desktop's update link: no colour of its own (the bar can change fill under it),
   * underlined so it reads as the one clickable thing down here.
   */
  linkButton: {
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
 * The rail's destinations that this app actually renders — `SHELL_NAV` minus Scratch run,
 * which drives a live `session:start`, host-only by policy (`@tm/shared/ipcRelay`). Also
 * `webPaletteSource.ts`'s `goTo` target, which is how it offers every one of them as a
 * navigate command without a way to construct a dead one for Scratch run (not a member of
 * this union).
 *
 * Nine of the ten are live. Attention and Performance moved into `@tm/ui` whole (they had no
 * host in them at all, only `window.api` calls that are `useTransport()` now), and Settings is
 * a fork: nine of its twenty-one channels are host-bound, so the shell is this app's and the
 * host-free sections are shared. Projects renders `ProjectAdmin` — a project's identity (name,
 * colour, the tickets-or-personal choice) is nothing but a row in the store, so a browser
 * manages it exactly as the desktop does; only a project's REPO half (folder, execution
 * target, models, permission mode) stays desktop-only, because that is a fact about a machine
 * only the desktop client sees (`shell-parity.test.ts`, "the web configures a project's
 * identity, never its repo"). Tickets renders the same ticket-project workspace the desktop
 * does — a picker plus its backlog/Gantt, no folder or native picker either. Automations
 * renders the same `AutomationsView` the desktop does, fronted by a web-only owner-desktop
 * banner (`AutomationsScreen`) — an automation fires on the one desktop that created it, never
 * on the cloud service, and this tab is the only host that needs telling so. Fleet is a
 * cross-project read of agent profiles and the assignment queue, over plain REST
 * (`agentsApi.ts`) rather than `useTransport()` — it is the one destination the desktop does
 * not have at all (cloud as central control for projects, step 6), which is why `shellNav.ts`
 * groups it with the sidebar-bound `interim` entries rather than `bar`. Activity renders the
 * same `ActivityScreen` the desktop does (F2.13), fronted by `WebActivityScreen` (F2.14) — a
 * web-only gate over `pollError`/`presence`/`targetClientId`, since this tab's one source is a
 * live desktop and there is nothing stale to fall back to; its `lastSeen`/`onSeen` are backed
 * by a per-desktop localStorage cursor (`useWebLastSeen`) rather than the desktop's own
 * `app_state` key. Issues (F5.10) renders the shared `IssuesScreen` behind `WebIssuesScreen`,
 * which reuses `activityGate` for the same reason: there is a live desktop behind it or there
 * is nothing to show.
 */
export type Screen = Exclude<ShellNavId, 'scratch'>;

/** How often the status bar's "synced Ns ago" recomputes between polls. */
const AGE_TICK_MS = 5_000;

export function App(): JSX.Element {
  const config = useMemo(loadWebConfig, []);
  const auth = useMemo(
    () =>
      new CloudAuth({
        config: {
          issuer: config.iamIssuer,
          clientId: config.iamClientId,
          redirectUri: `${window.location.origin}/callback`,
        },
      }),
    [config],
  );
  const { signedIn, error, signIn, signOut } = useCloudAuth(auth);

  return (
    <AuthedApp
      auth={auth}
      config={config}
      signedIn={signedIn}
      error={error}
      signIn={signIn}
      signOut={signOut}
    />
  );
}

function AuthedApp({
  auth,
  config,
  signedIn,
  error,
  signIn,
  signOut,
}: {
  auth: CloudAuth;
  config: ReturnType<typeof loadWebConfig>;
  signedIn: boolean | null;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}): JSX.Element {
  // The board hook is only mounted once signed in — starting the poll loop with no access
  // token would just spend its whole backoff curve failing until a sign-in happens anyway.
  // The shell goes with it: a rail and a status bar around a sign-in prompt would be five
  // dead tiles and a dot reporting on a connection nobody has asked for yet.
  if (signedIn !== true) {
    return <SignInScreen loading={signedIn === null} error={error} onSignIn={signIn} />;
  }
  return <SignedInBoard auth={auth} config={config} onSignOut={signOut} />;
}

function SignedInBoard({
  auth,
  config,
  onSignOut,
}: {
  auth: CloudAuth;
  config: ReturnType<typeof loadWebConfig>;
  /** Already clears the stored refresh token and flips `useCloudAuth`'s own state — see
   *  its own `signOut`. */
  onSignOut: () => void;
}): JSX.Element {
  // `board.transport` only exists once `useCloudBoard` has run, so it can only ever reach
  // `useSidebarData`'s own `useTransport()` call (below, in `SignedInBoardView`) via a
  // Provider mounted in a PARENT's returned JSX — never via one this same function returns,
  // since a hook call in a component's own body runs before that component's own JSX ever
  // mounts anything. `SignedInBoardView` is the child that is actually wrapped.
  const board = useCloudBoard(auth, config);
  return (
    <TransportProvider transport={board.transport}>
      <SignedInBoardView board={board} auth={auth} config={config} onSignOut={onSignOut} />
    </TransportProvider>
  );
}

function SignedInBoardView({
  board,
  auth,
  config,
  onSignOut,
}: {
  board: CloudBoardApi;
  auth: CloudAuth;
  config: ReturnType<typeof loadWebConfig>;
  onSignOut: () => void;
}): JSX.Element {
  const styles = useStyles();
  const now = useTick(AGE_TICK_MS);
  // Both sources, one indicator: `polling` alone strobes ~24x/min against a 2.5s cadence of
  // sub-200ms requests, and relays alone hide the time the board read itself is in flight.
  // The 500ms delay is what keeps a normal, fast poll from ever lighting it at all.
  const busy = useDelayedFlag(
    board.syncProgress.polling || board.syncProgress.draining || board.pendingRelays > 0,
    500,
  );
  const presence = desktopPresence({
    clients: board.state.clients,
    missingSince: board.missingSince,
    lastPolledAt: board.lastPolledAt,
    now,
  });
  // The Activity tab's per-desktop unread baseline (F2.14), localStorage-backed rather than
  // the desktop's `app_state` key — see `useWebLastSeen`'s own docstring for why it re-reads
  // whenever `board.targetClientId` changes.
  const { lastSeen, onSeen } = useWebLastSeen(board.targetClientId);
  const [screen, setScreen] = useState<Screen>('mytasks');
  // How many tasks are waiting on a human — the same badge and status-bar highlight the
  // desktop shell shows (`apps/client/src/renderer/src/App.tsx`), read the same way over
  // `board.transport`'s `attention:list`/`attention:new`/`attention:resolved`
  // (`useBoardExtras` reads the identical channels for the board's own ring, on its own
  // subscription). Held here rather than inside `BoardScreen` because the nav rail and
  // status bar are the shell's, not the board's, and both need the count with every other
  // screen closed.
  const [attentionCount, setAttentionCount] = useState(0);

  useEffect(() => {
    let live = true;
    void board.transport
      .invoke('attention:list')
      .then((items) => {
        if (live) setAttentionCount(items.length);
      })
      .catch(() => undefined);
    const offNew = board.transport.on('attention:new', () => setAttentionCount((n) => n + 1));
    const offResolved = board.transport.on('attention:resolved', () =>
      setAttentionCount((n) => Math.max(0, n - 1)),
    );
    return () => {
      live = false;
      offNew();
      offResolved();
    };
  }, [board.transport]);

  // Only ever about the Client this tab is actually driving. A second, older desktop on the
  // account is nothing to warn about while nothing is being sent to it.
  const skew = versionSkew(board.targetClient);

  // At most one of the three, in this order, and the order is the point — see
  // `connectionState.ts`'s own header for why unreachable outranks stale outranks skew.
  const connection = worstConnectionState(
    board.pollError,
    presence === 'offline' ? { everSeenClient: board.targetClientId !== null } : null,
    skew && board.targetClient ? { skew, client: board.targetClient } : null,
  );

  // The Changes pane's own read of the same three signals (F6.13) — `WebActivityScreen` and
  // `WebIssuesScreen` already reuse `activityGate` for the identical reason: there is a live
  // desktop to read from, or there isn't, and every screen that needs to know asks the same
  // gate rather than keeping its own copy of the rule.
  const reviewGate = activityGate({
    pollError: board.pollError,
    presence,
    targetClientId: board.targetClientId,
  });
  const hostUnreachable = reviewGate.kind === 'unreachable' ? reviewGate.message : undefined;

  /** What `Fleet` writes through — plain REST, not the transport (see its own docstring). */
  const apiDeps = useMemo(
    () => ({ apiBase: config.cloudApiBase, getAccessToken: () => auth.getAccessToken() }),
    [config.cloudApiBase, auth],
  );

  // Above the layout switch, and read by the WIDE board below rather than by `CompactApp`
  // (which already keeps its own instance): the open card has to survive crossing that
  // switch in either direction, which means the one state it is kept in — the hash route —
  // has to be read before either side of the switch, not owned by whichever side happens
  // to be mounted (F3.7).
  const [route, navigate] = useHashRoute();
  const layoutMode = useLayoutMode();

  /**
   * The sidebar's own tree (F13.11) is one ticket project's milestones/epics/tickets — the
   * ticket project `useTrackerProject` resolves (F13.17): this tab's own remembered choice,
   * or else whichever ticket project has the most open tickets. Read straight off
   * `board.state` rather than a separate `project:list` call — this tab already keeps every
   * project mirrored locally for the board itself.
   */
  const tracker = useTrackerProject(
    Object.values(board.state.projects),
    useMemo(() => openTicketCounts(Object.values(board.state.tasks)), [board.state.tasks]),
  );
  const [sidebarFolds, toggleSidebarFold] = useDeviceFolds('sidebar-folds');
  const sidebarData = useSidebarData(tracker.projectId, { attentionCount, folds: sidebarFolds });
  // The Tickets workspace's own Backlog/Timeline/Graph/Archived view (F14.8) — lifted here,
  // the same `tracker.projectId`-lifting reason, so the sidebar's "Archived" row can land on
  // it directly rather than only on whichever view `Projects` happened to default to.
  const [ticketsView, setTicketsView] = useState<ProjectView>('backlog');
  const [newIssueDialogOpen, setNewIssueDialogOpen] = useState(false);

  /** The sidebar's own navigation targets (F13.11), mapped onto this host's `screen` — the
   *  same destinations `shellNav.ts`'s now-deleted `interim` group used to reach from a rail
   *  tile. `machineProject` is a ruling: nothing has asked for a per-project board filter
   *  yet, so it opens the Tickets workspace the same as the team header's own Projects link
   *  does on the desktop — Projects itself goes to Settings → Projects here instead, since
   *  that is where a WEB user manages a project's identity (`ProjectAdmin`'s own header). */
  const handleSidebarNavigate = (target: SidebarNavTarget): void => {
    switch (target.kind) {
      case 'inbox':
        setScreen('attention');
        return;
      case 'myIssues':
        setScreen('mytasks');
        return;
      case 'reviews':
        return; // F15 — reviewsEnabled is off, so this never fires yet.
      case 'issues':
        setScreen('issues');
        return;
      case 'fleet':
        setScreen('fleet');
        return;
      case 'projects':
        setScreen('projects');
        return;
      case 'machineProject':
        setScreen('tickets');
        return;
      case 'archived':
        setTicketsView('archived');
        setScreen('tickets');
        return;
    }
  };

  /** Which sidebar row reads as selected — the ticket open on the board (via the hash route)
   *  outranks the plain "My issues" row once one actually is open. */
  const sidebarSelectedView: SidebarSelection | null =
    screen === 'attention'
      ? { kind: 'inbox' }
      : screen === 'mytasks'
        ? openCardId(route)
          ? { kind: 'ticket', taskId: openCardId(route)! }
          : { kind: 'myIssues' }
        : screen === 'issues'
          ? { kind: 'issues' }
          : screen === 'fleet'
            ? { kind: 'fleet' }
            : screen === 'projects'
              ? { kind: 'projects' }
              : screen === 'tickets' && ticketsView === 'archived'
                ? { kind: 'archived' }
                : null;

  // The command palette (F9.5) — wide layout only for now, since Ctrl+K has no equivalent on
  // a phone keyboard and "/" would fight the on-screen keyboard's own search affordances.
  // Declared above the layout switch so the hook order stays the same on every render
  // regardless of which branch returns.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useGlobalShortcut('mod+k', openPalette);
  useGlobalShortcut('/', openPalette, { ignoreInFields: true });

  // A palette command landed while `BoardScreen` was already mounted — see its own
  // `paletteRequest` prop doc for why `initialSelectedTaskId` alone cannot reach that case.
  const [paletteRequest, setPaletteRequest] = useState<
    { kind: 'select'; taskId: string; nonce: number } | { kind: 'add'; nonce: number } | null
  >(null);

  const paletteActions: WebPaletteActions = useMemo(
    () => ({
      goTo: (next) => setScreen(next),
      openCard: (taskId) => {
        setScreen('mytasks');
        navigate(wideSelectionRoute(route, taskId, BOARD_COLUMNS[0]));
        setPaletteRequest({ kind: 'select', taskId, nonce: Date.now() });
      },
      addTask: () => {
        setScreen('mytasks');
        setPaletteRequest({ kind: 'add', nonce: Date.now() });
      },
      signOut: onSignOut,
    }),
    [navigate, route, onSignOut],
  );

  const webSource = useMemo(
    () =>
      webPaletteSource(
        () => ({ tasks: board.state.tasks, projects: board.state.projects }),
        paletteActions,
      ),
    [board.state, paletteActions],
  );

  if (layoutMode === 'compact') {
    return (
      <TransportProvider transport={board.transport}>
        {/* The web has no desktop of its own to run a gate command on — only the one this
            tab is relaying through — so every gate's Trust button is replaced with a
            sentence naming it (F8.13). The desktop needs no equivalent wrapper:
            GateTrustHostProvider's absence there is itself the `{ canTrust: true, name:
            null }` default (`gateTrustHost.tsx`). */}
        <GateTrustHostProvider
          value={{
            canTrust: false,
            name: board.targetClient ? describeClient(board.targetClient) : null,
          }}
        >
          <CompactApp
            board={board}
            presence={presence}
            skew={skew}
            attentionCount={attentionCount}
            now={now}
            busy={busy}
            apiBase={config.cloudApiBase}
            getAccessToken={() => auth.getAccessToken()}
            onSignOut={onSignOut}
          />
        </GateTrustHostProvider>
      </TransportProvider>
    );
  }

  return (
    <TransportProvider transport={board.transport}>
      <GateTrustHostProvider
        value={{
          canTrust: false,
          name: board.targetClient ? describeClient(board.targetClient) : null,
        }}
      >
        <AppShell
          nav={
            // Sign out lives in the rail's own Account dropdown rather than the status bar —
            // this is the only host with an account to sign back out of, so it is also the
            // only one passing it. Scratch run (desktop-only) and Attention's own badge both
            // moved off the rail with F13.11 — see the sidebar below.
            <NavRail
              items={SHELL_NAV}
              selected={screen}
              onSelect={(id) => setScreen(id as Screen)}
              accountItems={[{ id: 'signout', label: 'Sign out', onClick: onSignOut }]}
              paletteHint={{ label: shortcutLabel('mod+k', window), onClick: openPalette }}
            />
          }
          sidebar={
            <Sidebar
              sections={sidebarData.sections}
              selectedView={sidebarSelectedView}
              onNavigate={handleSidebarNavigate}
              onOpenTicket={(taskId) => {
                setScreen('mytasks');
                navigate(wideSelectionRoute(route, taskId, BOARD_COLUMNS[0]));
              }}
              onNewIssue={() => {
                if (tracker.projectId) setNewIssueDialogOpen(true);
              }}
              folds={sidebarFolds}
              onToggleFold={toggleSidebarFold}
              showFleet
              projectOptions={tracker.projectOptions}
              selectedProjectId={tracker.projectId}
              onSelectProject={tracker.selectProject}
              loading={!sidebarData.loaded}
            />
          }
          banners={
            // The shell's own banner strip, which is where the desktop's outage bars go too —
            // above the screen rather than inside it, so the board below is the board and
            // nothing shifts the columns down but a thing that had to be said. The ordering
            // rule itself — unreachable outranks stale outranks skew — now lives in
            // `connectionState.ts`'s `worstConnectionState`, computed above, so the compact
            // strip can apply the exact same rule rather than a second copy of it.
            connectionBanner(connection)
          }
          status={
            <StatusBar attention={attentionCount > 0}>
              {presence === 'unknown' ? (
                // Still finding out whether a desktop exists — the dot and its caption both
                // presuppose an answer this tab doesn't have yet, so a busy indicator replaces
                // both rather than guessing "offline" from one empty response.
                <StatusBusy label="Checking for a desktop app…" />
              ) : (
                <>
                  {/* The dot's question is the only one that decides whether an edit made here
                    goes anywhere: a command is delivered to a desktop Client, so with none
                    polling there is nothing to apply it. */}
                  <StatusDot ok={presence === 'online'} />
                  {/* Named, not counted. "2 clients" told you the size of a set you could
                    neither see nor choose from, while every edit made here goes to exactly
                    ONE of them — so the bar says which, and offers the others when there are
                    any. */}
                  <Caption1>
                    {presence === 'online' && board.targetClient ? (
                      <ClientPicker
                        clients={board.state.clients}
                        selected={board.targetClient}
                        onSelect={board.selectTargetClient}
                        className={styles.linkButton}
                      />
                    ) : board.targetClientId !== null ? (
                      'Desktop app offline — edits are queued'
                    ) : (
                      'No desktop app has ever synced this account'
                    )}
                  </Caption1>
                </>
              )}
              {/* A poll that comes back proves this tab's own connection, whether or not it
                carried any deltas — which is a different claim from the dot's. Once the
                board has latched ready, a later paged catch-up shows here as "syncing…"
                rather than pulling the board back behind the curtain.

                `pollError` takes precedence over `syncStatusLabel`'s own reading: it is set
                (and only cleared on a read that actually comes back) by every poll failure,
                even one well after the board has latched ready, where `syncStatusLabel` would
                otherwise still say a stale "synced Ns ago" from the last read that worked. */}
              <Caption1>
                ·{' '}
                {board.pollError
                  ? 'not syncing'
                  : syncStatusLabel(board.syncProgress, board.lastPolledAt, now)}
              </Caption1>
              {/* Data this tab has asked for but does not have yet — a relayed call still in
                flight, or a paged catch-up still draining — distinct from the age caption
                above, which is only about the last read that already landed. */}
              {busy && (
                <StatusBusy
                  label={syncBusyLabel(board.syncProgress, board.pendingRelays) ?? undefined}
                />
              )}
              {attentionCount > 0 && <Caption1>· {attentionCount} waiting on you</Caption1>}
              <StatusSpacer />
              <Caption1>v{__APP_VERSION__}</Caption1>
            </StatusBar>
          }
        >
          {/* Each screen is unmounted rather than hidden when you leave it — every one of
            them polls, and a Performance pane nobody is looking at should not be relaying a
            `usage:summary` every second. The desktop's own `App` folds them the same way. */}
          {screen === 'mytasks' &&
            (boardIsReady(board.syncProgress) ? (
              <BoardScreen
                state={board.state}
                onMoveTask={(taskId, column) => void board.moveTask(taskId, column)}
                onStatusNoted={board.noteStatus}
                // The open-card rotation round trip (F3.7): seeded once from whatever card
                // the hash route named when this wide layout mounted, and written back on
                // every change so a rotation down to compact and back lands on the same
                // card and section rather than resetting to nothing selected.
                initialSelectedTaskId={openCardId(route)}
                onSelectedTaskChange={(taskId) =>
                  navigate(wideSelectionRoute(route, taskId, BOARD_COLUMNS[0]), { replace: true })
                }
                hostUnreachable={hostUnreachable}
                paletteRequest={paletteRequest ?? undefined}
              />
            ) : (
              <SyncCurtain
                {...syncCurtainText(board.syncProgress)}
                error={board.syncProgress.lastError}
              />
            ))}
          {screen === 'projects' && <ProjectAdmin />}
          {screen === 'tickets' && (
            <Projects
              selectedProjectId={tracker.projectId}
              onSelectProject={tracker.selectProject}
              view={ticketsView}
              onViewChange={setTicketsView}
            />
          )}
          {screen === 'issues' && (
            <WebIssuesScreen
              pollError={board.pollError}
              presence={presence}
              targetClientId={board.targetClientId}
              onOpenTask={(taskId) => {
                setScreen('mytasks');
                navigate(wideSelectionRoute(route, taskId, BOARD_COLUMNS[0]));
              }}
            />
          )}
          {screen === 'automations' && (
            <AutomationsScreen clients={board.state.clients} now={now} />
          )}
          {screen === 'fleet' && <Fleet state={board.state} apiDeps={apiDeps} />}
          {screen === 'performance' && <Performance />}
          {screen === 'activity' && (
            <WebActivityScreen
              pollError={board.pollError}
              presence={presence}
              targetClientId={board.targetClientId}
              lastSeen={lastSeen}
              onSeen={onSeen}
              onOpenTask={(taskId) => {
                setScreen('mytasks');
                navigate(wideSelectionRoute(route, taskId, BOARD_COLUMNS[0]));
              }}
            />
          )}
          {screen === 'attention' && <Attention />}
          {/* The mirrored `projects` rows, which this hook already holds for the board — so the
            Settings screen's Projects tab still lists what is configured when no desktop is
            awake to answer its own `agentProject:list`. */}
          {screen === 'settings' && (
            <SettingsScreen
              projects={board.state.projects}
              apiBase={config.cloudApiBase}
              getAccessToken={() => auth.getAccessToken()}
            />
          )}
        </AppShell>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          sources={[webSource]}
          context={{ currentProjectId: null }}
        />
        <NewTicketDialog
          open={newIssueDialogOpen}
          projectId={tracker.projectId ?? ''}
          tickets={sidebarData.tickets}
          onClose={() => setNewIssueDialogOpen(false)}
        />
      </GateTrustHostProvider>
    </TransportProvider>
  );
}

/** Re-renders on a slow interval, so an age in the status bar keeps counting up between
 *  the events that actually change it. */
function useTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
