/**
 * vipper.iam sign-in for the browser: the same authorization-code + PKCE dance
 * `apps/client/src/main/iamSignIn.ts` runs against a loopback listener, run here against a
 * real browser redirect instead — `@tm/shared/iamPkce` is the shared half both sides call
 * (see that file's own header for why it was written once, for this exact moment).
 *
 * There is no OS keychain in a browser, so the refresh token is kept in `localStorage`
 * rather than `safeStorage`-encrypted like the desktop build. That is the ordinary
 * trade-off for a PKCE public-client SPA (the token is scoped to this one account's
 * `taskmanager` resource, and PKCE means there is no client secret it could also expose);
 * it is not a hidden downgrade from the desktop build's own security, which never had an
 * OS keychain to lean on for its OWN browser-based sign-in step either — only for where it
 * stashes the result afterwards.
 *
 * The access token itself is kept in memory only (`AccessTokenCache`), minted from the
 * stored refresh token and re-minted a few seconds before it would expire — the same cache
 * shape `ipc.ts`'s `getCloudAccessToken` uses, so the two clients' token-refresh behaviour
 * reads the same way side by side.
 */
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  isTerminalGrantError,
  refreshTokens,
  type IamPkceConfig,
  type TokenResponse,
} from '@tm/shared/iamPkce';

const REFRESH_TOKEN_KEY = 'tm.cloud.refreshToken';
const PKCE_STATE_KEY = 'tm.cloud.pkce';
const CALLBACK_PATH = '/callback';
/** Re-mint this far ahead of actual expiry — matches `ipc.ts`'s own buffer. */
const EXPIRY_BUFFER_MS = 5_000;

export interface AccessTokenCache {
  value: string;
  expiresAt: number;
}

/** The one thing worth keeping across the redirect: state to check, verifier to redeem with. */
interface PendingPkce {
  state: string;
  verifier: string;
}

/**
 * Whether `cache` is still good to use `EXPIRY_BUFFER_MS` from `now` — pulled out as a pure
 * function because it is the one piece of `CloudAuth.getAccessToken` worth a test without
 * faking `fetch` and browser storage around it too.
 */
export function isAccessTokenFresh(cache: AccessTokenCache | null, now: number): boolean {
  return cache !== null && cache.expiresAt > now + EXPIRY_BUFFER_MS;
}

export interface CloudAuthConfig extends Omit<IamPkceConfig, 'redirectUri'> {
  /** Where vipper.iam redirects back to — normally `${window.location.origin}/callback`. */
  redirectUri: string;
}

export interface CloudAuthDeps {
  config: CloudAuthConfig;
  /** Injected for tests; defaults to the real browser storages. */
  localStorage?: Storage;
  sessionStorage?: Storage;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Owns the whole sign-in lifecycle for one browser session: starting it, completing it on
 * the `/callback` redirect, minting/caching an access token, and signing out.
 *
 * Deliberately NOT a React hook itself — `useCloudAuth.ts` wraps one instance in state so
 * components re-render on sign-in/out, but the state machine underneath has no React
 * dependency and can be driven from a test the same way `iamSignIn.ts` is.
 */
export class CloudAuth {
  private readonly config: CloudAuthConfig;
  private readonly localStorage: Storage;
  private readonly sessionStorage: Storage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private accessToken: AccessTokenCache | null = null;
  /** Collapses concurrent `getAccessToken()` callers onto one `/token` exchange — same fix
   *  as the desktop's `CloudTokenProvider`: two callers racing a refresh each spend the SAME
   *  stored refresh token, and vipper.iam rotates it on every use, so the loser's exchange
   *  fails `invalid_grant` against an already-spent token. */
  private inflight: Promise<string | null> | null = null;
  private readonly revokedListeners = new Set<() => void>();

  constructor(deps: CloudAuthDeps) {
    this.config = deps.config;
    this.localStorage = deps.localStorage ?? window.localStorage;
    this.sessionStorage = deps.sessionStorage ?? window.sessionStorage;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Whether a refresh token is on file — the UI's "signed in" flag, no network involved. */
  isSignedIn(): boolean {
    return this.localStorage.getItem(REFRESH_TOKEN_KEY) !== null;
  }

  /**
   * Redirects the whole page to vipper.iam's `/auth` — there is no loopback listener here,
   * the browser tab itself IS the redirect target, so this never returns.
   */
  async beginSignIn(): Promise<void> {
    const pkce = await createPkcePair();
    const state = createState();
    this.sessionStorage.setItem(PKCE_STATE_KEY, JSON.stringify({ state, verifier: pkce.verifier }));
    window.location.assign(buildAuthorizeUrl(this.config, pkce, state));
  }

  /**
   * Call once on load with the current URL. If it is vipper.iam's redirect back to
   * `/callback`, exchanges the code, saves the refresh token, and returns `true` — the
   * caller should then replace the URL (`history.replaceState`) so a reload doesn't
   * resubmit a spent code. `false` for every other URL, including a plain reload of the
   * app with no pending sign-in.
   */
  async completeSignIn(url: URL): Promise<boolean> {
    if (url.pathname !== CALLBACK_PATH) return false;

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const pendingRaw = this.sessionStorage.getItem(PKCE_STATE_KEY);
    this.sessionStorage.removeItem(PKCE_STATE_KEY);

    if (error) throw new Error(`vipper.iam sign-in failed: ${error}`);
    if (!code || !returnedState || !pendingRaw) {
      throw new Error('vipper.iam redirected with no authorization code.');
    }
    const pending = JSON.parse(pendingRaw) as PendingPkce;
    if (pending.state !== returnedState) {
      throw new Error('Sign-in state mismatch — please try signing in again.');
    }

    const tokens = await exchangeCodeForTokens(
      { ...this.config, redirectUri: this.config.redirectUri },
      code,
      pending.verifier,
      this.fetchImpl,
    );
    this.saveTokens(tokens);
    return true;
  }

  /**
   * A bearer access token for right now, or `null` when there is nothing to mint one from
   * (never signed in, or signed out) — the caller (the board poller, `HttpTransport`)
   * treats that exactly like any other tick with no token: a failed request, counted and
   * retried, not a special case.
   */
  async getAccessToken(): Promise<string | null> {
    if (isAccessTokenFresh(this.accessToken, this.now())) {
      return this.accessToken!.value;
    }
    // Every caller racing here (the poller, the transport, the presence heartbeat) shares
    // the one mint in flight rather than each spending the same stored refresh token.
    if (!this.inflight) {
      const run = this.mint();
      this.inflight = run;
      void run.finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Run `cb` when a refresh has just found the stored grant permanently dead — the browser's
   *  honest move is back to the sign-in screen, unlike the desktop (which keeps the token and
   *  warns in its Settings pane, having somewhere to warn). `useCloudAuth` is the only
   *  subscriber: it flips its React `signedIn` state so `AuthedApp` stops curtaining on a
   *  board that will never sync again. */
  onGrantRevoked(cb: () => void): () => void {
    this.revokedListeners.add(cb);
    return () => this.revokedListeners.delete(cb);
  }

  signOut(): void {
    this.accessToken = null;
    this.localStorage.removeItem(REFRESH_TOKEN_KEY);
  }

  private async mint(): Promise<string | null> {
    const refreshToken = this.localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) return null;

    try {
      const tokens = await refreshTokens(
        { ...this.config, redirectUri: '' },
        refreshToken,
        this.fetchImpl,
      );
      this.saveTokens(tokens);
      return this.accessToken!.value;
    } catch (e) {
      // Same fail-soft shape as `ipc.ts`'s own `getCloudAccessToken`: the poller treats a
      // null token exactly like any other failed tick (counted, backed off, retried), not a
      // special case — UNLESS vipper.iam has actually revoked the grant, which would fail
      // every retry identically. Drop the dead refresh token so the next call short-circuits
      // to null with no network request, and tell `useCloudAuth` to stop pretending.
      if (isTerminalGrantError(e)) {
        this.localStorage.removeItem(REFRESH_TOKEN_KEY);
        for (const cb of this.revokedListeners) cb();
      }
      console.warn('vipper.iam access token refresh failed', e);
      return null;
    }
  }

  private saveTokens(tokens: TokenResponse): void {
    if (tokens.refresh_token) {
      this.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
    }
    this.accessToken = {
      value: tokens.access_token,
      expiresAt: this.now() + tokens.expires_in * 1000,
    };
  }
}
