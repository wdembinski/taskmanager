/**
 * "Link desktop" — mints a vipper.iam Personal Access Token from this signed-in browser tab,
 * so the desktop app can be linked without running its own OAuth loopback flow (useful on a
 * machine that can't open a browser to sign itself in).
 *
 * A PAT is not this repo's concept: it is vipper.iam's own account-level credential, created
 * through its `POST /me/tokens` (see the sibling repo's
 * `docs/04-how-to/use-personal-access-tokens.md`), authenticated with whatever bearer this
 * tab already holds — the same access token `CloudAuth.getAccessToken()` hands `httpTransport`.
 * Nothing on `@tm/server`'s side changes: `IamAuthGuard` already accepts a PAT wherever it
 * accepts an OAuth access token, because both go through the identical
 * `POST /oauth/introspect` call — vipper.iam's introspection endpoint checks a presented PAT
 * the same way it checks an OAuth token, so a PAT pasted into the desktop's "link with a
 * token" field authenticates exactly as if that machine had signed in itself.
 *
 * Deliberately pure functions with an injected `fetch`/token accessor, same shape as
 * `apps/client/src/main/cloudTestConnection.ts` — testable without a browser or a real
 * network call.
 */

export interface DeviceToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface DeviceTokenDeps {
  /** vipper.iam's REST API base, e.g. `https://auth.vipper.network/api/v1` — `WebConfig.iamApiBase`. */
  apiBase: string;
  /** The same accessor `CloudAuth.getAccessToken` exposes — null when signed out. */
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export type DeviceTokenResult<T> = ({ ok: true } & T) | { ok: false; message: string };

const NOT_SIGNED_IN = { ok: false as const, message: 'Not signed in.' };

/** Every non-revoked-or-not token this account holds, newest first — as vipper.iam returns them. */
export async function listDeviceTokens(
  deps: DeviceTokenDeps,
): Promise<DeviceTokenResult<{ tokens: DeviceToken[] }>> {
  const token = await deps.getAccessToken();
  if (!token) return NOT_SIGNED_IN;

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.apiBase}/me/tokens`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ok: false, message: `vipper.iam answered ${res.status} listing tokens.` };
    }
    return { ok: true, tokens: (await res.json()) as DeviceToken[] };
  } catch (e) {
    return { ok: false, message: `Could not reach vipper.iam. (${errorText(e)})` };
  }
}

/**
 * Creates one token. The secret is returned exactly once, here — vipper.iam stores only its
 * hash, so a page reload (or forgetting to copy it) means starting over with a new token,
 * same as vipper.iam's own Tokens page.
 */
export async function createDeviceToken(
  deps: DeviceTokenDeps,
  name: string,
): Promise<DeviceTokenResult<{ token: DeviceToken; secret: string }>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: 'Give the token a name, e.g. "My laptop".' };

  const accessToken = await deps.getAccessToken();
  if (!accessToken) return NOT_SIGNED_IN;

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.apiBase}/me/tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) {
      return { ok: false, message: `vipper.iam refused to create a token (${res.status}).` };
    }
    const { token: secret, ...token } = (await res.json()) as DeviceToken & { token: string };
    return { ok: true, token, secret };
  } catch (e) {
    return { ok: false, message: `Could not reach vipper.iam. (${errorText(e)})` };
  }
}

/** Revokes one token by id. Idempotent, same as vipper.iam's own `DELETE /me/tokens/:id`. */
export async function revokeDeviceToken(
  deps: DeviceTokenDeps,
  id: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = await deps.getAccessToken();
  if (!token) return NOT_SIGNED_IN;

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.apiBase}/me/tokens/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) {
      return { ok: false, message: `vipper.iam answered ${res.status} revoking the token.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `Could not reach vipper.iam. (${errorText(e)})` };
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
