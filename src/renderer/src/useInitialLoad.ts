/**
 * Runs a screen's initial data load and captures its failure.
 *
 * Every screen used to seed itself with `window.api.invoke(...).then(setState)` and no
 * `.catch`, rendering a spinner while the state was still null. That turns ANY backend
 * failure into a permanent spinner: when v0.25.0's Linux build failed to open its
 * database, no IPC handler was ever registered, every invoke rejected, and all seven
 * tabs sat on "Loading…" with nothing on screen to say why.
 *
 * The hook deliberately owns only the error, not the data. Screens keep their own state
 * setters because they also update from live `window.api.on(...)` events, and taking
 * that over would mean rewriting each one. This way the fix is one line per screen.
 */
import { useCallback, useEffect, useState } from 'react';

export interface InitialLoad {
  /** The failure message, or null while loading and after a success. */
  error: string | null;
  /** Re-run the load — wire this to the Retry button. */
  retry: () => void;
}

/**
 * @param load the screen's seed fetch; must be stable (wrap it in `useCallback`), since
 *   it doubles as the effect's dependency exactly like a hand-written `useEffect` would.
 */
export function useInitialLoad(load: () => Promise<unknown>): InitialLoad {
  const [error, setError] = useState<string | null>(null);
  // Bumped by `retry` to re-run the effect without touching `load`'s identity.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load().catch((e: unknown) => {
      if (cancelled) return;
      // An IPC rejection arrives as "Error invoking remote method 'x': Error: real
      // message" — keep the whole thing; the channel name is a genuine clue here.
      setError(e instanceof Error ? e.message : String(e));
    });
    // A screen can be unmounted by a tab switch mid-flight; don't set state after that.
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { error, retry };
}
