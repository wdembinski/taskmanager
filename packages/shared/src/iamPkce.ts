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
  /** The vipper.iam OIDC issuer, e.g. `https://iam.vipper.network/oidc`. */
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
  const url = new URL(`${config.issuer.replace(/\/+$/, '')}/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope ?? DEFAULT_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
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
    throw new Error(`vipper.iam token request failed (${res.status} ${detail})`);
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
