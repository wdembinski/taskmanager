/**
 * The web app's calls to `POST`/`GET`/`DELETE /v1/tokens` — the Personal access tokens page's
 * only contact with the server. Same dependency shape as `MediaTokenHolder`
 * (`apps/web/src/board/mediaToken.ts`): `{ apiBase, getAccessToken, fetchImpl }`, so it is
 * driveable from a test with a fake fetch rather than a real network.
 */
import type {
  CreatePatRequest,
  CreatedPersonalAccessToken,
  PersonalAccessTokenList,
} from '@tm/protocol/wire';

export interface TokensApiDeps {
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export async function createToken(
  deps: TokensApiDeps,
  request: CreatePatRequest,
): Promise<CreatedPersonalAccessToken> {
  return call<CreatedPersonalAccessToken>(deps, '/v1/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export async function listTokens(deps: TokensApiDeps): Promise<PersonalAccessTokenList> {
  return call<PersonalAccessTokenList>(deps, '/v1/tokens', { method: 'GET' });
}

export async function revokeToken(deps: TokensApiDeps, id: string): Promise<void> {
  await call<undefined>(deps, `/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function call<T>(deps: TokensApiDeps, path: string, init: RequestInit): Promise<T> {
  const token = await deps.getAccessToken();
  if (!token) throw new Error('Not signed in to vipper.iam.');

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${deps.apiBase}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`tokens request failed (${res.status} ${res.statusText})`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
