/**
 * The browser client's shell.
 *
 * Structurally the desktop's, drawn by the same `@tm/ui/shell` pieces: nav rail on the
 * left, screen in the middle, status bar across the bottom. The one slot left empty is
 * `titleBar` — the desktop runs in a frameless window and has to paint its own drag region
 * and min/max/close; a browser tab already has all three above the page.
 *
 * The rail carries all eight desktop destinations even though one of them — Scratch run —
 * stays off here. A tile that is present-but-off with "desktop only" in its tooltip is honest
 * where a missing one is merely silent. Fleet is the one tile the desktop does not have at
 * all yet (cloud as central control for projects, step 6) — a cross-project view of agent
 * profiles and the assignment queue, which only makes sense once an account has more than
 * one desktop serving it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Caption1, CounterBadge, makeStyles } from '@fluentui/react-components';
import {
  AlertRegular,
  AppsListDetailRegular,
  BotRegular,
  DataTrendingRegular,
  FolderRegular,
  PlayRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import { AppShell } from '@tm/ui/shell/AppShell';
import { Attention } from '@tm/ui/Attention';
import { Performance } from '@tm/ui/Performance';
import { ProjectAdmin } from '@tm/ui/projects/ProjectAdmin';
import { Projects } from '@tm/ui/projects/Projects';
import { NavRail, type NavRailItem } from '@tm/ui/shell/NavRail';
import { StatusBar, StatusDot, StatusSpacer } from '@tm/ui/shell/StatusBar';
import { SyncCurtain } from '@tm/ui/SyncCurtain';
import { TransportProvider } from '@tm/ui/transport';
import { Fleet } from './agents/Fleet';
import { CloudAuth } from './auth/cloudAuth';
import { SignInScreen } from './auth/SignInScreen';
import { useCloudAuth } from './auth/useCloudAuth';
import { BoardScreen } from './board/BoardScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { ClientPicker } from './board/ClientPicker';
import { SkewBanner } from './board/SkewBanner';
import { StaleBanner } from './board/StaleBanner';
import { boardIsReady, syncCurtainText, syncStatusLabel } from './board/syncGate';
import { UnreachableBanner } from './board/UnreachableBanner';
import { versionSkew } from './board/targetClient';
import { useCloudBoard } from './board/useCloudBoard';
import { loadWebConfig } from './env';

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

/** Why a tile that isn't here is off. Appended to its tooltip. */
const DESKTOP_ONLY = 'desktop only';

/**
 * The desktop's rail, in the desktop's order — see `apps/client/src/renderer/src/App.tsx` —
 * plus Fleet, which the desktop does not have yet (this same plan's own step 6, ahead of the
 * desktop side of it).
 *
 * Six of the eight are live now. Attention and Performance moved into `@tm/ui` whole (they
 * had no host in them at all, only `window.api` calls that are `useTransport()` now), and
 * Settings is a fork: nine of its twenty-one channels are host-bound, so the shell is this
 * app's and the host-free sections are shared. Projects renders `ProjectAdmin` — a project's
 * identity (name, colour, the tickets-or-personal choice) is nothing but a row in the store,
 * so a browser manages it exactly as the desktop does; only a project's REPO half (folder,
 * execution target, models, permission mode) stays desktop-only, because that is a fact about
 * a machine only the desktop client sees (`shell-parity.test.ts`, "the web configures a
 * project's identity, never its repo"). Tickets renders the same ticket-project workspace the
 * desktop does — a picker plus its backlog/Gantt, no folder or native picker either. Fleet is
 * a cross-project read of agent profiles and the assignment queue, over plain REST
 * (`agentsApi.ts`) rather than `useTransport()` — see its own docstring for why. Scratch run
 * stays off — it drives a live `session:start`, which is host-only by policy
 * (`@tm/shared/ipcRelay`).
 */
const NAV: readonly NavRailItem[] = [
  { id: 'mytasks', label: 'My Tasks', icon: <TaskListSquareLtrRegular /> },
  { id: 'projects', label: 'Projects', icon: <FolderRegular /> },
  { id: 'tickets', label: 'Tickets', icon: <AppsListDetailRegular /> },
  { id: 'fleet', label: 'Fleet', icon: <BotRegular /> },
  { id: 'performance', label: 'Performance', icon: <DataTrendingRegular /> },
  { id: 'attention', label: 'Attention', icon: <AlertRegular /> },
  { id: 'settings', label: 'Settings', icon: <SettingsRegular /> },
  { id: 'scratch', label: 'Scratch run', icon: <PlayRegular />, unavailable: DESKTOP_ONLY },
];

/** The rail's destinations that this app actually renders. */
type Screen =
  'mytasks' | 'projects' | 'tickets' | 'fleet' | 'performance' | 'attention' | 'settings';

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
  const styles = useStyles();
  const board = useCloudBoard(auth, config);
  const now = useTick(AGE_TICK_MS);
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

  const online = board.state.clients.length > 0;
  // Only ever about the Client this tab is actually driving. A second, older desktop on the
  // account is nothing to warn about while nothing is being sent to it.
  const skew = versionSkew(board.targetClient);

  /** What `Fleet` writes through — plain REST, not the transport (see its own docstring). */
  const apiDeps = useMemo(
    () => ({ apiBase: config.cloudApiBase, getAccessToken: () => auth.getAccessToken() }),
    [config.cloudApiBase, auth],
  );

  return (
    <TransportProvider transport={board.transport}>
      <AppShell
        nav={
          // Scratch run refuses selection inside `NavRail` (it is the one tile still marked
          // unavailable), so anything that reaches here is a real destination. Sign out lives
          // in the rail's own Account dropdown rather than the status bar — this is the only
          // host with an account to sign back out of, so it is also the only one passing it.
          <NavRail
            items={NAV.map((item) =>
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
            selected={screen}
            onSelect={(id) => setScreen(id as Screen)}
            accountItems={[{ id: 'signout', label: 'Sign out', onClick: onSignOut }]}
          />
        }
        banners={
          // The shell's own banner strip, which is where the desktop's outage bars go too —
          // above the screen rather than inside it, so the board below is the board and
          // nothing shifts the columns down but a thing that had to be said.
          //
          // At most one of the three, in this order, and the order is the point:
          //
          //  1. **This tab cannot read at all.** Everything below is a claim about what the
          //     server said, and it has said nothing. Reporting "no desktop app has synced"
          //     here would be blaming another machine for a failure in this one — which is
          //     precisely what sent somebody hunting through a perfectly healthy desktop.
          //  2. **No desktop client is polling.** The bigger fact once reads work.
          //  3. **Version skew**, which cannot matter until a Client is back.
          board.pollError ? (
            <UnreachableBanner message={board.pollError} />
          ) : !online ? (
            <StaleBanner everSeenClient={board.targetClientId !== null} />
          ) : skew && board.targetClient ? (
            <SkewBanner skew={skew} client={board.targetClient} />
          ) : null
        }
        status={
          <StatusBar attention={attentionCount > 0}>
            {/* The dot's question is the only one that decides whether an edit made here
                goes anywhere: a command is delivered to a desktop Client, so with none
                polling there is nothing to apply it. */}
            <StatusDot ok={online} />
            {/* Named, not counted. "2 clients" told you the size of a set you could neither
                see nor choose from, while every edit made here goes to exactly ONE of them —
                so the bar says which, and offers the others when there are any. */}
            <Caption1>
              {online && board.targetClient ? (
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
              everSeenClient={board.targetClientId !== null}
              onSetStatus={(taskId, status) => void board.setStatus(taskId, status)}
              onStatusNoted={board.noteStatus}
            />
          ) : (
            <SyncCurtain
              {...syncCurtainText(board.syncProgress)}
              error={board.syncProgress.lastError}
            />
          ))}
        {screen === 'projects' && <ProjectAdmin />}
        {screen === 'tickets' && <Projects />}
        {screen === 'fleet' && <Fleet state={board.state} apiDeps={apiDeps} />}
        {screen === 'performance' && <Performance />}
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
