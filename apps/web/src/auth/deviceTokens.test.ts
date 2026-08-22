import { describe, expect, it, vi } from 'vitest';
import { createDeviceToken, listDeviceTokens, revokeDeviceToken } from './deviceTokens';

const API_BASE = 'https://auth.vipper.network/api/v1';
const signedIn = async () => 'a-token';
const signedOut = async () => null;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('listDeviceTokens', () => {
  it('refuses before trying anything when signed out', async () => {
    const result = await listDeviceTokens({
      apiBase: API_BASE,
      getAccessToken: signedOut,
      fetchImpl: vi.fn(),
    });
    expect(result).toEqual({ ok: false, message: 'Not signed in.' });
  });

  it('returns the tokens vipper.iam reports', async () => {
    const tokens = [
      {
        id: '1',
        name: 'laptop',
        tokenPrefix: 'vip_ab12cd34',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(tokens));
    const result = await listDeviceTokens({
      apiBase: API_BASE,
      getAccessToken: signedIn,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, tokens });
    expect(fetchImpl).toHaveBeenCalledWith(`${API_BASE}/me/tokens`, {
      headers: { authorization: 'Bearer a-token' },
    });
  });

  it('names the status when vipper.iam refuses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const result = await listDeviceTokens({
      apiBase: API_BASE,
      getAccessToken: signedIn,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, message: 'vipper.iam answered 401 listing tokens.' });
  });

  it('reports a network failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const result = await listDeviceTokens({
      apiBase: API_BASE,
      getAccessToken: signedIn,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('Could not reach vipper.iam');
  });
});

describe('createDeviceToken', () => {
  it('refuses a blank name before touching the network', async () => {
    const fetchImpl = vi.fn();
    const result = await createDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedIn, fetchImpl },
      '   ',
    );
    expect(result).toEqual({ ok: false, message: 'Give the token a name, e.g. "My laptop".' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses before trying anything when signed out', async () => {
    const result = await createDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedOut, fetchImpl: vi.fn() },
      'My laptop',
    );
    expect(result).toEqual({ ok: false, message: 'Not signed in.' });
  });

  it('splits the one-time secret from the token metadata', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: '1',
        name: 'My laptop',
        tokenPrefix: 'vip_ab12cd34',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        token: 'vip_ab12cd34_secretsecretsecret',
      }),
    );
    const result = await createDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedIn, fetchImpl },
      'My laptop',
    );

    expect(result).toEqual({
      ok: true,
      secret: 'vip_ab12cd34_secretsecretsecret',
      token: {
        id: '1',
        name: 'My laptop',
        tokenPrefix: 'vip_ab12cd34',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(`${API_BASE}/me/tokens`, {
      method: 'POST',
      headers: { authorization: 'Bearer a-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My laptop' }),
    });
  });

  it('names the status when vipper.iam refuses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 403));
    const result = await createDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedIn, fetchImpl },
      'My laptop',
    );
    expect(result).toEqual({ ok: false, message: 'vipper.iam refused to create a token (403).' });
  });
});

describe('revokeDeviceToken', () => {
  it('refuses before trying anything when signed out', async () => {
    const result = await revokeDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedOut, fetchImpl: vi.fn() },
      '1',
    );
    expect(result).toEqual({ ok: false, message: 'Not signed in.' });
  });

  it('succeeds on a 204', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 204));
    const result = await revokeDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedIn, fetchImpl },
      '1',
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(`${API_BASE}/me/tokens/1`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer a-token' },
    });
  });

  it('treats an already-gone token as success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const result = await revokeDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedIn, fetchImpl },
      '1',
    );
    expect(result).toEqual({ ok: true });
  });

  it('names the status for any other failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const result = await revokeDeviceToken(
      { apiBase: API_BASE, getAccessToken: signedIn, fetchImpl },
      '1',
    );
    expect(result).toEqual({ ok: false, message: 'vipper.iam answered 500 revoking the token.' });
  });
});
