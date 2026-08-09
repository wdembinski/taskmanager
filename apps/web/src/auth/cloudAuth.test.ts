import { describe, expect, it, vi } from 'vitest';
import { CloudAuth, isAccessTokenFresh } from './cloudAuth';

describe('isAccessTokenFresh', () => {
  it('is false with no cache', () => {
    expect(isAccessTokenFresh(null, 0)).toBe(false);
  });

  it('is true well before expiry', () => {
    expect(isAccessTokenFresh({ value: 't', expiresAt: 100_000 }, 0)).toBe(true);
  });

  it('is false inside the 5s re-mint buffer', () => {
    expect(isAccessTokenFresh({ value: 't', expiresAt: 4_000 }, 0)).toBe(false);
  });
});

/** A minimal `Storage` a test can inspect without touching `window`. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const config = {
  issuer: 'https://iam.example.com/oidc',
  clientId: 'taskmanager-web',
  redirectUri: 'https://app.example.com/callback',
};

function tokenResponse(overrides: Record<string, unknown> = {}): unknown {
  return { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer', ...overrides };
}

describe('CloudAuth', () => {
  it('is not signed in with no refresh token on file', () => {
    const auth = new CloudAuth({ config, localStorage: fakeStorage(), sessionStorage: fakeStorage() });
    expect(auth.isSignedIn()).toBe(false);
  });

  it('has no access token when signed out', async () => {
    const auth = new CloudAuth({ config, localStorage: fakeStorage(), sessionStorage: fakeStorage() });
    expect(await auth.getAccessToken()).toBeNull();
  });

  it('exchanges the code on the callback URL and saves the refresh token', async () => {
    const session = fakeStorage();
    const local = fakeStorage();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => tokenResponse() });
    const auth = new CloudAuth({ config, localStorage: local, sessionStorage: session, fetchImpl });

    // beginSignIn would normally navigate away; drive the same PKCE bookkeeping by hand so
    // completeSignIn has something to redeem against.
    session.setItem('tm.cloud.pkce', JSON.stringify({ state: 's1', verifier: 'v1' }));

    const handled = await auth.completeSignIn(
      new URL('https://app.example.com/callback?code=abc&state=s1'),
    );

    expect(handled).toBe(true);
    expect(local.getItem('tm.cloud.refreshToken')).toBe('rt-1');
    expect(await auth.getAccessToken()).toBe('at-1');
    // Cached — no second network round trip for a token that is still fresh.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a callback whose state does not match what beginSignIn stored', async () => {
    const session = fakeStorage();
    session.setItem('tm.cloud.pkce', JSON.stringify({ state: 'expected', verifier: 'v1' }));
    const auth = new CloudAuth({ config, localStorage: fakeStorage(), sessionStorage: session });

    await expect(
      auth.completeSignIn(new URL('https://app.example.com/callback?code=abc&state=wrong')),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('ignores a URL that is not the callback path', async () => {
    const auth = new CloudAuth({ config, localStorage: fakeStorage(), sessionStorage: fakeStorage() });
    expect(await auth.completeSignIn(new URL('https://app.example.com/'))).toBe(false);
  });

  it('mints a fresh access token from a stored refresh token', async () => {
    const local = fakeStorage();
    local.setItem('tm.cloud.refreshToken', 'rt-stored');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => tokenResponse({ access_token: 'at-2' }) });
    const auth = new CloudAuth({ config, localStorage: local, sessionStorage: fakeStorage(), fetchImpl });

    expect(await auth.getAccessToken()).toBe('at-2');
    const body = new URLSearchParams(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-stored');
  });

  it('returns null rather than throwing when the refresh request fails', async () => {
    const local = fakeStorage();
    local.setItem('tm.cloud.refreshToken', 'rt-stored');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' });
    const auth = new CloudAuth({ config, localStorage: local, sessionStorage: fakeStorage(), fetchImpl });

    await expect(auth.getAccessToken()).resolves.toBeNull();
  });

  it('signOut clears the stored refresh token and the cached access token', async () => {
    const local = fakeStorage();
    local.setItem('tm.cloud.refreshToken', 'rt-stored');
    const auth = new CloudAuth({ config, localStorage: local, sessionStorage: fakeStorage() });

    auth.signOut();

    expect(auth.isSignedIn()).toBe(false);
    expect(local.getItem('tm.cloud.refreshToken')).toBeNull();
  });
});
