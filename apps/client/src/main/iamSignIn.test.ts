/**
 * Drives `signIn` end to end against a REAL loopback listener, the same way
 * `permissionBroker.test.ts` tests the broker: `openExternal` is stubbed to hit the listener's
 * own redirect URL (standing in for the browser), and `fetch` is stubbed for the token
 * exchange only (vipper.iam itself is not part of this test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn, type IamSignInConfig } from './iamSignIn';

const CONFIG: IamSignInConfig = {
  issuer: 'https://iam.vipper.network/oidc',
  clientId: 'desktop-client',
};

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * Stubs ONLY the token-exchange POST to vipper.iam; a callback GET to the real loopback
 * listener (what `openExternal` below issues, standing in for the browser) still goes through
 * the real `fetch` — this must not intercept that, or the listener never sees the redirect.
 */
function stubTokenFetch(response: unknown, status = 200): void {
  global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('/oidc/token')) return originalFetch(input, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('signIn', () => {
  beforeEach(() => {
    stubTokenFetch({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  it('opens the authorize URL, catches the redirect, and exchanges the code for tokens', async () => {
    let openedUrl: URL | null = null;
    const openExternal = async (authorizeUrl: string): Promise<void> => {
      openedUrl = new URL(authorizeUrl);
      const redirectUri = openedUrl.searchParams.get('redirect_uri')!;
      const state = openedUrl.searchParams.get('state')!;
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', 'the-code');
      callback.searchParams.set('state', state);
      await fetch(callback.toString());
    };

    const tokens = await signIn(CONFIG, openExternal);

    expect(openedUrl!.origin + openedUrl!.pathname).toBe('https://iam.vipper.network/oidc/auth');
    expect(tokens).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  it('rejects when the redirect carries a state that does not match this attempt', async () => {
    const openExternal = async (authorizeUrl: string): Promise<void> => {
      const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri')!;
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', 'the-code');
      callback.searchParams.set('state', 'wrong-state');
      const res = await fetch(callback.toString());
      expect(res.status).toBe(400);
      // The listener denies but never settles the sign-in promise for a mismatched state —
      // time it out fast for the test instead of waiting the real 5 minutes.
    };

    await expect(
      Promise.race([
        signIn(CONFIG, openExternal),
        new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting')), 200)),
      ]),
    ).rejects.toThrow('still waiting');
  });

  it('rejects when vipper.iam redirects back with an error instead of a code', async () => {
    const openExternal = async (authorizeUrl: string): Promise<void> => {
      const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri')!;
      const state = new URL(authorizeUrl).searchParams.get('state')!;
      const callback = new URL(redirectUri);
      callback.searchParams.set('error', 'access_denied');
      callback.searchParams.set('state', state);
      await fetch(callback.toString());
    };

    await expect(signIn(CONFIG, openExternal)).rejects.toThrow('access_denied');
  });

  it('propagates a token-exchange failure', async () => {
    stubTokenFetch({ error: 'invalid_grant' }, 400);
    const openExternal = async (authorizeUrl: string): Promise<void> => {
      const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri')!;
      const state = new URL(authorizeUrl).searchParams.get('state')!;
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', 'the-code');
      callback.searchParams.set('state', state);
      await fetch(callback.toString());
    };

    await expect(signIn(CONFIG, openExternal)).rejects.toThrow(/token request failed \(400/);
  });
});
