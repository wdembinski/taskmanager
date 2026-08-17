/**
 * The desktop app's one vipper.iam access-token minter — a single-flight cache in front of
 * `refreshTokens`, shared by every caller that needs a cloud bearer token (the sync poller, a
 * manual sync, `cloud:testConnection`, …).
 *
 * The fix this exists for: without single-flight, two callers racing `get()` at once each
 * exchanged the SAME stored refresh token, and vipper.iam rotates a refresh token on every use —
 * the second exchange fails `invalid_grant` against an already-spent token, and the retry loop
 * that followed kept minting with the stale token every 2.5s, spending the *next* rotated token
 * as fast as it was saved. That is the grant-family revocation this class stops: only one
 * `mint()` is ever in flight, so there is only ever one token being spent at a time.
 *
 * No `electron` import — `safeStorage` encryption stays in `ipc.ts`, which passes this class
 * already-decrypted strings in and takes already-plaintext strings back out.
 */
import {
  isTerminalGrantError,
  refreshTokens,
  type IamPkceConfig,
  type TokenResponse,
} from '@shared/iamPkce';

/**
 * - `signed-out` — no refresh token on file.
 * - `stored` — a refresh token is on file but hasn't been (re)tried yet, or was just replaced by
 *   a fresh sign-in.
 * - `active` — the last mint succeeded; `get()` is answering from cache or would mint cleanly.
 * - `rejected` — the last mint hit a terminal grant error (`invalid_grant`); `get()` short-
 *   circuits to `null` without a network call until `renewed()` moves it back to `stored`.
 */
export type CloudAuthState = 'signed-out' | 'stored' | 'active' | 'rejected';

export interface CloudTokenDeps {
  config: () => IamPkceConfig;
  /** Already DECRYPTED — this class never touches `safeStorage`. */
  loadRefreshToken: () => string | null;
  saveRefreshToken: (token: string) => void;
  refresh?: typeof refreshTokens;
  now?: () => number;
  onStateChange?: (state: CloudAuthState) => void;
  log?: (message: string, error?: unknown) => void;
}

/** Matches the buffer `ipc.ts` used before this class existed — mint a little ahead of expiry. */
const EXPIRY_BUFFER_MS = 5_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class CloudTokenProvider {
  private readonly deps: CloudTokenDeps;
  private readonly refresh: typeof refreshTokens;
  private readonly now: () => number;
  private cached: CachedToken | null = null;
  private inflight: Promise<string | null> | null = null;
  private authState: CloudAuthState;

  constructor(deps: CloudTokenDeps) {
    this.deps = deps;
    this.refresh = deps.refresh ?? refreshTokens;
    this.now = deps.now ?? Date.now;
    this.authState = deps.loadRefreshToken() !== null ? 'stored' : 'signed-out';
  }

  state(): CloudAuthState {
    return this.authState;
  }

  /** Why there is no token right now, in the user's words — not yet wired to any UI. */
  explain(): string {
    switch (this.authState) {
      case 'signed-out':
        return 'Not signed in to the cloud.';
      case 'rejected':
        return 'The cloud sign-in was revoked. Sign in again to resume syncing.';
      case 'stored':
        return 'Signed in, but no access token has been minted yet.';
      case 'active':
        return 'Signed in and syncing.';
    }
  }

  /** Never throws — callers treat a `null` exactly like any other failed sync tick. */
  async get(): Promise<string | null> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt > now + EXPIRY_BUFFER_MS) return this.cached.value;
    if (this.authState === 'rejected') return null; // no network: the grant is dead
    if (!this.inflight) {
      const run = this.mint(); // mint() is contracted never to reject
      this.inflight = run;
      void run.finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** A 401 came back on a request that used the cached token — drop it, keep the auth state. */
  invalidate(): void {
    this.cached = null;
  }

  /** `iam:signOut`. */
  forget(): void {
    this.cached = null;
    this.inflight = null;
    this.setState('signed-out');
  }

  /** `iam:signIn` just stored a fresh refresh token — leave `rejected` behind. */
  renewed(): void {
    this.cached = null;
    this.setState('stored');
  }

  private setState(state: CloudAuthState): void {
    if (this.authState === state) return;
    this.authState = state;
    this.deps.onStateChange?.(state);
  }

  private async mint(): Promise<string | null> {
    try {
      const refreshToken = this.deps.loadRefreshToken();
      if (!refreshToken) {
        this.setState('signed-out');
        return null;
      }
      const tokens: TokenResponse = await this.refresh(this.deps.config(), refreshToken);
      // vipper.iam rotates the refresh token on every use — save it BEFORE returning the
      // access token, so a crash between the two never leaves the old (now-spent) one on file.
      if (tokens.refresh_token) this.deps.saveRefreshToken(tokens.refresh_token);
      this.cached = {
        value: tokens.access_token,
        expiresAt: this.now() + tokens.expires_in * 1000,
      };
      this.setState('active');
      return this.cached.value;
    } catch (e) {
      // Anything else (network blip, 503, …) leaves the auth state exactly where it was, so
      // the next get() retries instead of being locked out by one bad tick.
      if (isTerminalGrantError(e)) this.setState('rejected');
      this.deps.log?.('vipper.iam access token refresh failed', e);
      return null;
    }
  }
}
