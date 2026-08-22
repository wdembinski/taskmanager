import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assignment } from '@shared/agent';
import type { Project, Task } from '@shared/model';
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from '@shared/settings';
import { AssignmentPoller, type AssignmentPollerDeps } from './assignmentPoller';
import type { FocusSignal } from './cloudPoller';
import type { Store } from './store';

function fakeFocus(initial: boolean): FocusSignal {
  let focused = initial;
  const listeners = new Set<(focused: boolean) => void>();
  return {
    isFocused: () => focused,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function ticketProject(id: string): Project {
  return {
    id,
    name: id,
    path: '',
    planPath: '',
    defaultModel: 'sonnet',
    planningModel: null,
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: false,
    baseBranch: '',
    writeBackPlan: false,
    autoRelease: false,
    autoCreatePr: false,
    autoIntegrate: null,
    planAligned: true,
    jiraEpicKeys: [],
    ticketPrefix: 'TM',
    target: { kind: 'local' },
    instructions: '',
    color: '',
    createdAt: 0,
  };
}

function ticketTask(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    phase: '',
    title: 'A ticket',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
  };
}

/** A minimal `Store` stand-in — only the handful of methods `AssignmentPoller` calls. */
function fakeStore(overrides: Partial<Store> = {}): Store {
  return {
    loadCloudClientId: () => 'client-1',
    listProjects: () => [],
    getTask: () => undefined,
    ...overrides,
  } as unknown as Store;
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'assign-1',
    projectId: 'proj-1',
    ticketId: 'ticket-1',
    profileId: 'profile-1',
    status: 'queued',
    claimedByClientId: null,
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    runId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makePoller(
  overrides: Partial<Omit<AssignmentPollerDeps, 'focus'>> & {
    settings?: Partial<CloudSettings>;
    focus?: FocusSignal;
  } = {},
): {
  poller: AssignmentPoller;
  fetchImpl: ReturnType<typeof vi.fn>;
  runTask: ReturnType<typeof vi.fn>;
} {
  const { settings, ...rest } = overrides;
  const fetchImpl =
    (rest.fetchImpl as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
  const runTask = (rest.runTask as ReturnType<typeof vi.fn>) ?? vi.fn().mockReturnValue(null);
  const deps: AssignmentPollerDeps = {
    store: fakeStore(),
    focus: fakeFocus(true),
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
    runTask,
  };
  return { poller: new AssignmentPoller(deps), fetchImpl, runTask };
}

describe('AssignmentPoller', () => {
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

  it('gets GET /v1/assignments?status=queued with a bearer token', async () => {
    const { poller, fetchImpl } = makePoller();
    await poller.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/v1/assignments?status=queued');
    expect(init.headers.authorization).toBe('Bearer token');
  });

  it('ignores a queued assignment for a project this desktop does not serve', async () => {
    const { poller, fetchImpl, runTask } = makePoller({
      store: fakeStore({
        listProjects: () => [ticketProject('other-project')],
        getTask: () => ticketTask('ticket-1', 'proj-1'),
      }),
      fetchImpl: vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => [assignment()] }),
    });
    await poller.tick();
    // Only the one GET — no claim call was made.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('ignores a queued assignment for a ticket not yet pulled down locally', async () => {
    const { poller, fetchImpl, runTask } = makePoller({
      store: fakeStore({
        listProjects: () => [ticketProject('proj-1')],
        getTask: () => undefined,
      }),
      fetchImpl: vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => [assignment()] }),
    });
    await poller.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('claims and starts a queued assignment for a project it serves', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith('/v1/assignments?status=queued')) {
        return { ok: true, status: 200, json: async () => [assignment()] };
      }
      if (String(url).endsWith('/claim')) {
        return { ok: true, status: 200, json: async () => assignment({ status: 'claimed' }) };
      }
      return { ok: true, status: 200, json: async () => assignment({ status: 'running' }) };
    });
    const { poller, runTask } = makePoller({
      store: fakeStore({
        listProjects: () => [ticketProject('proj-1')],
        getTask: () => ticketTask('ticket-1', 'proj-1'),
      }),
      fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
      runTask: vi.fn().mockReturnValue({ runId: 'run-1' }),
    });

    await poller.tick();

    expect(runTask).toHaveBeenCalledWith('ticket-1');
    expect(calls).toHaveLength(3);
    expect(calls[1].url).toBe('https://api.example.com/v1/assignments/assign-1/claim');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ clientId: 'client-1' });
    expect(calls[2].url).toBe('https://api.example.com/v1/assignments/assign-1/complete');
    expect(JSON.parse(String(calls[2].init.body))).toEqual({
      status: 'running',
      clientId: 'client-1',
      runId: 'run-1',
    });
  });

  it('does not start a run when the claim loses the race', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/assignments?status=queued')) {
        return { ok: true, status: 200, json: async () => [assignment()] };
      }
      if (String(url).endsWith('/claim')) {
        return { ok: false, status: 400, json: async () => ({}) };
      }
      throw new Error('unexpected call');
    });
    const { poller, runTask } = makePoller({
      store: fakeStore({
        listProjects: () => [ticketProject('proj-1')],
        getTask: () => ticketTask('ticket-1', 'proj-1'),
      }),
      fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    });

    await poller.tick();
    expect(runTask).not.toHaveBeenCalled();
  });

  it('leaves the assignment claimed when the scheduler refuses to start it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/assignments?status=queued')) {
        return { ok: true, status: 200, json: async () => [assignment()] };
      }
      if (String(url).endsWith('/claim')) {
        return { ok: true, status: 200, json: async () => assignment({ status: 'claimed' }) };
      }
      throw new Error('should not report completion when the scheduler refused');
    });
    const { poller, runTask } = makePoller({
      store: fakeStore({
        listProjects: () => [ticketProject('proj-1')],
        getTask: () => ticketTask('ticket-1', 'proj-1'),
      }),
      fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
      runTask: vi.fn().mockReturnValue(null),
    });

    await poller.tick();
    expect(runTask).toHaveBeenCalledWith('ticket-1');
  });
});
