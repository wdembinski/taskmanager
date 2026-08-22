/**
 * The desktop app's cloud credential: a personal access token, pasted once into Settings and
 * held as-is until it is replaced or the cloud rejects it. Keeps the class name and its
 * `get()` / `invalidate()` / `state()` / `explain()` surface — the five existing call sites in
 * `ipc.ts`, and the `onAuthRejected` wiring on `cloudPoller.ts`, all keep working unchanged.
 * Everything BEHIND that surface collapses: no config, no network, no clock-driven expiry, no
 * single-flight.
 *
 * This file used to open with the single-flight argument: vipper.iam rotates a refresh token
 * on every use, so two callers racing a mint each spent the SAME stored token and the second
 * exchange failed `invalid_grant` against an already-spent one. A pasted token is not
 * exchanged for anything and does not rotate — there is nothing left here to race, which is
 * why `get()` below is just a read.
 *
 * No `electron` import — `safeStorage` decryption stays in `ipc.ts`, which passes this class
 * an already-decrypted string in and takes an already-plaintext string back out.
 */

/**
 * - `no-token` — nothing stored.
 * - `stored` — a token is on file but has not yet been used on a request that answered.
 * - `active` — the last request that used this token succeeded.
 * - `rejected` — the last request that used this token got a 401; `get()` short-circuits to
 *   `null` without handing it out again until the stored token changes.
 */
export type CloudAuthState = 'no-token' | 'stored' | 'active' | 'rejected';

export interface CloudTokenDeps {
  /** Already DECRYPTED — this class never touches `safeStorage`. */
  loadPat: () => string | null;
  now?: () => number;
  onStateChange?: (state: CloudAuthState) => void;
  log?: (message: string, error?: unknown) => void;
}

export class CloudTokenProvider {
  private readonly deps: CloudTokenDeps;
  private readonly now: () => number;
  private authState: CloudAuthState;
  /** When a request using the current token last succeeded — for the Settings UI's "token
   *  last confirmed Ns ago". Cleared by `invalidate()`/`reload()`: a stale timestamp from a
   *  since-replaced token would read as freshness that never happened. */
  private lastAcceptedAtValue: number | null = null;

  constructor(deps: CloudTokenDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.authState = deps.loadPat() !== null ? 'stored' : 'no-token';
  }

  state(): CloudAuthState {
    return this.authState;
  }

  /** When the current token last confirmed working, or null if it never has since
   *  construction or the last `invalidate()`/`reload()`. */
  lastAcceptedAt(): number | null {
    return this.lastAcceptedAtValue;
  }

  /** Why there is no token right now, in the user's words. Wired into `CloudConfigStatus.
   *  authError` and `CloudPollerDeps.describeMissingToken`. */
  explain(): string {
    switch (this.authState) {
      case 'no-token':
        return 'No token stored. Create one in the web app and paste it into Cloud settings.';
      case 'rejected':
        return 'The cloud rejected this token. It has been revoked or has expired — create a new one in the web app and paste it here.';
      case 'stored':
        return 'A token is stored, but it has not synced yet.';
      case 'active':
        return 'Signed in and syncing.';
    }
  }

  /** Never throws. Null when nothing is stored, or the stored token was just rejected. */
  async get(): Promise<string | null> {
    if (this.authState === 'rejected') return null; // no network: this token is dead
    const token = this.deps.loadPat();
    if (!token) {
      this.setState('no-token');
      return null;
    }
    if (this.authState === 'no-token') this.setState('stored');
    return token;
  }

  /**
   * A request using the current token came back 401. Sets `'rejected'`, not merely a cache
   * drop — a token that only vanished from a cache would be re-read from `loadPat()` on the
   * very next `get()` and handed out again unchanged, which is exactly the dead-token spam
   * this state exists to stop. `cloudPoller.ts`'s inline retry calls `getAccessToken()` again
   * right after this, gets `null`, and sends nothing — see its own header.
   */
  invalidate(): void {
    this.lastAcceptedAtValue = null;
    this.setState('rejected');
  }

  /** A request using the current token just succeeded. Called from the poller's success path. */
  accepted(now: number = this.now()): void {
    this.lastAcceptedAtValue = now;
    this.setState('active');
  }

  /**
   * The stored token changed underneath this provider — `cloud:setCredentials` just saved a
   * fresh paste, or `cloud:clearCredentials` just removed one. Re-derives state from
   * `loadPat()` so the very next `cloud:getConfigStatus` reflects the change immediately,
   * rather than waiting for the next poll tick to notice.
   */
  reload(): void {
    this.lastAcceptedAtValue = null;
    this.setState(this.deps.loadPat() !== null ? 'stored' : 'no-token');
  }

  private setState(state: CloudAuthState): void {
    if (this.authState === state) return;
    this.authState = state;
    this.deps.onStateChange?.(state);
  }
}
