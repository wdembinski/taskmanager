import { describe, expect, it, vi } from 'vitest';
import { IamTokenError } from '@shared/iamPkce';
import { CloudTokenProvider, type CloudTokenDeps } from './cloudToken';

const CONFIG = {
  issuer: 'https://auth.vipper.network/oidc',
  clientId: 'desktop-client',
  redirectUri: '',
};

/** A fake clock a test can advance by hand, matched to `deps.now`. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function makeDeps(overrides: Partial<CloudTokenDeps> = {}): {
  deps: CloudTokenDeps;
  refresh: ReturnType<typeof vi.fn>;
  saved: string[];
  states: string[];
} {
  const saved: string[] = [];
  const states: string[] = [];
  const refresh = vi.fn().mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt-rotated',
    expires_in: 3600,
    token_type: 'Bearer',
  });
  const deps: CloudTokenDeps = {
    config: () => CONFIG,
    loadRefreshToken: () => 'rt-stored',
    saveRefreshToken: (token) => saved.push(token),
    refresh,
    onStateChange: (s) => states.push(s),
    ...overrides,
  };
  return { deps, refresh, saved, states };
}

describe('CloudTokenProvider.get', () => {
  it('mints exactly once for three concurrent callers, all get the same token, and the rotated refresh token is saved once', async () => {
    const { deps, refresh, saved } = makeDeps();
    const provider = new CloudTokenProvider(deps);

    const [a, b, c] = await Promise.all([provider.get(), provider.get(), provider.get()]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe('at');
    expect(b).toBe('at');
    expect(c).toBe('at');
    expect(saved).toEqual(['rt-rotated']);
    expect(provider.state()).toBe('active');
  });

  it('reuses the cached token while fresh', async () => {
    const clock = fakeClock(0);
    const { deps, refresh } = makeDeps({ now: clock.now });
    const provider = new CloudTokenProvider(deps);

    await provider.get();
    clock.advance(1_000); // well inside the 3600s expiry, outside the 5s buffer
    const token = await provider.get();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(token).toBe('at');
  });

  it('re-mints once inside the 5s expiry buffer', async () => {
    const clock = fakeClock(0);
    const { deps, refresh } = makeDeps({ now: clock.now });
    const provider = new CloudTokenProvider(deps);

    await provider.get();
    clock.advance(3600 * 1000 - 4_000); // inside the 5s buffer before expiry
    await provider.get();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('invalid_grant moves to rejected, does not clear the refresh token, and makes no further network call', async () => {
    const refresh = vi.fn().mockRejectedValue(new IamTokenError(400, 'x', 'invalid_grant', null));
    const saved: string[] = [];
    const provider = new CloudTokenProvider({
      config: () => CONFIG,
      loadRefreshToken: () => 'rt-stored',
      saveRefreshToken: (t) => saved.push(t),
      refresh,
      log: () => {},
    });

    const token = await provider.get();

    expect(token).toBeNull();
    expect(provider.state()).toBe('rejected');
    expect(saved).toEqual([]);

    const again = await provider.get();
    expect(again).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a transient 503 leaves state unchanged and the next get() retries', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new IamTokenError(503, 'unavailable', null, null))
      .mockResolvedValueOnce({
        access_token: 'at',
        refresh_token: 'rt2',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    const provider = new CloudTokenProvider({
      config: () => CONFIG,
      loadRefreshToken: () => 'rt-stored',
      saveRefreshToken: () => {},
      refresh,
      log: () => {},
    });

    const stateBefore = provider.state();
    const first = await provider.get();
    expect(first).toBeNull();
    expect(provider.state()).toBe(stateBefore);

    const second = await provider.get();
    expect(second).toBe('at');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('invalidate() drops only the cached access token, forcing exactly one new mint', async () => {
    const { deps, refresh } = makeDeps();
    const provider = new CloudTokenProvider(deps);

    await provider.get();
    provider.invalidate();
    await Promise.all([provider.get(), provider.get()]);

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('CloudTokenProvider.forget / renewed', () => {
  it('forget() (iam:signOut) drops the cache and moves to signed-out', async () => {
    const { deps, refresh } = makeDeps();
    const provider = new CloudTokenProvider(deps);
    await provider.get();

    provider.forget();
    expect(provider.state()).toBe('signed-out');

    await provider.get(); // loadRefreshToken still answers 'rt-stored' in this fake, so it re-mints
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('renewed() (iam:signIn) leaves rejected for stored and drops the cache', async () => {
    const refresh = vi.fn().mockRejectedValue(new IamTokenError(400, 'x', 'invalid_grant', null));
    const provider = new CloudTokenProvider({
      config: () => CONFIG,
      loadRefreshToken: () => 'rt-stored',
      saveRefreshToken: () => {},
      refresh,
      log: () => {},
    });
    await provider.get();
    expect(provider.state()).toBe('rejected');

    provider.renewed();
    expect(provider.state()).toBe('stored');
  });
});

describe('CloudTokenProvider construction', () => {
  it('starts signed-out when there is no stored refresh token', () => {
    const provider = new CloudTokenProvider({
      config: () => CONFIG,
      loadRefreshToken: () => null,
      saveRefreshToken: () => {},
    });
    expect(provider.state()).toBe('signed-out');
  });

  it('starts stored when a refresh token is already on file', () => {
    const provider = new CloudTokenProvider({
      config: () => CONFIG,
      loadRefreshToken: () => 'rt',
      saveRefreshToken: () => {},
    });
    expect(provider.state()).toBe('stored');
  });
});
