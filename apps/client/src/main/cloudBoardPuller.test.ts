import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADENCE_MS } from '@protocol/cadence';
import { BOARD_CLIENT_HEADER, BOARD_FOCUS_HEADER, type BoardResponse } from '@protocol/wire';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from '@shared/settings';
import { CloudBoardPuller, type CloudBoardPullerDeps } from './cloudBoardPuller';
import type { FocusSignal } from './cloudPoller';
import type { Store } from './store';

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

/** A minimal `Store` stand-in — only the handful of methods `CloudBoardPuller` calls. */
function fakeStore(): Store & { cursor: string | null } {
  const state = { cursor: null as string | null };
  return {
    loadCloudClientId: () => 'client-1',
    loadCloudBoardCursor: () => state.cursor,
    saveCloudBoardCursor: (next: string) => {
      state.cursor = next;
    },
    hasPendingCloudPush: () => false,
    upsertCloudProject: () => {},
    upsertCloudTask: () => {},
    removeProject: () => {},
    deleteTask: () => {},
    get cursor() {
      return state.cursor;
    },
  } as unknown as Store & { cursor: string | null };
}

function response(overrides: Partial<BoardResponse> = {}): BoardResponse {
  return {
    cursor: 'c1',
    cadence: { tier: 'active', intervalMs: CADENCE_MS.active, reason: 'client-focused' },
    deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
    clients: [],
    ...overrides,
  };
}

function makePuller(
  overrides: Partial<Omit<CloudBoardPullerDeps, 'focus'>> & {
    settings?: Partial<CloudSettings>;
    focus?: ReturnType<typeof fakeFocus>;
  } = {},
): {
  puller: CloudBoardPuller;
  store: Store;
  fetchImpl: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof fakeFocus>;
} {
  const { settings, ...rest } = overrides;
  const focus = rest.focus ?? fakeFocus(true);
  const store = (rest.store as Store) ?? fakeStore();
  const fetchImpl =
    (rest.fetchImpl as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response() });
  const deps: CloudBoardPullerDeps = {
    store,
    focus,
    getSettings: () => ({
      ...DEFAULT_CLOUD_SETTINGS,
      enabled: true,
      baseUrl: 'https://api.example.com',
      ...settings,
    }),
    getAccessToken: async () => 'token',
    runTracked: (run) => run(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    random: () => 0.5,
    ...rest,
  };
  return { puller: new CloudBoardPuller(deps), store, fetchImpl, focus };
}

describe('CloudBoardPuller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule while cloud sync is disabled', () => {
    const { puller, fetchImpl } = makePuller({ settings: { enabled: false } });
    puller.reschedule();
    vi.advanceTimersByTime(10 * 60_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gets GET /v1/board with a bearer token, client id and cursor', async () => {
    const { puller, fetchImpl, store } = makePuller();
    (store as Store & { cursor: string | null }).saveCloudBoardCursor('prev-cursor');
    await puller.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/v1/board?since=prev-cursor');
    expect(init.headers.authorization).toBe('Bearer token');
    expect(init.headers[BOARD_CLIENT_HEADER]).toBe('client-1');
    expect(init.headers[BOARD_FOCUS_HEADER]).toBe('true');
  });

  it('omits since when there is no prior cursor', async () => {
    const { puller, fetchImpl } = makePuller();
    await puller.tick();
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/v1/board');
  });

  it('saves the returned cursor for the next tick', async () => {
    const { puller, store } = makePuller({
      fetchImpl: vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => response({ cursor: 'c2' }) }),
    });
    await puller.tick();
    expect(store.loadCloudBoardCursor()).toBe('c2');
  });

  it('applies the returned delta to the store', async () => {
    const task: Task = {
      id: 't1',
      projectId: PERSONAL_PROJECT_ID,
      phase: '',
      title: 'from the cloud',
      status: 'pending',
      sessionId: null,
      order: 0,
      dependsOn: [],
      source: 'ticket',
      isContract: false,
      isScaffold: false,
    };
    const upsertCloudTask = vi.fn();
    const { puller } = makePuller({
      store: { ...fakeStore(), upsertCloudTask, hasPendingCloudPush: () => false } as Store,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          response({
            deltas: { tasks: [task], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
          }),
      }),
    });
    await puller.tick();
    expect(upsertCloudTask).toHaveBeenCalledWith(task);
  });

  it('re-arms after a successful tick using the server-directed delay', async () => {
    const { puller, fetchImpl } = makePuller();
    puller.reschedule();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CADENCE_MS.active);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('polls again immediately when the server says there is more', async () => {
    const { puller, fetchImpl } = makePuller({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => response({ hasMore: true }),
      }),
    });
    puller.reschedule();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.runOnlyPendingTimersAsync();
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
    const { puller } = makePuller({ fetchImpl: slow as unknown as typeof fetch });
    const first = puller.tick();
    const second = puller.tick();
    resolveDeferred?.();
    await Promise.all([first, second]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('fails the tick when not signed in, without calling fetch', async () => {
    const { puller, fetchImpl } = makePuller({ getAccessToken: async () => null });
    await puller.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
