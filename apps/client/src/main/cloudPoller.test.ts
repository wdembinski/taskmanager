import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADENCE_MS } from '@protocol/cadence';
import type { SyncResponse } from '@protocol/wire';
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from '@shared/settings';
import { CloudPoller, type CloudPollerDeps, type FocusSignal } from './cloudPoller';
import type { CloudOutboxRow } from './cloudDelta';
import type { Store } from './store';

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

/** A minimal `Store` stand-in — only the handful of methods `CloudPoller` actually calls. */
function fakeStore(outbox: CloudOutboxRow[] = []): Store {
  const pruned: number[] = [];
  let cursor: string | null = null;
  return {
    getCloudDelta: (_sinceSeq: number, limit: number) => outbox.slice(0, limit),
    pruneCloudOutbox: (throughSeq: number) => pruned.push(throughSeq),
    loadCloudClientId: () => 'client-1',
    loadCloudCursor: () => cursor,
    saveCloudCursor: (next: string) => {
      cursor = next;
    },
    getTask: () => undefined,
    getProject: () => undefined,
  } as unknown as Store;
}

function response(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return {
    cursor: 'c1',
    cadence: { tier: 'active', intervalMs: CADENCE_MS.active, reason: 'client-focused' },
    commands: [],
    ...overrides,
  };
}

function makePoller(
  overrides: Partial<Omit<CloudPollerDeps, 'focus'>> & {
    settings?: Partial<CloudSettings>;
    focus?: ReturnType<typeof fakeFocus>;
  } = {},
): {
  poller: CloudPoller;
  fetchImpl: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof fakeFocus>;
} {
  const { settings, ...rest } = overrides;
  const focus = rest.focus ?? fakeFocus(true);
  const fetchImpl =
    (rest.fetchImpl as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response() });
  const deps: CloudPollerDeps = {
    store: fakeStore(),
    focus,
    getSettings: () => ({
      ...DEFAULT_CLOUD_SETTINGS,
      enabled: true,
      baseUrl: 'https://api.example.com',
      ...settings,
    }),
    getAccessToken: async () => 'token',
    onCommands: () => {},
    runTracked: (run) => run(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    random: () => 0.5,
    ...rest,
  };
  return { poller: new CloudPoller(deps), fetchImpl, focus };
}

describe('CloudPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule while cloud sync is disabled', () => {
    const { poller, fetchImpl } = makePoller({ settings: { enabled: false } });
    poller.reschedule();
    vi.advanceTimersByTime(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not schedule with no server configured', () => {
    const { poller, fetchImpl } = makePoller({ settings: { baseUrl: '' } });
    poller.reschedule();
    vi.advanceTimersByTime(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to /v1/sync with a bearer token and the client id', async () => {
    const { poller, fetchImpl } = makePoller();
    await poller.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/sync');
    expect(init.headers.authorization).toBe('Bearer token');
    const body = JSON.parse(init.body);
    expect(body.clientId).toBe('client-1');
  });

  it('re-arms after a successful tick using the server-directed delay', async () => {
    const { poller, fetchImpl } = makePoller();
    poller.reschedule();
    await vi.runOnlyPendingTimersAsync(); // first tick fires
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CADENCE_MS.active);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never stacks a tick on one still running', async () => {
    // Created up front, not inside the mock: `send()` doesn't reach `fetchImpl` until after
    // an `await getAccessToken()` microtask, so resolving from inside the mock would race
    // whichever of `first`/`second` actually triggers that call.
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
    const second = poller.tick(); // should be a no-op — a sweep is already running
    resolveDeferred?.();
    await Promise.all([first, second]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('backs off with consecutive failures, doubling the active-tier seed', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { poller } = makePoller({
      fetchImpl: failing as unknown as typeof fetch,
      settings: { jitterRatio: 0 },
    });

    poller.reschedule();
    await vi.runOnlyPendingTimersAsync();
    expect(failing).toHaveBeenCalledTimes(1);

    // One recorded failure doubles the active-tier seed (2.5s → 5s) — focus defaults to
    // true here, so that seed, not the idle one, is what backoff is doubling.
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOUD_SETTINGS.activeIntervalMs * 2 - 1);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('brings the next poll forward on a focus change, floored at the active interval since the last poll', async () => {
    const focus = fakeFocus(false);
    const { poller, fetchImpl } = makePoller({ focus });
    poller.reschedule();
    await vi.runOnlyPendingTimersAsync(); // the first tick fires and completes
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500); // well inside the active-tier floor
    focus.set(true);
    await vi.advanceTimersByTimeAsync(CADENCE_MS.active - 500 - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('hands commands from the response to onCommands', async () => {
    const command = {
      id: 'cmd-1',
      issuedAt: 0,
      issuedBy: 'someone',
      kind: 'set-status' as const,
      payload: { taskId: 't1', status: 'in-review' as const },
    };
    const onCommands = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => response({ commands: [command] }),
      });
    const { poller } = makePoller({ onCommands, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.tick();
    expect(onCommands).toHaveBeenCalledWith([command]);
  });

  it('does not run once disposed', async () => {
    const { poller, fetchImpl } = makePoller();
    poller.dispose();
    poller.reschedule();
    await poller.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
