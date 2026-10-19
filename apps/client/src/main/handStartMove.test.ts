import { describe, expect, it } from 'vitest';
import { restingStatus } from '@shared/board';
import { PERSONAL_PROJECT_ID, type Task, type TaskStatus } from '@shared/model';
import { HAND_START_NOTE, moveHandStartedCard, type HandStartMoveDeps } from './handStartMove';

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

/**
 * A fake world over a `Map`. `updateTask` applies the patch for real, and the helper itself
 * computes it with the REAL `humanStatusPatch`, so a test asks where the card actually
 * ended up rather than only whether the helper meant to move it.
 */
function harness(tasks: Task[], opts: { forgeFails?: boolean } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const forgeCalls: Task[] = [];
  const comments: Array<{ id: string; body: string }> = [];
  const changes: Array<{ id: string; from: TaskStatus; to: TaskStatus }> = [];
  const emitted: Task[] = [];
  const warnings: string[] = [];
  const deps: HandStartMoveDeps = {
    getTask: (id) => byId.get(id),
    writeForgeMove: async (card) => {
      forgeCalls.push(card);
      if (opts.forgeFails) throw new Error('no In Progress transition');
      return {};
    },
    updateTask: (id, patch) => {
      const t = byId.get(id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return t;
    },
    recordStatusChange: (_projectId, id, from, to) => changes.push({ id, from, to }),
    addComment: (_projectId, id, body) => comments.push({ id, body }),
    emit: (t) => emitted.push(t),
    warn: (text) => warnings.push(text),
  };
  return { deps, byId, forgeCalls, comments, changes, emitted, warnings };
}

describe('moveHandStartedCard', () => {
  it('moves a started To Do card to In Progress, once', async () => {
    // As after a real start: the run has borrowed `status`, and remembers To Do.
    const h = harness([task({ id: 'c', status: 'running', preRunStatus: 'pending' })]);

    const moved = await moveHandStartedCard(h.deps, 'c');

    const card = h.byId.get('c')!;
    expect(moved?.id).toBe('c');
    expect(restingStatus(card)).toBe('in-progress');
    expect(card.status).toBe('running'); // the run keeps its field
    expect(h.forgeCalls.map((t) => t.id)).toEqual(['c']);
    expect(h.comments).toEqual([{ id: 'c', body: HAND_START_NOTE }]);
    expect(h.changes).toEqual([{ id: 'c', from: 'pending', to: 'in-progress' }]);
    expect(h.emitted.map((t) => t.id)).toEqual(['c']);
    expect(h.warnings).toEqual([]);
  });

  it('writes a plain in-progress when nothing is borrowed', async () => {
    const h = harness([task({ id: 'c', status: 'pending' })]);

    await moveHandStartedCard(h.deps, 'c');

    expect(h.byId.get('c')!.status).toBe('in-progress');
    expect(h.comments).toHaveLength(1);
  });

  it.each<TaskStatus>(['in-review', 'done', 'blocked', 'in-progress'])(
    'leaves a card resting in %s where it is',
    async (resting) => {
      const h = harness([task({ id: 'c', status: 'running', preRunStatus: resting })]);

      expect(await moveHandStartedCard(h.deps, 'c')).toBeNull();

      expect(restingStatus(h.byId.get('c')!)).toBe(resting);
      expect(h.forgeCalls).toEqual([]);
      expect(h.comments).toEqual([]);
      expect(h.changes).toEqual([]);
      expect(h.emitted).toEqual([]);
    },
  );

  it('moves the OWNER when a step is started, and never the step', async () => {
    const h = harness([
      task({ id: 'owner', status: 'pending' }),
      task({ id: 's1', parentTaskId: 'owner', status: 'running', preRunStatus: 'pending' }),
    ]);

    const moved = await moveHandStartedCard(h.deps, 's1');

    expect(moved?.id).toBe('owner');
    expect(h.byId.get('owner')!.status).toBe('in-progress');
    const step = h.byId.get('s1')!;
    expect(step.status).toBe('running');
    expect(step.preRunStatus).toBe('pending');
    expect(h.forgeCalls.map((t) => t.id)).toEqual(['owner']);
    expect(h.comments).toEqual([{ id: 'owner', body: HAND_START_NOTE }]);
  });

  it('moves nothing when a step is started on an owner resting In Review', async () => {
    const h = harness([
      task({ id: 'owner', status: 'in-review' }),
      task({ id: 's1', parentTaskId: 'owner', status: 'running', preRunStatus: 'pending' }),
    ]);

    expect(await moveHandStartedCard(h.deps, 's1')).toBeNull();

    expect(h.byId.get('owner')!.status).toBe('in-review');
    expect(h.forgeCalls).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  it('moves nothing on a plan-project task', async () => {
    const h = harness([
      task({ id: 'p', projectId: 'some-plan-project', source: 'plan', status: 'running' }),
    ]);

    expect(await moveHandStartedCard(h.deps, 'p')).toBeNull();

    expect(h.byId.get('p')!.status).toBe('running');
    expect(h.forgeCalls).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  it('still moves the card when the forge write fails, and warns once', async () => {
    const h = harness(
      [task({ id: 'c', status: 'running', preRunStatus: 'pending', externalKey: 'TM-1' })],
      { forgeFails: true },
    );

    const moved = await moveHandStartedCard(h.deps, 'c');

    expect(moved?.id).toBe('c');
    expect(restingStatus(h.byId.get('c')!)).toBe('in-progress');
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('TM-1');
    expect(h.warnings[0]).toContain('The run started anyway.');
    expect(h.comments).toEqual([{ id: 'c', body: HAND_START_NOTE }]);
  });
});
