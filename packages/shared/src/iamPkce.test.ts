import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  refreshTokens,
} from './iamPkce';

const CONFIG = {
  issuer: 'https://iam.vipper.network/oidc',
  clientId: 'desktop-client',
  redirectUri: 'http://127.0.0.1:54321/callback',
};

describe('createPkcePair', () => {
  it('produces a URL-safe verifier and its S256 challenge, and a fresh pair each time', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();

    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.challenge).not.toBe(a.verifier);
  });
});

describe('createState', () => {
  it('is URL-safe and different on each call', () => {
    expect(createState()).not.toBe(createState());
    expect(createState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('points at <issuer>/auth with every required PKCE + OAuth param', () => {
    const url = new URL(
      buildAuthorizeUrl(CONFIG, { verifier: 'v', challenge: 'c' }, 'the-state'),
    );

    expect(url.origin + url.pathname).toBe('https://iam.vipper.network/oidc/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('desktop-client');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('code_challenge')).toBe('c');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid offline_access');
  });

  it('respects a custom scope', () => {
    const url = new URL(
      buildAuthorizeUrl({ ...CONFIG, scope: 'openid' }, { verifier: 'v', challenge: 'c' }, 's'),
    );
    expect(url.searchParams.get('scope')).toBe('openid');
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

describe('exchangeCodeForTokens', () => {
  it('POSTs the code + verifier to <issuer>/token, form-encoded', async () => {
    const fetchImpl = fakeFetch(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
    });

    const tokens = await exchangeCodeForTokens(CONFIG, 'the-code', 'the-verifier', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://iam.vipper.network/oidc/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = new URLSearchParams(call[1].body as string);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('code_verifier')).toBe('the-verifier');
    expect(params.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(params.get('client_id')).toBe(CONFIG.clientId);
    expect(tokens).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  it('throws on a non-2xx response', async () => {
    await expect(
      exchangeCodeForTokens(CONFIG, 'c', 'v', fakeFetch(400, { error: 'invalid_grant' })),
    ).rejects.toThrow(/token request failed \(400/);
  });
});

describe('refreshTokens', () => {
  it('POSTs grant_type=refresh_token with the stored refresh token', async () => {
    const fetchImpl = fakeFetch(200, {
      access_token: 'at2',
      refresh_token: 'rt2',
      expires_in: 3600,
      token_type: 'Bearer',
    });

    await refreshTokens(CONFIG, 'the-refresh-token', fetchImpl);

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = new URLSearchParams(call[1].body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('the-refresh-token');
    expect(params.get('client_id')).toBe(CONFIG.clientId);
  });
});
