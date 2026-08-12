import { describe, expect, it, vi } from 'vitest';
import { AuthCache, AUTH_CACHE_MAX_ENTRIES, AUTH_CACHE_TTL_MS } from './authCache';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('AuthCache', () => {
  it('computes once and reuses the answer within the TTL', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    const compute = vi.fn(async () => 'subject-1');

    expect(await cache.get('token', compute)).toBe('subject-1');
    c.advance(AUTH_CACHE_TTL_MS - 1);
    expect(await cache.get('token', compute)).toBe('subject-1');

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes once the TTL is past', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    const compute = vi.fn(async () => 'subject-1');

    await cache.get('token', compute);
    c.advance(AUTH_CACHE_TTL_MS + 1);
    await cache.get('token', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('does not let a revoked token outlive one poll interval', () => {
    // The whole safety argument: the window a dead credential stays usable is the same
    // order as the cadence this exists to protect. A minute would not be.
    expect(AUTH_CACHE_TTL_MS).toBeLessThanOrEqual(30_000);
  });

  it('never caches a failure', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    const compute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('IAM is down'))
      .mockResolvedValue('subject-1');

    await expect(cache.get('token', compute)).rejects.toThrow('IAM is down');
    // The very next call must reach IAM again — a cached 500 would turn one bad second
    // into ten.
    expect(await cache.get('token', compute)).toBe('subject-1');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('keys by token, so two callers never see each other’s answer', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    expect(await cache.get('a', async () => 'alice')).toBe('alice');
    expect(await cache.get('b', async () => 'bob')).toBe('bob');
    expect(await cache.get('a', async () => 'never asked')).toBe('alice');
  });

  it('forgets a key on demand', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    const compute = vi.fn(async () => 'subject-1');
    await cache.get('token', compute);
    cache.invalidate('token');
    await cache.get('token', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('stays bounded — a map keyed by credential must not grow forever', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    for (let i = 0; i < AUTH_CACHE_MAX_ENTRIES + 50; i++) {
      await cache.get(`token-${i}`, async () => `s${i}`);
    }
    expect(cache.size()).toBeLessThanOrEqual(AUTH_CACHE_MAX_ENTRIES);
  });

  it('drops expired entries rather than evicting live ones under pressure', async () => {
    const c = clock();
    const cache = new AuthCache<string>(AUTH_CACHE_TTL_MS, c.now);
    for (let i = 0; i < AUTH_CACHE_MAX_ENTRIES; i++) {
      await cache.get(`old-${i}`, async () => 'x');
    }
    c.advance(AUTH_CACHE_TTL_MS + 1);
    const compute = vi.fn(async () => 'fresh');
    await cache.get('new', compute);
    expect(cache.size()).toBe(1);
    expect(await cache.get('new', compute)).toBe('fresh');
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
