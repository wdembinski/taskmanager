/**
 * The Android client's shell.
 *
 * Same sign-in and cloud-sync plumbing as `apps/web`'s own `App.tsx` — `CloudAuth`,
 * `useCloudAuth`, `useCloudBoard`, the outage/skew banners — all unchanged, all from
 * `@tm/cloud` (docs/plan/README.md, Phase 27 step 2: the sync layer has no host in it).
 * What differs is the frame it's drawn inside: `MobileShell`, not `AppShell`/`NavRail`/
 * `StatusBar` — see that file's own header for why a phone gets its own.
 *
 * The nav carries the same five destinations, in the same order, as the desktop's and
 * `apps/web`'s own (`apps/client/src/renderer/src/App.tsx`, `apps/web/src/App.tsx`) — a
 * structural fact `test/shell-parity.test.ts` now asserts rather than leaves to eyeballing.
 * Scratch run stays off for the same reason it's off on the web: it drives a live
 * `session:start`, host-only by policy (`@tm/shared/ipcRelay`), and a phone is not a host
 * any more than a browser tab is.
 */
import { useMemo, useState } from 'react';
import { Body1, Caption1, makeStyles } from '@fluentui/react-components';
import {
  AlertRegular,
  DataTrendingRegular,
  PlayRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import { Attention } from '@tm/ui/Attention';
import { Performance } from '@tm/ui/Performance';
import type { NavRailItem } from '@tm/ui/shell/NavRail';
import { TransportProvider } from '@tm/ui/transport';
import { CloudAuth } from '@tm/cloud/auth/cloudAuth';
import { SignInScreen } from '@tm/cloud/auth/SignInScreen';
import { useCloudAuth } from '@tm/cloud/auth/useCloudAuth';
import { SettingsScreen } from '@tm/cloud/settings/SettingsScreen';
import { ClientPicker } from '@tm/cloud/board/ClientPicker';
import { SkewBanner } from '@tm/cloud/board/SkewBanner';
import { StaleBanner } from '@tm/cloud/board/StaleBanner';
import { versionSkew } from '@tm/cloud/board/targetClient';
import { useCloudBoard } from '@tm/cloud/board/useCloudBoard';
import { MobileShell } from './shell/MobileShell';
import { loadMobileConfig } from './env';

const useStyles = makeStyles({
  linkButton: {
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
  boardPlaceholder: { padding: '16px' },
});

/** Why a tile that isn't here is off. Appended to its tooltip — same string the web uses. */
const DESKTOP_ONLY = 'desktop only';

/**
 * The desktop's rail, in the desktop's order — kept identical to `apps/web/src/App.tsx`'s
 * own `NAV` on purpose. `test/shell-parity.test.ts` reads both arrays and fails the moment
 * an id is added, dropped, or reordered on one side and not the other.
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

const SCREEN_TITLE: Record<Screen, string> = {
  mytasks: 'My Tasks',
  performance: 'Performance',
  attention: 'Attention',
  settings: 'Settings',
};

export function App(): JSX.Element {
  const config = useMemo(loadMobileConfig, []);
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
  config: ReturnType<typeof loadMobileConfig>;
  signedIn: boolean | null;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}): JSX.Element {
  // Same call as apps/web's own: starting the poll loop before sign-in would spend the
  // whole backoff curve failing, and a shell around a sign-in prompt is dead weight.
  if (signedIn !== true) {
    return <SignInScreen loading={signedIn === null} error={error} onSignIn={signIn} />;
  }
  return <SignedInApp auth={auth} config={config} onSignOut={signOut} />;
}

function SignedInApp({
  auth,
  config,
  onSignOut,
}: {
  auth: CloudAuth;
  config: ReturnType<typeof loadMobileConfig>;
  onSignOut: () => void;
}): JSX.Element {
  const styles = useStyles();
  const board = useCloudBoard(auth, config);
  const [screen, setScreen] = useState<Screen>('mytasks');

  const online = board.state.clients.length > 0;
  const skew = versionSkew(board.targetClient);

  return (
    <TransportProvider transport={board.transport}>
      <MobileShell
        title={SCREEN_TITLE[screen]}
        online={online}
        status={
          online && board.targetClient ? (
            <ClientPicker
              clients={board.state.clients}
              selected={board.targetClient}
              onSelect={board.selectTargetClient}
              className={styles.linkButton}
            />
          ) : board.targetClientId !== null ? (
            'Offline — queued'
          ) : (
            'Never synced'
          )
        }
        onSignOut={onSignOut}
        banners={
          !online ? (
            <StaleBanner everSeenClient={board.targetClientId !== null} />
          ) : skew && board.targetClient ? (
            <SkewBanner skew={skew} client={board.targetClient} />
          ) : null
        }
        nav={NAV}
        selected={screen}
        onSelect={(id) => setScreen(id as Screen)}
      >
        {/* Same unmount-on-leave discipline as apps/web's App.tsx: a screen not being
            looked at should not keep polling. */}
        {screen === 'mytasks' && (
          <div className={styles.boardPlaceholder}>
            <Body1>My Tasks</Body1>
            <Caption1 as="p">
              The tap-to-move board lands in step 6 of this phase (docs/plan/README.md) — this
              screen is wired into the shell now so its route exists before its content does.
            </Caption1>
          </div>
        )}
        {screen === 'performance' && <Performance />}
        {screen === 'attention' && <Attention />}
        {screen === 'settings' && <SettingsScreen />}
      </MobileShell>
    </TransportProvider>
  );
}
