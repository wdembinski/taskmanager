/**
 * The authorization-code + PKCE dance against vipper.iam, shared verbatim by both callers that
 * need it: the desktop app's loopback flow (`apps/client/src/main/iamSignIn.ts`) and, once
 * `apps/web` exists (Phase 25's "Build the web client on @tm/ui" step), its browser flow — the
 * plan explicitly calls for "the same authorization-code + PKCE flow" in both places, so it is
 * written once, here, rather than twice.
 *
 * Pure `fetch` + Web Crypto (`crypto.getRandomValues`, `crypto.subtle.digest`), both global in
 * every runtime this repo ships to (Node 20+, the Electron 33 main process, and any browser) —
 * no DOM types and no Node-only import, so this file compiles and runs unchanged on either
 * side. See `@vipper/iam-connector`'s own README for why the connector itself doesn't cover
 * this: it's written for a *resource server* (introspect + authorize), not an OIDC *client*.
 */

/** Where to send the user and how to identify this app once they get back. */
export interface IamPkceConfig {
  /** The vipper.iam OIDC issuer, e.g. `https://auth.vipper.network/oidc`. */
  issuer: string;
  /** This app's registered public (no-secret) OAuth client id. */
  clientId: string;
  /** Where vipper.iam redirects after sign-in — a loopback URL for desktop, this origin for web. */
  redirectUri: string;
  /** Space-delimited scopes. Defaults to `openid offline_access` (the latter for a refresh token). */
  scope?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

const DEFAULT_SCOPE = 'openid offline_access';

/** A fresh, random `code_verifier` and its S256 `code_challenge` — generate one per sign-in attempt. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlSafeString(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** A random `state` value — pass the same one to {@link buildAuthorizeUrl} and check it on return. */
export function createState(): string {
  return randomUrlSafeString(16);
}

/** The URL to send the user's browser to, e.g. via `shell.openExternal` or `window.location`. */
export function buildAuthorizeUrl(config: IamPkceConfig, pkce: PkcePair, state: string): string {
  const scope = config.scope ?? DEFAULT_SCOPE;
  const url = new URL(`${config.issuer.replace(/\/+$/, '')}/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  // `prompt=consent` is what makes `offline_access` actually count.
  //
  // vipper.iam runs node-oidc-provider, which SILENTLY DROPS the `offline_access` scope
  // from a request that does not ask for consent — the OIDC spec requires an authorization
  // server to obtain consent before issuing offline access. Dropping it is not an error:
  // the sign-in completes, `/token` answers 200, and the response simply has no
  // `refresh_token` in it.
  //
  // That is invisible from the outside and lands somewhere confusing: `CloudAuth.isSignedIn`
  // is "a refresh token is on file", so a completely successful sign-in looked exactly like
  // never having signed in at all — consent approved, redirect handled, code exchanged, and
  // then straight back to the sign-in screen.
  //
  // Only sent when offline_access is actually being asked for, so a caller that wants a
  // session-only token is not made to click through a consent screen for nothing.
  if (scope.split(/\s+/).includes('offline_access')) {
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}

/** Exchanges the authorization code (from the redirect's `?code=`) for tokens. */
export function exchangeCodeForTokens(
  config: IamPkceConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    config,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    },
    fetchImpl,
  );
}

/** Trades a stored refresh token for a fresh access token (and, per vipper.iam, a rotated refresh token). */
export function refreshTokens(
  config: IamPkceConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId },
    fetchImpl,
  );
}

/**
 * Thrown by {@link postToken} on any non-2xx response. `message` is unchanged from the plain
 * `Error` this replaces — callers pinning that substring (`iamPkce.test.ts`,
 * `cloudToken.test.ts`) keep working — but `oauthError` gives {@link isTerminalGrantError} a
 * structured field to check instead of parsing the message string itself.
 */
export class IamTokenError extends Error {
  readonly status: number;
  /** RFC 6749 `error`, e.g. `invalid_grant` — `null` when the body wasn't an OAuth error. */
  readonly oauthError: string | null;
  readonly oauthErrorDescription: string | null;

  constructor(
    status: number,
    detail: string,
    oauthError: string | null,
    oauthErrorDescription: string | null,
  ) {
    super(`vipper.iam token request failed (${status} ${detail})`);
    this.name = 'IamTokenError';
    this.status = status;
    this.oauthError = oauthError;
    this.oauthErrorDescription = oauthErrorDescription;
  }
}

/**
 * A refresh token (or client registration) vipper.iam will never honor again — retrying it is
 * pointless until the user signs in again (or, for `invalid_client`, until this build is
 * re-registered). Duck-typed on `oauthError` rather than `instanceof IamTokenError`: `@tm/shared`
 * reaches `apps/client` as a source alias but `apps/web`/`apps/server` as built `dist`, two
 * different module instances whose classes fail `instanceof` against each other's errors.
 *
 * The two codes, and why only these two:
 *
 *  - **`invalid_grant`** — the refresh token is expired, revoked, or was replayed. vipper.iam
 *    rotates refresh tokens on every use and a replayed one revokes the whole family, which is
 *    something two browser tabs can do to each other without anybody doing anything wrong.
 *  - **`invalid_client`** — this build's client id is no longer registered. A token minted for
 *    it is equally unusable, and no amount of retrying changes that.
 *
 * Everything else is transient by default, deliberately: a network throw, a 5xx, a 429, a
 * proxy eating the request. Signing somebody out because their wifi dropped would be a worse
 * bug than the one this exists to fix — so the rule is "only when the server named the grant".
 */
export function isTerminalGrantError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const oauthError = (e as { oauthError?: unknown }).oauthError;
  return oauthError === 'invalid_grant' || oauthError === 'invalid_client';
}

/** Best-effort `{ error, error_description }` out of a token error body, JSON or not. */
function parseOAuthError(detail: string): { error: string | null; description: string | null } {
  try {
    const body = JSON.parse(detail) as { error?: unknown; error_description?: unknown };
    return {
      error: typeof body.error === 'string' ? body.error : null,
      description: typeof body.error_description === 'string' ? body.error_description : null,
    };
  } catch {
    // Not JSON — an HTML error page from a proxy/gateway in front of vipper.iam, say. The one
    // fact still worth recovering from prose is whether it names `invalid_grant`.
    return { error: /\binvalid_grant\b/.test(detail) ? 'invalid_grant' : null, description: null };
  }
}

async function postToken(
  config: IamPkceConfig,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(`${config.issuer.replace(/\/+$/, '')}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore — the status code alone is still useful
    }
    const { error, description } = parseOAuthError(detail);
    throw new IamTokenError(res.status, detail, error, description);
  }
  return (await res.json()) as TokenResponse;
}

function randomUrlSafeString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
