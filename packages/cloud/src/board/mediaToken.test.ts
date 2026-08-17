/**
 * The ticket a thumbnail's URL carries. Everything here follows from one constraint —
 * `attachmentUrl` is read during a render and cannot await anything — so the interesting
 * behaviour is all about what a SYNCHRONOUS accessor does around an asynchronous mint.
 */
import { describe, expect, it, vi } from 'vitest';
import { MediaTokenHolder } from './mediaToken';

const grant = (token: string, expiresAt: number): Response =>
  ({ ok: true, status: 200, json: async () => ({ token, expiresAt }) }) as Response;

function makeHolder(
  fetchImpl: ReturnType<typeof vi.fn>,
  over: { now?: () => number; token?: string | null } = {},
) {
  const changes: number[] = [];
  const holder = new MediaTokenHolder({
    apiBase: 'https://api.example.com',
    getAccessToken: async () => (over.token === undefined ? 'bearer' : over.token),
    onChange: () => changes.push(1),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: over.now ?? (() => 1_000),
  });
  return {
    holder,
    changes,
    settle: async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

describe('MediaTokenHolder', () => {
  it('answers null before the first mint lands, then the token', async () => {
    // The `''` a caller turns that null into is a real state that lasts one request — not an
    // error, and not something to show a spinner for.
    const fetchImpl = vi.fn(async () => grant('mt-1', 601_000));
    const { holder, changes, settle } = makeHolder(fetchImpl);

    expect(holder.current()).toBeNull();
    await settle();
    expect(holder.current()).toBe('mt-1');
    // One notification, so a tab that was rendering chips can render pictures.
    expect(changes).toHaveLength(1);
  });

  it('mints once for a board full of thumbnails', async () => {
    const fetchImpl = vi.fn(async () => grant('mt-1', 601_000));
    const { holder, settle } = makeHolder(fetchImpl);

    // Twenty images on one render pass, all reading it before the first answer arrives.
    for (let i = 0; i < 20; i += 1) holder.current();
    await settle();
    for (let i = 0; i < 20; i += 1) holder.current();
    await settle();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-mints before the token expires, not after', async () => {
    // A minute's margin against a ten-minute life: an image request must not lose a race with
    // its own token.
    let now = 1_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(grant('mt-1', 601_000))
      .mockResolvedValue(grant('mt-2', 1_200_000));
    const { holder, settle } = makeHolder(fetchImpl, { now: () => now });

    holder.current();
    await settle();
    expect(holder.current()).toBe('mt-1');

    now = 541_000; // inside the refresh margin, still valid
    expect(holder.current()).toBe('mt-1'); // still served while the new one is fetched
    await settle();
    expect(holder.current()).toBe('mt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pauses after a failure instead of hammering a dead server', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, statusText: 'boom' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { holder, settle } = makeHolder(fetchImpl);

    holder.current();
    await settle();
    expect(holder.current()).toBeNull();
    await settle();
    holder.current();
    await settle();

    // One attempt, not one per read — the retry pause has not elapsed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not mint for a tab that is not signed in', async () => {
    const fetchImpl = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { holder, settle } = makeHolder(fetchImpl, { token: null });

    holder.current();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('mints nothing once disposed', async () => {
    const fetchImpl = vi.fn(async () => grant('mt-1', 601_000));
    const { holder, settle } = makeHolder(fetchImpl);
    holder.dispose();
    expect(holder.current()).toBeNull();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
