import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { CommandEnvelope } from '@protocol/wire';
import { applyCloudCommand } from './cloudCommands';
import { RelayRegistry } from './ipcRegistry';
import type { StoredCloudOutcome, Store } from './store';

const task = (over: Partial<Task>): Task => ({
  id: 't1',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const project = (over: Partial<Project>): Project =>
  ({
    id: 'p1',
    name: 'Some project',
    kind: 'plan',
    ...over,
  }) as Project;

/** An in-memory `Store` stand-in — only the surface `cloudCommands.ts` actually calls. */
function fakeStore(seed: { tasks?: Task[]; projects?: Project[] } = {}): Store & {
  comments: Array<{ taskId: string; body: string }>;
} {
  const tasks = new Map((seed.tasks ?? []).map((t) => [t.id, t]));
  const projects = new Map((seed.projects ?? []).map((p) => [p.id, p]));
  const applied = new Map<string, StoredCloudOutcome>();
  const comments: Array<{ taskId: string; body: string }> = [];

  return {
    comments,
    getTask: (id: string) => tasks.get(id),
    getProject: (id: string) => projects.get(id),
    updateTask: (id: string, patch: Partial<Task>) => {
      const existing = tasks.get(id);
      if (!existing) return undefined;
      const next = { ...existing, ...patch };
      tasks.set(id, next);
      return next;
    },
    createTask: (
      projectId: string,
      input: { title: string; phase?: string; description?: string | null },
    ) => {
      const title = input.title.trim();
      if (!title) return undefined;
      const created = task({
        id: `new-${tasks.size}`,
        projectId,
        title,
        phase: input.phase ?? '',
        externalDescription: input.description ?? null,
      });
      tasks.set(created.id, created);
      return created;
    },
    addComment: (_projectId: string, taskId: string, body: string) => {
      const text = body.trim();
      if (!text) return undefined;
      comments.push({ taskId, body: text });
      return { kind: 'comment' as const, id: comments.length, body: text, createdAt: 0 };
    },
    recordStatusChange: vi.fn(),
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getCloudCommandOutcome: (id: string) => applied.get(id) ?? null,
    recordCloudCommandApplied: (id: string, outcome: StoredCloudOutcome) => {
      applied.set(id, outcome);
    },
    runInTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Store & { comments: Array<{ taskId: string; body: string }> };
}

function setStatus(id: string, taskId: string, status: string): CommandEnvelope {
  return {
    id,
    issuedAt: 1,
    issuedBy: 'web',
    kind: 'set-status',
    payload: { taskId, status: status as never },
  };
}

function addComment(id: string, taskId: string, body: string): CommandEnvelope {
  return { id, issuedAt: 1, issuedBy: 'web', kind: 'add-comment', payload: { taskId, body } };
}

function createTask(id: string, projectId: string, title: string): CommandEnvelope {
  return { id, issuedAt: 1, issuedBy: 'web', kind: 'create-task', payload: { projectId, title } };
}

describe('applyCloudCommand: set-status', () => {
  it('moves an adhoc card to the requested status', async () => {
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'pending' })] });
    const outcome = await applyCloudCommand(store, setStatus('c1', 't1', 'in-review'));
    expect(outcome).toMatchObject({ ok: true, taskId: 't1' });
    expect(store.getTask('t1')?.status).toBe('in-review');
  });

  it('rejects an unknown task', async () => {
    const store = fakeStore();
    const outcome = await applyCloudCommand(store, setStatus('c1', 'missing', 'in-review'));
    expect(outcome).toMatchObject({ ok: false, reason: 'Task not found.' });
  });

  it('rejects a status that is not hand-settable', async () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    const outcome = await applyCloudCommand(store, setStatus('c1', 't1', 'running'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/not a hand-settable status/);
  });

  it('rejects a move that would need a JIRA transition, and leaves a comment on the card', async () => {
    const store = fakeStore({
      tasks: [task({ id: 't1', status: 'pending', externalSource: 'jira', externalKey: 'TM-1' })],
    });
    const outcome = await applyCloudCommand(store, setStatus('c1', 't1', 'in-review'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/JIRA/);
    expect(store.getTask('t1')?.status).toBe('pending'); // unchanged
    expect(store.comments).toEqual([{ taskId: 't1', body: expect.stringContaining('JIRA') }]);
  });

  it('is a no-op when the card already rests at the requested status', async () => {
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'in-review' })] });
    const outcome = await applyCloudCommand(store, setStatus('c1', 't1', 'in-review'));
    expect(outcome.ok).toBe(true);
    expect(store.recordStatusChange).not.toHaveBeenCalled();
  });
});

describe('applyCloudCommand: add-comment', () => {
  it('appends a comment to the task', async () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    const outcome = await applyCloudCommand(store, addComment('c1', 't1', 'hello'));
    expect(outcome.ok).toBe(true);
    expect(store.comments).toContainEqual({ taskId: 't1', body: 'hello' });
  });

  it('rejects a blank comment', async () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    const outcome = await applyCloudCommand(store, addComment('c1', 't1', '   '));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/needs some text/);
  });

  it('rejects an unknown task', async () => {
    const store = fakeStore();
    const outcome = await applyCloudCommand(store, addComment('c1', 'missing', 'hello'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('Task not found.');
  });
});

describe('applyCloudCommand: create-task', () => {
  it('files a new task under the named project', async () => {
    const store = fakeStore({ projects: [project({ id: 'p1' })] });
    const outcome = await applyCloudCommand(store, createTask('c1', 'p1', 'Ship it'));
    expect(outcome.ok).toBe(true);
    expect(outcome.taskId).toBeTruthy();
    expect(store.getTask(outcome.taskId!)?.title).toBe('Ship it');
  });

  it('rejects an unknown project', async () => {
    const store = fakeStore();
    const outcome = await applyCloudCommand(store, createTask('c1', 'missing', 'Ship it'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('Unknown project.');
  });

  it('rejects a blank title', async () => {
    const store = fakeStore({ projects: [project({ id: 'p1' })] });
    const outcome = await applyCloudCommand(store, createTask('c1', 'p1', '   '));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/needs a title/);
  });
});

describe('applyCloudCommand: ipc-invoke', () => {
  const invoke = (id: string, channel: string, args: unknown[] = []): CommandEnvelope => ({
    id,
    issuedAt: 1,
    issuedBy: 'web',
    kind: 'ipc-invoke',
    payload: { channel, args },
  });

  it('runs the desktop’s own handler and carries its value back', async () => {
    const store = fakeStore();
    const registry = new RelayRegistry();
    registry.register('board:tasks', async () => [{ id: 't1' }]);

    const outcome = await applyCloudCommand(store, invoke('c1', 'board:tasks'), registry);
    expect(outcome).toMatchObject({ ok: true, value: [{ id: 't1' }] });
  });

  it('passes the arguments through', async () => {
    const store = fakeStore();
    const registry = new RelayRegistry();
    const handler = vi.fn(async () => undefined);
    registry.register('task:move', handler as never);

    await applyCloudCommand(store, invoke('c1', 'task:move', ['t1', 'done']), registry);
    expect(handler).toHaveBeenCalledWith('t1', 'done');
  });

  it('refuses a host-only channel with the reason, not a generic error', async () => {
    const store = fakeStore();
    const registry = new RelayRegistry();
    registry.register('project:pickDirectory', async () => 'C:/somewhere');

    const outcome = await applyCloudCommand(store, invoke('c1', 'project:pickDirectory'), registry);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('file picker');
  });

  it('carries a rejecting handler’s message verbatim', async () => {
    const store = fakeStore();
    const registry = new RelayRegistry();
    registry.register('task:run', async () => {
      throw new Error('A usage limit is holding all work.');
    });

    const outcome = await applyCloudCommand(store, invoke('c1', 'task:run', ['t1']), registry);
    expect(outcome).toMatchObject({ ok: false, reason: 'A usage limit is holding all work.' });
  });

  it('merges a settings:save over the current blob instead of overwriting it', async () => {
    // The staleness this exists for: the tab is saving a blob it read before the engine
    // learned a JIRA base URL, and a whole-blob write would erase it.
    const store = fakeStore();
    const registry = new RelayRegistry();
    let saved: unknown = null;
    registry.register('settings:save', async (settings: never) => {
      saved = settings;
    });

    await applyCloudCommand(store, invoke('c1', 'settings:save', [{ concurrency: 5 }]), registry);
    expect(saved).toMatchObject({ concurrency: 5, branchPrefix: DEFAULT_SETTINGS.branchPrefix });
    expect(saved).toHaveProperty('jira');
  });
});

describe('applyCloudCommand: replay and isolation', () => {
  it('replays a redelivered command’s answer instead of running it again', async () => {
    const store = fakeStore();
    const registry = new RelayRegistry();
    const handler = vi.fn(async () => 'first answer');
    registry.register('board:tasks', handler as never);

    const command: CommandEnvelope = {
      id: 'c1',
      issuedAt: 1,
      issuedBy: 'web',
      kind: 'ipc-invoke',
      payload: { channel: 'board:tasks', args: [] },
    };
    const first = await applyCloudCommand(store, command, registry);
    const second = await applyCloudCommand(store, command, registry);

    expect(handler).toHaveBeenCalledTimes(1);
    // Not merely `{ok:true}` — the value has to come back, because a browser is still
    // awaiting THIS command id and the ledger is the only copy of the answer left.
    expect(second).toEqual(first);
    expect(second.value).toBe('first answer');
  });

  it('does not roll back a previous command’s write when a later one fails', async () => {
    // This is the `db.transaction(asyncFn)` trap, stated as a test. When the whole batch ran
    // inside one `store.runInTransaction`, a throw took every earlier command's write with
    // it — and once the function became async, the transaction silently committed at the
    // first await instead, which is the OTHER half of the same bug. Each command now stands
    // on its own, so neither can happen.
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'pending' })] });
    const registry = new RelayRegistry();
    registry.register('task:run', async () => {
      throw new Error('nope');
    });

    await applyCloudCommand(store, setStatus('c1', 't1', 'in-review'));
    const failed = await applyCloudCommand(
      store,
      {
        id: 'c2',
        issuedAt: 2,
        issuedBy: 'web',
        kind: 'ipc-invoke',
        payload: { channel: 'task:run', args: ['t1'] },
      },
      registry,
    );

    expect(failed.ok).toBe(false);
    expect(store.getTask('t1')?.status).toBe('in-review');
  });

  it('applies commands in the order it is handed them, not by issuedAt', async () => {
    // `issuedAt` is a browser's wall clock. The server delivers `createdAt ASC` from a clock
    // it owns, and that order is the one that is honoured.
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'pending' })] });
    const later: CommandEnvelope = {
      id: 'c1',
      issuedAt: 2,
      issuedBy: 'web',
      kind: 'set-status',
      payload: { taskId: 't1', status: 'done' },
    };
    const earlier: CommandEnvelope = {
      id: 'c2',
      issuedAt: 1,
      issuedBy: 'web',
      kind: 'set-status',
      payload: { taskId: 't1', status: 'in-review' },
    };

    await applyCloudCommand(store, later);
    await applyCloudCommand(store, earlier);
    expect(store.getTask('t1')?.status).toBe('in-review');
  });

  it('rejects a command kind this build predates rather than throwing', async () => {
    const store = fakeStore();
    const outcome = await applyCloudCommand(store, {
      id: 'c1',
      issuedAt: 1,
      issuedBy: 'web',
      kind: 'teleport' as never,
      payload: {} as never,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'Unknown command kind.' });
  });
});
