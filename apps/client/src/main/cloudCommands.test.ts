import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import type { CommandEnvelope } from '@protocol/wire';
import { applyCloudCommands } from './cloudCommands';
import type { Store } from './store';

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
  const applied = new Set<string>();
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
    isCloudCommandApplied: (id: string) => applied.has(id),
    markCloudCommandApplied: (id: string) => {
      applied.add(id);
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

describe('applyCloudCommands: set-status', () => {
  it('moves an adhoc card to the requested status', () => {
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'pending' })] });
    const [outcome] = applyCloudCommands(store, [setStatus('c1', 't1', 'in-review')]);
    expect(outcome).toMatchObject({ ok: true, taskId: 't1' });
    expect(store.getTask('t1')?.status).toBe('in-review');
  });

  it('rejects an unknown task', () => {
    const store = fakeStore();
    const [outcome] = applyCloudCommands(store, [setStatus('c1', 'missing', 'in-review')]);
    expect(outcome).toMatchObject({ ok: false, reason: 'Task not found.' });
  });

  it('rejects a status that is not hand-settable', () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    const [outcome] = applyCloudCommands(store, [setStatus('c1', 't1', 'running')]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/not a hand-settable status/);
  });

  it('rejects a move that would need a JIRA transition, and leaves a comment on the card', () => {
    const store = fakeStore({
      tasks: [task({ id: 't1', status: 'pending', externalSource: 'jira', externalKey: 'TM-1' })],
    });
    const [outcome] = applyCloudCommands(store, [setStatus('c1', 't1', 'in-review')]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/JIRA/);
    expect(store.getTask('t1')?.status).toBe('pending'); // unchanged
    expect(store.comments).toEqual([{ taskId: 't1', body: expect.stringContaining('JIRA') }]);
  });

  it('is a no-op when the card already rests at the requested status', () => {
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'in-review' })] });
    const [outcome] = applyCloudCommands(store, [setStatus('c1', 't1', 'in-review')]);
    expect(outcome.ok).toBe(true);
    expect(store.recordStatusChange).not.toHaveBeenCalled();
  });
});

describe('applyCloudCommands: add-comment', () => {
  it('appends a comment to the task', () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    const [outcome] = applyCloudCommands(store, [addComment('c1', 't1', 'hello')]);
    expect(outcome.ok).toBe(true);
    expect(store.comments).toContainEqual({ taskId: 't1', body: 'hello' });
  });

  it('rejects a blank comment', () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    const [outcome] = applyCloudCommands(store, [addComment('c1', 't1', '   ')]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/needs some text/);
  });

  it('rejects an unknown task', () => {
    const store = fakeStore();
    const [outcome] = applyCloudCommands(store, [addComment('c1', 'missing', 'hello')]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('Task not found.');
  });
});

describe('applyCloudCommands: create-task', () => {
  it('files a new task under the named project', () => {
    const store = fakeStore({ projects: [project({ id: 'p1' })] });
    const [outcome] = applyCloudCommands(store, [createTask('c1', 'p1', 'Ship it')]);
    expect(outcome.ok).toBe(true);
    expect(outcome.taskId).toBeTruthy();
    expect(store.getTask(outcome.taskId!)?.title).toBe('Ship it');
  });

  it('rejects an unknown project', () => {
    const store = fakeStore();
    const [outcome] = applyCloudCommands(store, [createTask('c1', 'missing', 'Ship it')]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('Unknown project.');
  });

  it('rejects a blank title', () => {
    const store = fakeStore({ projects: [project({ id: 'p1' })] });
    const [outcome] = applyCloudCommands(store, [createTask('c1', 'p1', '   ')]);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/needs a title/);
  });
});

describe('applyCloudCommands: dedupe and ordering', () => {
  it('applies the same command id only once', () => {
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'pending' })] });
    applyCloudCommands(store, [setStatus('c1', 't1', 'in-review')]);
    store.updateTask('t1', { status: 'pending' }); // simulate a later, unrelated local move
    const [outcome] = applyCloudCommands(store, [setStatus('c1', 't1', 'in-review')]);
    expect(outcome.ok).toBe(true);
    expect(store.getTask('t1')?.status).toBe('pending'); // the repeat did not re-apply
  });

  it('applies out-of-order commands in issuedAt order', () => {
    const store = fakeStore({ tasks: [task({ id: 't1', status: 'pending' })] });
    const first: CommandEnvelope = {
      id: 'c1',
      issuedAt: 2,
      issuedBy: 'web',
      kind: 'set-status',
      payload: { taskId: 't1', status: 'done' },
    };
    const second: CommandEnvelope = {
      id: 'c2',
      issuedAt: 1,
      issuedBy: 'web',
      kind: 'set-status',
      payload: { taskId: 't1', status: 'in-review' },
    };
    // Handed in reverse of issuedAt order — applying must still process c2 (issuedAt 1) first.
    applyCloudCommands(store, [first, second]);
    expect(store.getTask('t1')?.status).toBe('done');
  });
});
