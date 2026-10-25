import { beforeEach, describe, expect, it } from 'vitest';
import { restingStatus } from '@shared/board';
import type { Project, Task, TaskActivityEntry, TaskStatus } from '@shared/model';
import { releasePrompt } from '@shared/releaseOnDone';
import type { TaskLink } from '@shared/taskChain';
import {
  landedDoneDecision,
  landedDoneWarned,
  landThenMoveToDone,
  moveLandedCardToDone,
  type LandedDoneMoveDeps,
  type LandThenMoveDeps,
  type LandedMr,
} from './landedDoneMove';

const LANDED_AT = 1_000;

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: 'board',
  agentProjectId: 'repo',
  phase: '',
  title: over.id,
  status: 'in-progress',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'ticket',
  isContract: false,
  isScaffold: false,
  ...over,
});

/** Only the field this module reads; the rest of a Project is irrelevant to it. */
const project = (autoDoneOnLand: boolean): Project =>
  ({ id: 'repo', autoDoneOnLand }) as unknown as Project;

const github: LandedMr = { provider: 'github', number: 12, targetBranch: 'development' };
const gitlab: LandedMr = { provider: 'gitlab', number: 7, targetBranch: 'main' };

const statusRow = (createdAt: number): TaskActivityEntry => ({
  kind: 'status',
  id: createdAt,
  from: 'in-progress',
  to: 'in-review',
  createdAt,
});

/**
 * A fake world over a `Map`. `updateTask` applies the patch for real, and the helper itself
 * computes it with the REAL `humanStatusPatch`, so a test asks where the card actually
 * ended up rather than only whether the helper meant to move it.
 */
function harness(
  tasks: Task[],
  opts: {
    on?: boolean;
    openPr?: string[];
    activity?: TaskActivityEntry[];
    forgeFails?: boolean;
  } = {},
) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  const forgeCalls: Task[] = [];
  const updates: Array<{ id: string; patch: Partial<Task> }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const changes: Array<{ id: string; from: TaskStatus; to: TaskStatus }> = [];
  const emitted: Task[] = [];
  const warnings: string[] = [];
  const dismissed: string[] = [];
  const deps: LandedDoneMoveDeps = {
    getTask: (id) => byId.get(id),
    getProject: (id) => (id === 'repo' ? project(opts.on ?? true) : undefined),
    getSubtasks: (parentId) => [...byId.values()].filter((t) => t.parentTaskId === parentId),
    openPrTaskIds: () => new Set(opts.openPr ?? []),
    activity: () => opts.activity ?? [],
    writeForgeMove: async (card) => {
      forgeCalls.push(card);
      if (opts.forgeFails) throw new Error('no Done transition');
      return {};
    },
    updateTask: (id, patch) => {
      updates.push({ id, patch });
      const t = byId.get(id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return t;
    },
    recordStatusChange: (_projectId, id, from, to) => changes.push({ id, from, to }),
    addComment: (_projectId, id, body) => comments.push({ id, body }),
    emit: (t) => emitted.push(t),
    warn: (text) => warnings.push(text),
    dismissAttention: (id) => dismissed.push(id),
  };
  const nothingCalled = () => {
    expect(forgeCalls).toEqual([]);
    expect(updates).toEqual([]);
    expect(comments).toEqual([]);
    expect(changes).toEqual([]);
    expect(emitted).toEqual([]);
    expect(dismissed).toEqual([]);
  };
  return {
    deps,
    byId,
    forgeCalls,
    updates,
    comments,
    changes,
    emitted,
    warnings,
    dismissed,
    nothingCalled,
  };
}

beforeEach(() => landedDoneWarned.clear());

describe('moveLandedCardToDone', () => {
  it('moves an In Progress owner whose PR merged to Done', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })]);

    const moved = await moveLandedCardToDone(h.deps, 'c', github);

    expect(moved?.id).toBe('c');
    expect(h.updates).toEqual([{ id: 'c', patch: { status: 'done' } }]);
    expect(h.byId.get('c')!.status).toBe('done');
    expect(h.comments).toEqual([{ id: 'c', body: 'Moved to Done: #12 merged into development.' }]);
    expect(h.forgeCalls.map((t) => t.id)).toEqual(['c']);
    expect(h.changes).toEqual([{ id: 'c', from: 'in-progress', to: 'done' }]);
    expect(h.emitted.map((t) => t.id)).toEqual(['c']);
    expect(h.dismissed).toEqual(['c']);
    expect(h.warnings).toEqual([]);
  });

  it('moves nothing when the project setting is off', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })], { on: false });

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    h.nothingCalled();
    expect(h.warnings).toEqual([]);
    expect(h.byId.get('c')!.status).toBe('in-progress');
  });

  it.each<TaskStatus>(['done', 'cancelled'])('skips a card already resting in %s', async (s) => {
    const h = harness([task({ id: 'c', status: s, landedAt: LANDED_AT })]);

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    h.nothingCalled();
  });

  it('skips an archived card', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT, archivedAt: 5 })]);

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    h.nothingCalled();
  });

  it('skips a card with another PR still open on it', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })], { openPr: ['c'] });

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    h.nothingCalled();
  });

  it('skips a card with a PR still open on one of its steps', async () => {
    const h = harness(
      [task({ id: 'c', landedAt: LANDED_AT }), task({ id: 's2', parentTaskId: 'c' })],
      { openPr: ['s2'] },
    );

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    h.nothingCalled();
  });

  it('skips a card a human moved after it landed', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })], {
      activity: [statusRow(LANDED_AT + 1)],
    });

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    h.nothingCalled();
  });

  it('still moves a card whose last human move was before it landed', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })], {
      activity: [statusRow(LANDED_AT - 1)],
    });

    expect((await moveLandedCardToDone(h.deps, 'c', github))?.id).toBe('c');

    expect(h.byId.get('c')!.status).toBe('done');
  });

  it('moves the OWNER when a step lands, and never the step', async () => {
    const h = harness([
      task({ id: 'owner', landedAt: LANDED_AT }),
      task({ id: 's1', parentTaskId: 'owner', status: 'done' }),
    ]);

    const moved = await moveLandedCardToDone(h.deps, 's1', github);

    expect(moved?.id).toBe('owner');
    expect(h.byId.get('owner')!.status).toBe('done');
    expect(h.updates.map((u) => u.id)).toEqual(['owner']);
    expect(h.forgeCalls.map((t) => t.id)).toEqual(['owner']);
    expect(h.comments.map((c) => c.id)).toEqual(['owner']);
  });

  it('moves an owner that landed itself', async () => {
    const h = harness([
      task({ id: 'owner', landedAt: LANDED_AT }),
      task({ id: 's1', parentTaskId: 'owner', status: 'done' }),
    ]);

    expect((await moveLandedCardToDone(h.deps, 'owner', github))?.id).toBe('owner');

    expect(h.updates.map((u) => u.id)).toEqual(['owner']);
  });

  it('writes into preRunStatus when a run has borrowed status', async () => {
    const h = harness([
      task({ id: 'c', status: 'running', preRunStatus: 'in-progress', landedAt: LANDED_AT }),
    ]);

    await moveLandedCardToDone(h.deps, 'c', github);

    const card = h.byId.get('c')!;
    expect(card.status).toBe('running');
    expect(restingStatus(card)).toBe('done');
  });

  it('does not move the card when the forge write fails, and warns once', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT, externalKey: 'TM-1' })], {
      forgeFails: true,
    });

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();
    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    expect(h.forgeCalls).toHaveLength(2);
    expect(h.updates).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.changes).toEqual([]);
    expect(h.emitted).toEqual([]);
    expect(h.byId.get('c')!.status).toBe('in-progress');
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('TM-1');
  });

  it('names a GitLab MR with !', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })]);

    await moveLandedCardToDone(h.deps, 'c', gitlab);

    expect(h.comments).toEqual([{ id: 'c', body: 'Moved to Done: !7 merged into main.' }]);
  });

  it('is a no-op the second time, because the card is already Done', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })]);

    await moveLandedCardToDone(h.deps, 'c', github);
    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    expect(h.forgeCalls).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
    expect(h.comments).toHaveLength(1);
  });

  it('stops when a human moved the card while the forge answered', async () => {
    const h = harness([task({ id: 'c', landedAt: LANDED_AT })]);
    const write = h.deps.writeForgeMove;
    h.deps.writeForgeMove = async (card) => {
      const extra = await write(card);
      h.byId.get('c')!.status = 'done';
      return extra;
    };

    expect(await moveLandedCardToDone(h.deps, 'c', github)).toBeNull();

    expect(h.updates).toEqual([]);
    expect(h.comments).toEqual([]);
  });
});

describe('landedDoneDecision', () => {
  const base = {
    project: project(true),
    openPrTaskIds: new Set<string>(),
    stepIds: [] as string[],
    movedAfterLand: false,
  };

  it('reports why a card is skipped, in guard order', () => {
    const landed = task({ id: 'c', landedAt: LANDED_AT });
    expect(landedDoneDecision({ ...base, card: landed })).toEqual({ move: true });
    expect(landedDoneDecision({ ...base, project: project(false), card: landed })).toEqual({
      move: false,
      reason: 'setting-off',
    });
    expect(landedDoneDecision({ ...base, project: undefined, card: landed })).toEqual({
      move: false,
      reason: 'setting-off',
    });
    expect(landedDoneDecision({ ...base, card: { ...landed, parentTaskId: 'p' } })).toEqual({
      move: false,
      reason: 'step',
    });
    expect(landedDoneDecision({ ...base, card: task({ id: 'c' }) })).toEqual({
      move: false,
      reason: 'not-landed',
    });
    expect(landedDoneDecision({ ...base, card: landed, movedAfterLand: true })).toEqual({
      move: false,
      reason: 'human-moved',
    });
  });
});

describe('landThenMoveToDone', () => {
  it('stamps landedAt before the Done write, so the move never asks to release', async () => {
    const card = task({ id: 'c' });
    const successor = task({ id: 's', status: 'pending' });
    const h = harness([card, successor]);
    const order: string[] = [];
    const before = { ...h.byId.get('c')! };
    const deps: LandThenMoveDeps = {
      ...h.deps,
      noteWorkLanded: (id) => {
        order.push('landed');
        Object.assign(h.byId.get(id)!, { landedAt: LANDED_AT });
      },
      updateTask: (id, patch) => {
        order.push(`update:${h.byId.get(id)!.landedAt}`);
        return h.deps.updateTask(id, patch);
      },
      logError: () => {},
    };

    const moved = await landThenMoveToDone(deps, 'c', github);

    expect(order).toEqual(['landed', `update:${LANDED_AT}`]);
    expect(moved?.status).toBe('done');
    const links: TaskLink[] = [
      { id: 'c->s', fromTaskId: 'c', toTaskId: 's', gate: 'after-merge', createdAt: 0 },
    ];
    // The same pair a human drag would be asked about — but this card has landed.
    expect(
      releasePrompt({
        origin: 'human',
        before,
        after: moved!,
        links,
        byId: h.byId,
        mergeRequests: [],
      }),
    ).toBeNull();
  });

  it('still stamps the landing when no merged row names the card, and logs a failed move', async () => {
    const h = harness([task({ id: 'c' })], { forgeFails: true });
    const landed: string[] = [];
    const logged: string[] = [];
    const deps: LandThenMoveDeps = {
      ...h.deps,
      noteWorkLanded: (id) => {
        landed.push(id);
        Object.assign(h.byId.get(id)!, { landedAt: LANDED_AT });
      },
      logError: (message) => logged.push(message),
    };

    expect(await landThenMoveToDone(deps, 'c', undefined)).toBeNull();
    expect(landed).toEqual(['c']);
    h.nothingCalled();

    // A throwing dep below the move (not the forge write, which warns) is logged, not thrown.
    const throwing: LandThenMoveDeps = {
      ...deps,
      activity: () => {
        throw new Error('db gone');
      },
    };
    expect(await landThenMoveToDone(throwing, 'c', github)).toBeNull();
    expect(logged).toEqual(['Moving landed card c to Done failed']);
  });

  /** A merged PR's own `merged_at`, not the moment the sync noticed, is when it landed. */
  describe('a landing stamped at the PR’s merge time', () => {
    const MERGED_AT = 400;
    const landingDeps = (h: ReturnType<typeof harness>, calls: unknown[][]): LandThenMoveDeps => ({
      ...h.deps,
      noteWorkLanded: (id, at) => {
        calls.push([id, at]);
        // What `chain.landed` does: the given time, else now.
        const t = h.byId.get(id)!;
        if (t.landedAt == null) t.landedAt = at ?? LANDED_AT;
      },
      logError: () => {},
    });

    it('forwards mr.mergedAt to noteWorkLanded', async () => {
      const h = harness([task({ id: 'c' })]);
      const calls: unknown[][] = [];
      await landThenMoveToDone(landingDeps(h, calls), 'c', { ...github, mergedAt: MERGED_AT });
      expect(calls).toEqual([['c', MERGED_AT]]);
      expect(h.byId.get('c')?.landedAt).toBe(MERGED_AT);
      expect(restingStatus(h.byId.get('c')!)).toBe('done');
    });

    it('passes undefined when the forge never said (GitLab)', async () => {
      const h = harness([task({ id: 'c' })]);
      const calls: unknown[][] = [];
      await landThenMoveToDone(landingDeps(h, calls), 'c', gitlab);
      expect(calls).toEqual([['c', undefined]]);
    });

    /**
     * The gap a past `landedAt` opens: between the merge and the sync that learns of it. Every
     * writer of a `status` row is a human move (see `movedSince`), so a row in that gap is a
     * person who moved the card AFTER it merged — and their move still wins. A row from
     * before the merge does not count, exactly as before.
     */
    it('lets a human move made after the merge, before the sync, win', async () => {
      const h = harness([task({ id: 'c' })], { activity: [statusRow(MERGED_AT + 50)] });
      await landThenMoveToDone(landingDeps(h, []), 'c', { ...github, mergedAt: MERGED_AT });
      expect(h.byId.get('c')?.landedAt).toBe(MERGED_AT);
      expect(h.changes).toEqual([]);
    });

    it('still moves a card whose last human move predates the merge', async () => {
      const h = harness([task({ id: 'c' })], { activity: [statusRow(MERGED_AT - 50)] });
      await landThenMoveToDone(landingDeps(h, []), 'c', { ...github, mergedAt: MERGED_AT });
      expect(h.changes).toEqual([{ id: 'c', from: 'in-progress', to: 'done' }]);
    });
  });
});
