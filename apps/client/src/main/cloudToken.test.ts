import { describe, expect, it, vi } from 'vitest';
import { CloudTokenProvider, type CloudTokenDeps } from './cloudToken';

/** A fake clock a test can advance by hand, matched to `deps.now`. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function makeDeps(overrides: Partial<CloudTokenDeps> = {}): {
  deps: CloudTokenDeps;
  states: string[];
} {
  const states: string[] = [];
  const deps: CloudTokenDeps = {
    loadPat: () => 'tmpat_stored',
    onStateChange: (s) => states.push(s),
    ...overrides,
  };
  return { deps, states };
}

describe('CloudTokenProvider.get', () => {
  it('returns the stored token with no network call at all', async () => {
    const loadPat = vi.fn(() => 'tmpat_stored');
    const provider = new CloudTokenProvider(makeDeps({ loadPat }).deps);

    const token = await provider.get();

    expect(token).toBe('tmpat_stored');
    expect(provider.state()).toBe('stored');
  });

  it('answers null, in state no-token, when nothing is stored', async () => {
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => null }).deps);

    expect(await provider.get()).toBeNull();
    expect(provider.state()).toBe('no-token');
  });

  it('moves from no-token to stored the moment a token appears', async () => {
    let stored: string | null = null;
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => stored }).deps);
    expect(provider.state()).toBe('no-token');

    stored = 'tmpat_fresh';
    expect(await provider.get()).toBe('tmpat_fresh');
    expect(provider.state()).toBe('stored');
  });
});

describe('CloudTokenProvider.invalidate', () => {
  it('moves to rejected, and every later get() is null without touching loadPat again', async () => {
    const loadPat = vi.fn(() => 'tmpat_stored');
    const provider = new CloudTokenProvider(makeDeps({ loadPat }).deps);
    await provider.get();
    loadPat.mockClear();

    provider.invalidate();

    expect(provider.state()).toBe('rejected');
    expect(await provider.get()).toBeNull();
    expect(await provider.get()).toBeNull();
    expect(loadPat).not.toHaveBeenCalled();
  });

  it('clears lastAcceptedAt', async () => {
    const clock = fakeClock(1_000);
    const provider = new CloudTokenProvider(makeDeps({ now: clock.now }).deps);
    await provider.get();
    provider.accepted();
    expect(provider.lastAcceptedAt()).toBe(1_000);

    provider.invalidate();
    expect(provider.lastAcceptedAt()).toBeNull();
  });
});

describe('CloudTokenProvider.accepted', () => {
  it('moves to active and records the time', () => {
    const clock = fakeClock(5_000);
    const provider = new CloudTokenProvider(makeDeps({ now: clock.now }).deps);

    provider.accepted();

    expect(provider.state()).toBe('active');
    expect(provider.lastAcceptedAt()).toBe(5_000);
  });
});

describe('CloudTokenProvider.reload', () => {
  it('picks up a freshly pasted token after a rejection', async () => {
    let stored: string | null = 'tmpat_old';
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => stored }).deps);
    await provider.get();
    provider.invalidate();
    expect(await provider.get()).toBeNull();

    stored = 'tmpat_new';
    provider.reload();

    expect(provider.state()).toBe('stored');
    expect(await provider.get()).toBe('tmpat_new');
  });

  it('moves to no-token when the credential was cleared', () => {
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => null }).deps);
    provider.reload();
    expect(provider.state()).toBe('no-token');
  });
});

describe('CloudTokenProvider.explain', () => {
  it('names the actual reason for each state', async () => {
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => null }).deps);
    expect(provider.explain()).toMatch(/no token stored/i);

    provider.reload();
    provider.invalidate();
    expect(provider.explain()).toMatch(/revoked or has expired/i);
    expect(provider.explain()).not.toMatch(/sign in/i);

    const stored = new CloudTokenProvider(makeDeps({ loadPat: () => 'tmpat_x' }).deps);
    await stored.get();
    expect(stored.explain()).toMatch(/has not synced/i);
    stored.accepted();
    expect(stored.explain()).toMatch(/syncing/i);
  });
});

describe('CloudTokenProvider construction', () => {
  it('starts no-token when there is no stored PAT', () => {
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => null }).deps);
    expect(provider.state()).toBe('no-token');
  });

  it('starts stored when a PAT is already on file', () => {
    const provider = new CloudTokenProvider(makeDeps({ loadPat: () => 'tmpat_x' }).deps);
    expect(provider.state()).toBe('stored');
  });
});
