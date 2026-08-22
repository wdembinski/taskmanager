/**
 * Lifts one `CloudAuth` instance into React state: resolves the `/callback` redirect on
 * first mount (once — a second effect run under StrictMode must not try to redeem an
 * already-spent code a second time), then exposes `signedIn` plus `signIn`/`signOut`.
 *
 * `signedIn` used to be read exactly once, at mount, and never again — so a session that
 * ended while the tab was open could not be noticed, and the app went on drawing a board it
 * could no longer fetch. The subscription below is the other half of `CloudAuth.onSessionEnded`:
 * the tab goes back to the sign-in screen the moment the grant is refused, carrying the reason.
 */
import { useEffect, useRef, useState } from 'react';
import type { CloudAuth } from './cloudAuth';

export interface CloudAuthState {
  /** `null` while the callback redirect (if any) is still being resolved. */
  signedIn: boolean | null;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}

export function useCloudAuth(auth: CloudAuth): CloudAuthState {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolvedCallback = useRef(false);

  useEffect(() => {
    if (resolvedCallback.current) return;
    resolvedCallback.current = true;

    (async () => {
      try {
        const handled = await auth.completeSignIn(new URL(window.location.href));
        if (handled) {
          // The code is single-use — replace the URL so a reload (or StrictMode's second
          // mount) sees a plain page load instead of trying to redeem it again.
          window.history.replaceState(null, '', '/');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSignedIn(auth.isSignedIn());
      }
    })();
  }, [auth]);

  // Its own effect, not folded into the one above: that one is guarded by `resolvedCallback`
  // so it runs a single time ever, and a subscription that never unsubscribed would outlive
  // the component. This one is an ordinary mount/unmount pair.
  useEffect(
    () =>
      auth.onSessionEnded((reason) => {
        setError(reason);
        setSignedIn(false);
      }),
    [auth],
  );

  return {
    signedIn,
    error,
    signIn: () => {
      void auth.beginSignIn();
    },
    signOut: () => {
      auth.signOut();
      setSignedIn(false);
    },
  };
}
