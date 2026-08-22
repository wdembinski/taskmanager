import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADENCE_MS } from '@protocol/cadence';
import { PROTOCOL_VERSION, type SyncResponse } from '@protocol/wire';
import type { Task } from '@shared/model';
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
    getPendingCloudAcks: () => [],
    markCloudAcksSent: () => {},
    getPendingCloudResults: () => [],
    markCloudResultsSent: () => {},
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
    getClientInfo: () => ({
      name: 'WORKSTATION',
      platform: 'win32',
      appVersion: '0.84.5',
      protocolVersion: PROTOCOL_VERSION,
    }),
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

  it('calls onSynced once a tick succeeds, and not when it fails', async () => {
    const onSynced = vi.fn();
    const { poller, fetchImpl } = makePoller({
      onSynced,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => response() })
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' }),
    });

    await poller.tick();
    expect(onSynced).toHaveBeenCalledTimes(1);

    await poller.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onSynced).toHaveBeenCalledTimes(1);
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
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => response({ commands: [command] }),
    });
    const { poller } = makePoller({ onCommands, fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.tick();
    expect(onCommands).toHaveBeenCalledWith([command]);
  });

  it('sends pending acks and clears them once the sync succeeds', async () => {
    const markCloudAcksSent = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({
      store: {
        getCloudDelta: () => [],
        pruneCloudOutbox: () => {},
        loadCloudClientId: () => 'client-1',
        loadCloudCursor: () => null,
        saveCloudCursor: () => {},
        getTask: () => undefined,
        getProject: () => undefined,
        getPendingCloudAcks: () => ['cmd-1', 'cmd-2'],
        markCloudAcksSent,
        getPendingCloudResults: () => [],
        markCloudResultsSent: () => {},
      } as unknown as Store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.tick();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.ackedCommandIds).toEqual(['cmd-1', 'cmd-2']);
    expect(markCloudAcksSent).toHaveBeenCalledWith(['cmd-1', 'cmd-2']);
  });

  it('sends pending results and clears them once the sync succeeds', async () => {
    const markCloudResultsSent = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({
      store: {
        getCloudDelta: () => [],
        pruneCloudOutbox: () => {},
        loadCloudClientId: () => 'client-1',
        loadCloudCursor: () => null,
        saveCloudCursor: () => {},
        getTask: () => undefined,
        getProject: () => undefined,
        getPendingCloudAcks: () => [],
        markCloudAcksSent: () => {},
        getPendingCloudResults: () => [
          { commandId: 'cmd-1', taskId: null, projectId: null, ok: true, reason: null, value: 7 },
          { commandId: 'cmd-2', taskId: null, projectId: null, ok: false, reason: 'nope' },
        ],
        markCloudResultsSent,
      } as unknown as Store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.tick();

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.results).toEqual([
      { commandId: 'cmd-1', ok: true, value: 7 },
      { commandId: 'cmd-2', ok: false, error: 'nope' },
    ]);
    expect(markCloudResultsSent).toHaveBeenCalledWith(['cmd-1', 'cmd-2']);
  });

  it('keeps a result pending when the sync that carried it failed', async () => {
    // The rule the acks and the outbox prune already follow: nothing is marked sent on a
    // request that did not land, because nothing will resend it.
    const markCloudResultsSent = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
    const { poller } = makePoller({
      store: {
        getCloudDelta: () => [],
        pruneCloudOutbox: () => {},
        loadCloudClientId: () => 'client-1',
        loadCloudCursor: () => null,
        saveCloudCursor: () => {},
        getTask: () => undefined,
        getProject: () => undefined,
        getPendingCloudAcks: () => [],
        markCloudAcksSent: () => {},
        getPendingCloudResults: () => [
          { commandId: 'cmd-1', taskId: null, projectId: null, ok: true, reason: null },
        ],
        markCloudResultsSent,
      } as unknown as Store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poller.tick();
    expect(markCloudResultsSent).not.toHaveBeenCalled();
  });

  it('states the protocol version it speaks', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.tick();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('names the machine it is running on, so a browser can name it back', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await poller.tick();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.info).toEqual({
      name: 'WORKSTATION',
      platform: 'win32',
      appVersion: '0.84.5',
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('re-reads the identity on every tick rather than pinning the first answer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    let appVersion = '0.84.5';
    const { poller } = makePoller({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getClientInfo: () => ({ appVersion }),
    });
    await poller.tick();
    appVersion = '0.85.0';
    await poller.tick();

    const versions = fetchImpl.mock.calls.map(
      (call) => (JSON.parse(call[1].body) as { info: { appVersion: string } }).info.appVersion,
    );
    expect(versions).toEqual(['0.84.5', '0.85.0']);
  });

  /** A store that remembers what each tick asked for and what it pruned. */
  function recordingStore(outbox: CloudOutboxRow[] = []): {
    store: Store;
    limits: number[];
    pruned: number[];
  } {
    const limits: number[] = [];
    const pruned: number[] = [];
    const store = {
      getCloudDelta: (_sinceSeq: number, limit: number) => {
        limits.push(limit);
        return outbox.slice(0, limit);
      },
      pruneCloudOutbox: (throughSeq: number) => pruned.push(throughSeq),
      loadCloudClientId: () => 'client-1',
      loadCloudCursor: () => null,
      saveCloudCursor: () => {},
      getTask: (id: string) => ({ id, title: id }) as unknown as Task,
      getProject: () => undefined,
      getPendingCloudAcks: () => [],
      markCloudAcksSent: () => {},
      getPendingCloudResults: () => [],
      markCloudResultsSent: () => {},
    } as unknown as Store;
    return { store, limits, pruned };
  }

  function outboxRows(count: number): CloudOutboxRow[] {
    return Array.from({ length: count }, (_v, i) => ({
      seq: i + 1,
      entity: 'task' as const,
      entityId: `t${i + 1}`,
      op: 'update' as const,
      at: i + 1,
    }));
  }

  it('halves the batch after a 413, so a body some hop refuses is not retried forever', async () => {
    const { store, limits } = recordingStore(outboxRows(5));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 413, statusText: 'Payload Too Large' });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick();
    await poller.tick();
    await poller.tick();

    expect(limits).toEqual([200, 100, 50]);
  });

  it('resets the batch limit once a sync succeeds', async () => {
    const { store, limits } = recordingStore(outboxRows(5));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 413, statusText: 'Payload Too Large' })
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick(); // 413 — halves
    await poller.tick(); // 200 — resets
    await poller.tick();

    expect(limits).toEqual([200, 100, 200]);
  });

  it('does not halve on an ordinary failure — only a 413 says anything about size', async () => {
    const { store, limits } = recordingStore(outboxRows(5));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'err' });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick();
    await poller.tick();

    expect(limits).toEqual([200, 200]);
  });

  it('prunes nothing on a 413 — the rows were never accepted', async () => {
    const { store, pruned } = recordingStore(outboxRows(5));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 413, statusText: 'Payload Too Large' });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick();

    expect(pruned).toEqual([]);
  });

  it('prunes only through the last row the byte cap let it send', async () => {
    // Three cards too big to share one request: the tick sends the first and must leave the
    // outbox holding the other two, rather than pruning through seq 3 and losing them.
    const fat = 'x'.repeat(600_000);
    const limits: number[] = [];
    const pruned: number[] = [];
    const store = {
      getCloudDelta: (_s: number, limit: number) => {
        limits.push(limit);
        return outboxRows(3);
      },
      pruneCloudOutbox: (throughSeq: number) => pruned.push(throughSeq),
      loadCloudClientId: () => 'client-1',
      loadCloudCursor: () => null,
      saveCloudCursor: () => {},
      getTask: (id: string) => ({ id, title: fat }) as unknown as Task,
      getProject: () => undefined,
      getPendingCloudAcks: () => [],
      markCloudAcksSent: () => {},
      getPendingCloudResults: () => [],
      markCloudResultsSent: () => {},
    } as unknown as Store;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick();

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.deltas.tasks.map((t: { id: string }) => t.id)).toEqual(['t1']);
    expect(pruned).toEqual([1]);
  });

  /** A store whose only pending work is `count` relayed answers of `bytes` each. */
  function resultStore(count: number, bytes: number): { store: Store; markedSent: string[][] } {
    const markedSent: string[][] = [];
    const store = {
      getCloudDelta: () => [],
      pruneCloudOutbox: () => {},
      loadCloudClientId: () => 'client-1',
      loadCloudCursor: () => null,
      saveCloudCursor: () => {},
      getTask: () => undefined,
      getProject: () => undefined,
      getPendingCloudAcks: () => [],
      markCloudAcksSent: () => {},
      getPendingCloudResults: () =>
        Array.from({ length: count }, (_v, i) => ({
          commandId: `cmd-${i}`,
          taskId: null,
          projectId: null,
          ok: true,
          reason: null,
          value: 'x'.repeat(bytes),
        })),
      markCloudResultsSent: (ids: readonly string[]) => markedSent.push([...ids]),
    } as unknown as Store;
    return { store, markedSent };
  }

  it('bounds the relayed answers a request carries, instead of sending every pending one', async () => {
    // The 15 Aug 2026 wedge: 36 timeline answers of ~300 kB went out whole on every tick,
    // built a 10 MB body, and were refused 413 forever — with every card queued behind them.
    const { store, markedSent } = resultStore(36, 300_000);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick();

    const raw = fetchImpl.mock.calls[0]![1].body as string;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(2_000_000);
    const body = JSON.parse(raw) as { results: Array<{ commandId: string }> };
    expect(body.results.length).toBeLessThan(36);
    // And only what actually went out is retired — the rest come back next tick.
    expect(markedSent).toEqual([body.results.map((r) => r.commandId)]);
  });

  it('carries the answers left over on the following ticks', async () => {
    const { store, markedSent } = resultStore(4, 400_000);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => response() });
    const { poller } = makePoller({ store, fetchImpl: fetchImpl as unknown as typeof fetch });

    await poller.tick();
    await poller.tick();

    // The fake store keeps returning all four (nothing really clears), so what matters is
    // that each tick sends a bounded slice rather than the whole pile.
    expect(markedSent[0]!.length).toBeGreaterThan(0);
    expect(markedSent[0]!.length).toBeLessThan(4);
    expect(markedSent[1]).toEqual(markedSent[0]);
  });

  it('does not run once disposed', async () => {
    const { poller, fetchImpl } = makePoller();
    poller.dispose();
    poller.reschedule();
    await poller.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('a 401', () => {
    /** A `getAccessToken` that hands out a stale token first, then a fresh one. */
    function staleThenFresh(): ReturnType<typeof vi.fn> {
      let calls = 0;
      return vi.fn(async () => {
        calls += 1;
        return calls === 1 ? 'stale' : 'fresh';
      });
    }

    it('invalidates, refetches the token and retries once, counting the tick as a success', async () => {
      const onAuthRejected = vi.fn();
      const getAccessToken = staleThenFresh();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => response() });
      const { poller } = makePoller({
        onAuthRejected,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await poller.tick();

      expect(onAuthRejected).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBe('Bearer stale');
      expect(fetchImpl.mock.calls[1]![1].headers.authorization).toBe('Bearer fresh');
      expect((poller as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
    });

    it('makes only one retry attempt when the fresh token also comes back 401', async () => {
      const onAuthRejected = vi.fn();
      const getAccessToken = staleThenFresh();
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      const { poller } = makePoller({
        onAuthRejected,
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await poller.tick();

      expect(onAuthRejected).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // no third request
      expect((poller as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(1);
    });

    it('makes exactly one POST when the provider answers null on the retry — PAT mode', async () => {
      // `CloudTokenProvider.invalidate()` (now that a PAT does not rotate) moves straight to
      // `'rejected'`, so the retry's `getAccessToken()` answers null rather than a second
      // token. `fresh && fresh !== token` is then false, and nothing goes out a second time.
      const onAuthRejected = vi.fn();
      let rejected = false;
      const getAccessToken = vi.fn(async () => (rejected ? null : 'tmpat_stale'));
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
      const { poller } = makePoller({
        onAuthRejected: () => {
          rejected = true;
          onAuthRejected();
        },
        getAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await poller.tick();

      expect(onAuthRejected).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('does not retry or invalidate on a 403 — only a 401 means the token is bad', async () => {
      const onAuthRejected = vi.fn();
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
      const { poller } = makePoller({
        onAuthRejected,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await poller.tick();

      expect(onAuthRejected).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((poller as unknown as { consecutiveFailures: number }).consecutiveFailures).toBe(1);
    });
  });

  describe('describeMissingToken', () => {
    it('uses it to say why a null access token happened, instead of the generic message', async () => {
      let thrown: unknown;
      const { poller } = makePoller({
        getAccessToken: async () => null,
        describeMissingToken: () =>
          'The cloud sign-in was revoked. Sign in again to resume syncing.',
        runTracked: async (run) => {
          try {
            return await run();
          } catch (e) {
            thrown = e;
            throw e;
          }
        },
      });

      await poller.tick();

      expect((thrown as Error).message).toBe(
        'The cloud sign-in was revoked. Sign in again to resume syncing.',
      );
    });

    it('falls back to the generic message when omitted', async () => {
      let thrown: unknown;
      const { poller } = makePoller({
        getAccessToken: async () => null,
        runTracked: async (run) => {
          try {
            return await run();
          } catch (e) {
            thrown = e;
            throw e;
          }
        },
      });

      await poller.tick();

      expect((thrown as Error).message).toBe('Not signed in to vipper.iam.');
    });
  });
});
