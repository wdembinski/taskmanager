/**
 * Lifts one `CloudAuth` instance into React state: resolves the `/callback` redirect on
 * first mount (once — a second effect run under StrictMode must not try to redeem an
 * already-spent code a second time), then exposes `signedIn` plus `signIn`/`signOut`.
 *
 * Also listens for `CloudAuth` finding the stored grant revoked mid-session — a token
 * refresh run from the board poller, not from here, so nothing else would otherwise turn
 * that into a render. Flipping `signedIn` back to `false` is what sends `AuthedApp` back to
 * `SignInScreen` instead of leaving a board curtained on a connection that will never
 * recover on its own.
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

  useEffect(() => auth.onGrantRevoked(() => setSignedIn(false)), [auth]);

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
