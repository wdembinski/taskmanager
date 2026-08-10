import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADENCE_MS } from '@tm/protocol/cadence';
import type { BoardResponse } from '@tm/protocol/wire';
import { BoardPoller, type BoardPollerDeps, type FocusSignal } from './BoardPoller';

/** A `FocusSignal` a test can flip by hand and that reports every flip to `onChange`. */
function fakeFocus(initial: boolean): FocusSignal & { set(next: boolean): void } {
  let focused = initial;
  const listeners = new Set<(focused: boolean) => void>();
  return {
    isFocused: () => focused,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      if (next === focused) return;
      focused = next;
      for (const cb of listeners) cb(next);
    },
  };
}

function response(overrides: Partial<BoardResponse> = {}): BoardResponse {
  return {
    cursor: 'c1',
    cadence: { tier: 'active', intervalMs: CADENCE_MS.active, reason: 'web-focused' },
    deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
    clients: [],
    ...overrides,
  };
}

function makePoller(
  overrides: Partial<BoardPollerDeps> & { focus?: ReturnType<typeof fakeFocus> } = {},
): {
  poller: BoardPoller;
  fetchImpl: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof fakeFocus>;
  onResponse: ReturnType<typeof vi.fn>;
} {
  const focus = overrides.focus ?? fakeFocus(true);
  const fetchImpl =
    (overrides.fetchImpl as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response() });
  const onResponse = vi.fn();
  const deps: BoardPollerDeps = {
    apiBase: 'https://api.example.com',
    clientId: 'web-1',
    focus,
    getAccessToken: async () => 'token',
    getCursor: () => null,
    onResponse,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    random: () => 0.5,
    ...overrides,
  };
  return { poller: new BoardPoller(deps), fetchImpl, focus, onResponse };
}

describe('BoardPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gets /v1/board with the bearer token, client id and focus headers', async () => {
    const { poller, fetchImpl } = makePoller();
    await poller.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/board');
    expect(init.headers.authorization).toBe('Bearer token');
    expect(init.headers['X-TM-Client-Id']).toBe('web-1');
    expect(init.headers['X-TM-Focus']).toBe('true');
  });

  it('appends ?since= once a cursor is known', async () => {
    const { poller, fetchImpl } = makePoller({ getCursor: () => 'cursor-1' });
    await poller.tick();
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/board?since=cursor-1');
  });

  it('hands the response to onResponse', async () => {
    const board = response({ cursor: 'c2' });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => board });
    const { poller, onResponse } = makePoller({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.tick();
    expect(onResponse).toHaveBeenCalledWith(board);
  });

  it('fails the tick when not signed in, without calling fetch', async () => {
    const { poller, fetchImpl, onResponse } = makePoller({ getAccessToken: async () => null });
    await poller.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('re-arms after a successful tick using the server-directed delay', async () => {
    const { poller, fetchImpl } = makePoller();
    poller.reschedule();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CADENCE_MS.active);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never stacks a tick on one still running', async () => {
    let resolveDeferred: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => {
      resolveDeferred = resolve;
    });
    const slow = vi
      .fn()
      .mockReturnValue(
        deferred.then(() => ({ ok: true, status: 200, json: async () => response() })),
      );
    const { poller } = makePoller({ fetchImpl: slow as unknown as typeof fetch });
    const first = poller.tick();
    const second = poller.tick();
    resolveDeferred?.();
    await Promise.all([first, second]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('backs off with consecutive failures', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { poller } = makePoller({
      fetchImpl: failing as unknown as typeof fetch,
      jitterRatio: 0,
    });

    poller.reschedule();
    await vi.runOnlyPendingTimersAsync();
    expect(failing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CADENCE_MS.active * 2 - 1);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('brings the next poll forward on a focus change, floored at the active interval since the last poll', async () => {
    const focus = fakeFocus(false);
    const { poller, fetchImpl } = makePoller({ focus });
    poller.reschedule();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    focus.set(true);
    await vi.advanceTimersByTimeAsync(CADENCE_MS.active - 500 - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not run once disposed', async () => {
    const { poller, fetchImpl } = makePoller();
    poller.dispose();
    poller.reschedule();
    await poller.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls onError, not a thrown rejection, on a failed tick', async () => {
    const onError = vi.fn();
    const failing = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { poller } = makePoller({ fetchImpl: failing as unknown as typeof fetch, onError });
    await poller.tick();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
