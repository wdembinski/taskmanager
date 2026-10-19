import { describe, expect, it } from 'vitest';
import type { MergeRequest } from './mergeRequest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  DEFAULT_READY_LANES,
  compareLaneOrder,
  openPrTaskIds,
  readyLanes,
  readyLanesByProject,
} from './readyLanes';
import type { TaskLink } from './taskChain';

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

/** `a → b`, i.e. b runs after a. */
const link = (from: string, to: string): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate: 'after-merge',
  createdAt: 0,
});

/** The predecessor every candidate hangs off: already landed, so its arrows are satisfied. */
const root = task({ id: 'root', status: 'done', landedAt: 1 });

/** A card whose turn has come: chained to the landed root, an agent assigned, in TO DO. */
const releasable = (id: string, over: Partial<Task> = {}): Task =>
  task({ id, agentProjectId: 'agent', ...over });

/** The root plus `cards`, and an arrow from the root into each card that is not a step. */
const board = (...cards: Task[]): { cards: Task[]; links: TaskLink[] } => ({
  cards: [root, ...cards],
  links: cards.filter((c) => !c.parentTaskId).map((c) => link('root', c.id)),
});

const none = new Set<string>();
const sorted = (ids: Set<string>): string[] => [...ids].sort();

describe('readyLanes — the cap', () => {
  it('defaults to three lanes', () => {
    expect(DEFAULT_READY_LANES).toBe(3);
  });

  it('marks only as many cards ready as there are lanes, and queues the rest', () => {
    const { cards, links } = board(...['a', 'b', 'c', 'd', 'e'].map((id) => releasable(id)));
    const plan = readyLanes(cards, links, none, 3);
    expect(plan.ready.size).toBe(3);
    expect(plan.queued.size).toBe(2);
    expect(plan.occupied).toBe(0);
    expect(plan.cap).toBe(3);
  });

  it('makes everything ready when the cap is 0 (unlimited)', () => {
    const { cards, links } = board(...['a', 'b', 'c', 'd', 'e'].map((id) => releasable(id)));
    const plan = readyLanes(cards, links, none, 0);
    expect(sorted(plan.ready)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(plan.queued.size).toBe(0);
  });

  it('gives no lane, and never a negative count, when more are occupied than the cap', () => {
    const { cards, links } = board(
      task({ id: 'r1' }),
      task({ id: 'r2' }),
      task({ id: 'r3' }),
      releasable('a'),
      releasable('b'),
    );
    const plan = readyLanes(cards, links, new Set(['r1', 'r2', 'r3']), 2);
    expect(plan.occupied).toBe(3);
    expect(plan.ready.size).toBe(0);
    expect(sorted(plan.queued)).toEqual(['a', 'b']);
  });
});

describe('readyLanes — running cards count', () => {
  const four = ['a', 'b', 'c', 'd'].map((id) => releasable(id));

  it('counts a card in the live-run set against the cap', () => {
    const { cards, links } = board(releasable('live'), ...four);
    const plan = readyLanes(cards, links, new Set(['live']), 3);
    expect(plan.occupied).toBe(1);
    expect(plan.ready.size).toBe(2);
    expect(plan.queued.size).toBe(2);
    expect(plan.ready.has('live')).toBe(false);
    expect(plan.queued.has('live')).toBe(false);
  });

  it('counts a card wearing status running the same way', () => {
    const { cards, links } = board(
      releasable('live', { status: 'running', preRunStatus: 'pending' }),
      ...four,
    );
    const plan = readyLanes(cards, links, none, 3);
    expect(plan.occupied).toBe(1);
    expect(plan.ready.size).toBe(2);
    expect(plan.ready.has('live')).toBe(false);
  });

  it("counts a running step against its parent's lane, once", () => {
    const { cards, links } = board(
      task({ id: 'parent', status: 'in-progress' }),
      task({ id: 'step1', parentTaskId: 'parent', status: 'running' }),
      task({ id: 'step2', parentTaskId: 'parent' }),
      ...four,
    );
    const plan = readyLanes(cards, links, new Set(['step2']), 3);
    expect(plan.occupied).toBe(1);
    expect(plan.ready.size).toBe(2);
    expect(plan.ready.has('step1')).toBe(false);
    expect(plan.queued.has('step2')).toBe(false);
  });
});

describe('readyLanes — in review', () => {
  const four = ['a', 'b', 'c', 'd'].map((id) => releasable(id));
  const mr = (
    state: MergeRequest['state'],
    taskId: string | null,
    openedForTaskId: string | null,
  ) => ({ state, taskId, openedForTaskId }) as const;

  it('holds a lane while the card has an open PR', () => {
    const { cards, links } = board(task({ id: 'rev', status: 'in-review' }), ...four);
    const prs = openPrTaskIds([mr('opened', null, 'rev')]);
    const plan = readyLanes(cards, links, none, 3, prs);
    expect(plan.occupied).toBe(1);
    expect(plan.ready.size).toBe(2);
  });

  it('frees the lane once the only MR is merged or closed', () => {
    const { cards, links } = board(task({ id: 'rev', status: 'in-review' }), ...four);
    const prs = openPrTaskIds([mr('merged', 'rev', null), mr('closed', null, 'rev')]);
    expect(prs.size).toBe(0);
    const plan = readyLanes(cards, links, none, 3, prs);
    expect(plan.occupied).toBe(0);
    expect(plan.ready.size).toBe(3);
  });

  it('reads both the attributed and the opening card off an open MR', () => {
    expect(sorted(openPrTaskIds([mr('opened', 'x', 'y'), mr('locked', 'z', null)]))).toEqual([
      'x',
      'y',
    ]);
  });
});

describe('readyLanes — order', () => {
  it('gives a lane to the higher priority, whatever the ticket number', () => {
    const { cards, links } = board(
      releasable('low', { ticketKey: 'TM-1', externalPriority: 'Low' }),
      releasable('top', { ticketKey: 'TM-99', externalPriority: 'Highest' }),
    );
    const plan = readyLanes(cards, links, none, 1);
    expect(sorted(plan.ready)).toEqual(['top']);
    expect(sorted(plan.queued)).toEqual(['low']);
  });

  it('breaks a priority tie on the ticket number, numerically', () => {
    const { cards, links } = board(
      releasable('ten', { ticketKey: 'TM-10' }),
      releasable('nine', { ticketKey: 'TM-9' }),
    );
    expect(sorted(readyLanes(cards, links, none, 1).ready)).toEqual(['nine']);
  });

  it('reads the external key when there is no native one', () => {
    const { cards, links } = board(
      releasable('ten', { ticketKey: 'TM-10' }),
      releasable('jira', { externalKey: 'VIP-3' }),
    );
    expect(sorted(readyLanes(cards, links, none, 1).ready)).toEqual(['jira']);
  });

  it('puts a card with no key after every numbered one', () => {
    const cards = [
      releasable('nokey', { order: -5 }),
      releasable('late', { ticketKey: 'TM-500' }),
      releasable('early', { ticketKey: 'TM-2' }),
    ];
    expect([...cards].sort(compareLaneOrder).map((t) => t.id)).toEqual(['early', 'late', 'nokey']);
  });
});

describe('readyLanes — non-candidates', () => {
  it('never marks ready or queued a card waiting on an arrow, an unassigned card, or one awaiting a decision', () => {
    const waiting = releasable('waiting');
    const { cards, links } = board(
      task({ id: 'pred' }),
      waiting,
      task({ id: 'unassigned' }),
      releasable('undecided', { decisionQuestion: 'Which way?' }),
      releasable('ok'),
    );
    links.push(link('pred', 'waiting'));
    const plan = readyLanes(cards, links, none, 0);
    expect(sorted(plan.ready)).toEqual(['ok']);
    expect(plan.queued.size).toBe(0);
  });

  it('never makes an unchained card a candidate', () => {
    const plan = readyLanes([releasable('free')], [], none, 0);
    expect(plan.ready.size).toBe(0);
    expect(plan.queued.size).toBe(0);
  });
});

describe('readyLanesByProject', () => {
  it('gives each project its own lanes and its own cap', () => {
    const { cards, links } = board(
      releasable('a1', { projectId: 'A' }),
      releasable('a2', { projectId: 'A' }),
      releasable('a3', { projectId: 'A' }),
      releasable('b1', { projectId: 'B' }),
      releasable('b2', { projectId: 'B' }),
      task({ id: 'bLive', projectId: 'B' }),
    );
    const caps: Record<string, number> = { A: 1, B: 2 };
    const plans = readyLanesByProject(cards, links, new Set(['bLive']), (id) => caps[id] ?? 3);

    const a = plans.get('A')!;
    expect(a.cap).toBe(1);
    expect(a.occupied).toBe(0);
    expect(a.ready.size).toBe(1);
    expect(a.queued.size).toBe(2);

    const b = plans.get('B')!;
    expect(b.cap).toBe(2);
    expect(b.occupied).toBe(1);
    expect(b.ready.size).toBe(1);
    expect(b.queued.size).toBe(1);
  });

  it('counts a running step against its parent project, wherever the step is filed', () => {
    const { cards, links } = board(
      task({ id: 'parent', projectId: 'A', status: 'in-progress' }),
      task({ id: 'step', projectId: 'B', parentTaskId: 'parent' }),
      releasable('a1', { projectId: 'A' }),
      releasable('b1', { projectId: 'B' }),
    );
    const plans = readyLanesByProject(cards, links, new Set(['step']), () => 1);
    expect(plans.get('A')!.occupied).toBe(1);
    expect(plans.get('A')!.ready.size).toBe(0);
    expect(plans.get('B')!.occupied).toBe(0);
    expect(sorted(plans.get('B')!.ready)).toEqual(['b1']);
  });
});
