import { describe, expect, it, vi } from 'vitest';
import { createToken, listTokens, revokeToken } from './tokensApi';

function deps(fetchImpl: ReturnType<typeof vi.fn>, token: string | null = 'bearer') {
  return {
    apiBase: 'https://api.example.com',
    getAccessToken: async () => token,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

describe('createToken', () => {
  it('sends the bearer and the request body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => ({ token: 'tmpat_x', pat: { id: 'pat-1' } }),
    }));

    const result = await createToken(deps(fetchImpl), { name: 'laptop', expiresInDays: 90 });

    expect(result.token).toBe('tmpat_x');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/tokens');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bearer');
    expect(init.body).toBe(JSON.stringify({ name: 'laptop', expiresInDays: 90 }));
  });

  it('throws with the status on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409, statusText: 'Conflict' }));
    await expect(createToken(deps(fetchImpl), { name: 'laptop' })).rejects.toThrow(/409/);
  });

  it('fails cleanly when getAccessToken answers null', async () => {
    const fetchImpl = vi.fn();
    await expect(createToken(deps(fetchImpl, null), { name: 'laptop' })).rejects.toThrow(
      /not signed in/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listTokens', () => {
  it('sends the bearer on a GET', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ tokens: [] }),
    }));

    await listTokens(deps(fetchImpl));

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bearer');
  });
});

describe('revokeToken', () => {
  it('sends a DELETE to the token-scoped path', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204, statusText: 'No Content' }));

    await revokeToken(deps(fetchImpl), 'pat 1');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/tokens/pat%201');
    expect(init.method).toBe('DELETE');
  });
});
