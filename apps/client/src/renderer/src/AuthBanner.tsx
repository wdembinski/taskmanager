/**
 * Global sign-in banner.
 *
 * When the `claude` CLI can no longer authenticate, the engine holds all work behind one
 * account-wide gate (`@shared/auth`). This is the visible half: what went wrong in the
 * CLI's own words, how many tasks are waiting on it, and the one button that fixes it.
 *
 * Modelled on {@link LimitBanner}, with one deliberate difference. A usage limit ends by
 * itself, so that banner counts down; this one cannot promise anything, because it ends
 * only when a human signs in. So it does not say "resuming soon" — it says what to press.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Caption1,
  makeStyles,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import { signInCommandText, type AuthState } from '@shared/auth';

const useStyles = makeStyles({
  reason: { display: 'block', color: tokens.colorNeutralForeground2 },
  command: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusSmall,
  },
});

export function AuthBanner(): JSX.Element | null {
  const styles = useStyles();
  const [auth, setAuth] = useState<AuthState | null>(null);
  /**
   * Set when the app could not open a terminal for them (a headless box, an unusual
   * desktop). Then the command itself is the fallback, and saying so is the difference
   * between a button that failed silently and one that told you what to type.
   */
  const [manual, setManual] = useState(false);

  useEffect(() => {
    void window.api.invoke('auth:current').then(setAuth);
    return window.api.on('auth:changed', (state) => {
      setAuth(state);
      if (!state) setManual(false);
    });
  }, []);

  if (!auth) return null;

  const parked = auth.parkedTaskIds.length;
  // Named in the title exactly as `describeAuthFailure`'s timeline sentence names it and
  // the readiness panel's fix text names it — the distro, nothing more, since "signed out
  // in Ubuntu-24.04" already says which machine without also saying WSL.
  const host = auth.target?.kind === 'wsl' ? ` in ${auth.target.distro}` : '';
  const command = signInCommandText(auth.target);

  async function signIn(): Promise<void> {
    const opened = await window.api.invoke('auth:signIn');
    setManual(!opened);
  }

  return (
    <MessageBar intent="error" politeness="assertive">
      <MessageBarBody>
        <MessageBarTitle>Claude is signed out{host}</MessageBarTitle> All work is held until you
        sign in again.{' '}
        {parked > 0 &&
          `${parked} task${parked === 1 ? '' : 's'} will resume automatically once you do.`}
        {/* The CLI's own sentence, verbatim: an expired session, a paid-API key and a
            revoked token all read as "signed out" but are fixed three different ways. */}
        <Caption1 className={styles.reason}>
          {auth.source === 'restored' ? 'When the app last ran: ' : ''}
          {auth.reason}
        </Caption1>
        {/* Shown ALWAYS, not only once the button has failed: on a WSL setup the app cannot
            open the distro's terminal from every desktop, and the command is the whole
            answer either way — it should not wait on a button having failed first. */}
        <Caption1 className={styles.reason}>
          {manual ? "Couldn't open a terminal here — run " : 'Or run '}
          <span className={styles.command}>{command}</span>
          {manual ? " yourself, then press I've signed in." : ' yourself.'}
        </Caption1>
      </MessageBarBody>
      <MessageBarActions>
        {/* Opens an interactive `claude`; the OAuth flow needs a terminal and a browser,
            so this is as far as the app can carry it. */}
        <Button size="small" appearance="primary" onClick={() => void signIn()}>
          Sign in
        </Button>
        {/* The escape hatch, and the path the watcher usually beats them to: signing in
            elsewhere rewrites the credentials file and lifts the gate on its own. */}
        <Button size="small" onClick={() => void window.api.invoke('auth:signedIn')}>
          I&apos;ve signed in
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}
