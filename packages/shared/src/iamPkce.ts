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

/**
 * What vipper.iam answered when a token request failed — the status, and the OAuth2 `error`
 * code out of the body (RFC 6749 §5.2: `{"error":"invalid_grant", …}` with a 4xx).
 *
 * A typed error rather than the flat `Error` this used to throw, because both callers have to
 * make the SAME decision from it and could not: *is the token on file dead, or was that a
 * blip?* The answer changes what the app does — a dead grant has to end the session, a blip
 * must not — and picking it out of a message string is the kind of guess that ends up wrong on
 * the one release where the wording changes.
 */
export class IamTokenError extends Error {
  constructor(
    readonly status: number,
    /** The OAuth2 `error` code, when the body carried a parseable one. */
    readonly code: string | null,
    /** The raw body, for the log. */
    readonly detail: string,
  ) {
    super(`vipper.iam token request failed (${status}${code ? ` ${code}` : ''} ${detail})`);
    this.name = 'IamTokenError';
  }
}

/**
 * True when the identity server has refused the GRANT itself, so the stored refresh token can
 * never work again and keeping it is keeping a lie.
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
export function isDeadGrant(error: unknown): boolean {
  return (
    error instanceof IamTokenError &&
    (error.code === 'invalid_grant' || error.code === 'invalid_client')
  );
}

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
    throw new IamTokenError(res.status, oauthErrorCode(detail), detail);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * The `error` field out of an RFC 6749 §5.2 body, or null for anything that is not one.
 *
 * Tolerant on purpose: an identity server behind a proxy can answer HTML, and a gateway can
 * answer nothing at all. Neither is a grant decision, and both must read as "no code" rather
 * than throw inside the error path.
 */
function oauthErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
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
