/**
 * The browser client's shell.
 *
 * Structurally the desktop's, drawn by the same `@tm/ui/shell` pieces: nav rail on the
 * left, screen in the middle, status bar across the bottom. The one slot left empty is
 * `titleBar` — the desktop runs in a frameless window and has to paint its own drag region
 * and min/max/close; a browser tab already has all three above the page.
 *
 * The rail carries all five desktop destinations even though only one of them is mirrored
 * here. A rail with a single tile on it looks like a different application, and a tile
 * that is present-but-off with "desktop only" in its tooltip is honest where a missing one
 * is merely silent.
 */
import { useEffect, useMemo, useState } from 'react';
import { Caption1, makeStyles } from '@fluentui/react-components';
import {
  AlertRegular,
  DataTrendingRegular,
  PlayRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import { AppShell } from '@tm/ui/shell/AppShell';
import { Attention } from '@tm/ui/Attention';
import { Performance } from '@tm/ui/Performance';
import { NavRail, type NavRailItem } from '@tm/ui/shell/NavRail';
import { StatusBar, StatusDot, StatusSpacer } from '@tm/ui/shell/StatusBar';
import { TransportProvider } from '@tm/ui/transport';
import { CloudAuth } from './auth/cloudAuth';
import { SignInScreen } from './auth/SignInScreen';
import { useCloudAuth } from './auth/useCloudAuth';
import { BoardScreen } from './board/BoardScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { StaleBanner } from './board/StaleBanner';
import { useCloudBoard } from './board/useCloudBoard';
import { loadWebConfig } from './env';

const useStyles = makeStyles({
  /**
   * Sign out, in the status bar rather than on the board's toolbar — which is what lets
   * that toolbar hold the same things `MyTasks`'s does. Same treatment as the desktop's
   * update link: no colour of its own (the bar can change fill under it), underlined so it
   * reads as the one clickable thing down here.
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
 * The desktop's rail, in the desktop's order — see `apps/client/src/renderer/src/App.tsx`.
 *
 * Four of the five are live now. Attention and Performance moved into `@tm/ui` whole (they
 * had no host in them at all, only `window.api` calls that are `useTransport()` now), and
 * Settings is a fork: nine of its twenty-one channels are host-bound, so the shell is this
 * app's and the host-free sections are shared. Scratch run stays off — it drives a live
 * `session:start`, which is host-only by policy (`@tm/shared/ipcRelay`).
 */
const NAV: readonly NavRailItem[] = [
  { id: 'mytasks', label: 'My Tasks', icon: <TaskListSquareLtrRegular /> },
  { id: 'performance', label: 'Performance', icon: <DataTrendingRegular /> },
  { id: 'attention', label: 'Attention', icon: <AlertRegular /> },
  { id: 'settings', label: 'Settings', icon: <SettingsRegular /> },
  { id: 'scratch', label: 'Scratch run', icon: <PlayRegular />, unavailable: DESKTOP_ONLY },
];

/** The rail's destinations that this app actually renders. */
type Screen = 'mytasks' | 'performance' | 'attention' | 'settings';

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

  const online = board.state.clients.length > 0;

  return (
    <TransportProvider transport={board.transport}>
      <AppShell
        nav={
          // Scratch run refuses selection inside `NavRail` (it is the one tile still marked
          // unavailable), so anything that reaches here is a real destination.
          <NavRail items={NAV} selected={screen} onSelect={(id) => setScreen(id as Screen)} />
        }
        banners={
          // The shell's own banner strip, which is where the desktop's outage bars go too —
          // above the screen rather than inside it, so the board below is the board and
          // nothing shifts the columns down but a thing that had to be said.
          !online ? <StaleBanner everSeenClient={board.targetClientId !== null} /> : null
        }
        status={
          <StatusBar>
            {/* The dot's question is the only one that decides whether an edit made here
                goes anywhere: a command is delivered to a desktop Client, so with none
                polling there is nothing to apply it. */}
            <StatusDot ok={online} />
            <Caption1>
              {online
                ? `Desktop app connected · ${board.state.clients.length} client${board.state.clients.length === 1 ? '' : 's'}`
                : board.targetClientId !== null
                  ? 'Desktop app offline — edits are queued'
                  : 'No desktop app has ever synced this account'}
            </Caption1>
            {/* A poll that comes back proves this tab's own connection, whether or not it
                carried any deltas — which is a different claim from the dot's. */}
            <Caption1>
              ·{' '}
              {board.lastPolledAt === null
                ? 'first sync pending'
                : `synced ${describeAge(now - board.lastPolledAt)}`}
            </Caption1>
            <StatusSpacer />
            <Caption1>
              <button type="button" className={styles.linkButton} onClick={onSignOut}>
                Sign out
              </button>
            </Caption1>
            <Caption1>v{__APP_VERSION__}</Caption1>
          </StatusBar>
        }
      >
        {/* Each screen is unmounted rather than hidden when you leave it — every one of
            them polls, and a Performance pane nobody is looking at should not be relaying a
            `usage:summary` every second. The desktop's own `App` folds them the same way. */}
        {screen === 'mytasks' && (
          <BoardScreen
            state={board.state}
            everSeenClient={board.targetClientId !== null}
            onSetStatus={(taskId, status) => void board.setStatus(taskId, status)}
            onStatusNoted={board.noteStatus}
          />
        )}
        {screen === 'performance' && <Performance />}
        {screen === 'attention' && <Attention />}
        {screen === 'settings' && <SettingsScreen />}
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

/** A duration in ms as the coarsest unit that still says something — `12s ago`, `3m ago`. */
function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
