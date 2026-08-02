import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  awaitingMerge,
  blockedBy,
  canLink,
  chainComponent,
  incomingLinks,
  isLinkGate,
  linkSatisfied,
  outgoingLinks,
  predecessorsOf,
  readyToRelease,
  readyToReleaseGiven,
  successorsOf,
  wouldCycle,
  type LinkGate,
  type TaskLink,
} from './taskChain';

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

/** `a → b`, i.e. b runs after a. Ids double as the link id, so failures read plainly. */
const link = (from: string, to: string, gate: LinkGate = 'after-merge'): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate,
  createdAt: 0,
});

const index = (...tasks: Task[]): Map<string, Task> => new Map(tasks.map((t) => [t.id, t]));

describe('gates', () => {
  it('accepts only the two known gate names', () => {
    expect(isLinkGate('after-merge')).toBe(true);
    expect(isLinkGate('stacked')).toBe(true);
    expect(isLinkGate('whenever')).toBe(false);
    expect(isLinkGate(null)).toBe(false);
  });
});

describe('neighbours', () => {
  const links = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')];

  it('separates what a card waits on from what waits on it', () => {
    expect(predecessorsOf(links, 'd')).toEqual(['b', 'c']);
    expect(successorsOf(links, 'a')).toEqual(['b', 'c']);
    expect(predecessorsOf(links, 'a')).toEqual([]);
    expect(successorsOf(links, 'd')).toEqual([]);
  });

  it('hands back the links themselves, gate included', () => {
    expect(incomingLinks(links, 'b').map((l) => l.id)).toEqual(['a->b']);
    expect(outgoingLinks(links, 'b').map((l) => l.id)).toEqual(['b->d']);
  });
});

describe('wouldCycle', () => {
  it('refuses a card waiting for itself', () => {
    expect(wouldCycle([], 'a', 'a')).toBe(true);
  });

  it('allows a fresh edge between unrelated cards', () => {
    expect(wouldCycle([link('a', 'b')], 'c', 'd')).toBe(false);
  });

  it('refuses the edge that closes a two-card loop', () => {
    expect(wouldCycle([link('a', 'b')], 'b', 'a')).toBe(true);
  });

  it('refuses a loop closed several hops away', () => {
    const links = [link('a', 'b'), link('b', 'c'), link('c', 'd')];
    expect(wouldCycle(links, 'd', 'a')).toBe(true);
    expect(wouldCycle(links, 'd', 'b')).toBe(true);
  });

  it('allows a diamond — two paths to the same card are not a loop', () => {
    const links = [link('a', 'b'), link('a', 'c'), link('b', 'd')];
    expect(wouldCycle(links, 'c', 'd')).toBe(false);
  });

  it('terminates on a graph that already contains a loop', () => {
    const links = [link('a', 'b'), link('b', 'a')];
    expect(wouldCycle(links, 'b', 'c')).toBe(false);
  });
});

describe('canLink', () => {
  const a = task({ id: 'a' });
  const b = task({ id: 'b' });
  const step = task({ id: 's', parentTaskId: 'a' });

  it('allows an ordinary new arrow', () => {
    expect(canLink([], a, b)).toBeNull();
  });

  it('refuses an unknown card at either end', () => {
    expect(canLink([], undefined, b)).toBe('missing');
    expect(canLink([], a, undefined)).toBe('missing');
  });

  it('refuses a self-link', () => {
    expect(canLink([], a, a)).toBe('self');
  });

  it('refuses a step at either end — its order is its chain already', () => {
    expect(canLink([], step, b)).toBe('step');
    expect(canLink([], a, step)).toBe('step');
  });

  it('refuses drawing the same arrow twice', () => {
    expect(canLink([link('a', 'b')], a, b)).toBe('duplicate');
  });

  it('refuses the reverse arrow as a cycle, not as a duplicate', () => {
    expect(canLink([link('a', 'b')], b, a)).toBe('cycle');
  });
});

describe('chainComponent', () => {
  it('is just the card itself when nothing is linked to it', () => {
    expect([...chainComponent([link('a', 'b')], 'z')]).toEqual(['z']);
  });

  it('walks both directions, so focusing any card shows the whole chain', () => {
    const links = [link('a', 'b'), link('b', 'c'), link('a', 'd')];
    for (const id of ['a', 'b', 'c', 'd']) {
      expect([...chainComponent(links, id)].sort()).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('leaves a separate chain out', () => {
    const links = [link('a', 'b'), link('x', 'y')];
    expect([...chainComponent(links, 'a')].sort()).toEqual(['a', 'b']);
  });
});

describe('linkSatisfied — after-merge', () => {
  const gate = link('a', 'b', 'after-merge');

  it('waits until the predecessor has landed, whatever column it is in', () => {
    expect(linkSatisfied(gate, task({ id: 'a', status: 'done' }))).toBe(false);
    expect(linkSatisfied(gate, task({ id: 'a', status: 'done', landedAt: 1 }))).toBe(true);
  });

  it('stays satisfied after the card is dragged back out of Done', () => {
    expect(linkSatisfied(gate, task({ id: 'a', status: 'in-progress', landedAt: 1 }))).toBe(true);
  });

  it('is not satisfied by a predecessor that no longer exists', () => {
    expect(linkSatisfied(gate, undefined)).toBe(false);
  });
});

describe('linkSatisfied — stacked', () => {
  const gate = link('a', 'b', 'stacked');

  it('never releases while a run is still in flight', () => {
    for (const status of ['running', 'waiting-input', 'blocked-by-limit'] as const) {
      const running = task({ id: 'a', status, preRunStatus: 'done', agentBranch: 'chain/a' });
      expect(linkSatisfied(gate, running)).toBe(false);
    }
  });

  it('releases once the work is written, without waiting for the merge', () => {
    expect(linkSatisfied(gate, task({ id: 'a', status: 'in-review' }))).toBe(true);
    expect(linkSatisfied(gate, task({ id: 'a', status: 'done' }))).toBe(true);
  });

  it('releases on a stopped run that left a branch behind', () => {
    const stopped = task({ id: 'a', status: 'stopped', sessionId: 's1', agentBranch: 'chain/a' });
    expect(linkSatisfied(gate, stopped)).toBe(true);
  });

  it('holds a card that has a branch but has never run', () => {
    expect(linkSatisfied(gate, task({ id: 'a', agentBranch: 'chain/a' }))).toBe(false);
  });

  it('holds a card that is merely sitting in To Do', () => {
    expect(linkSatisfied(gate, task({ id: 'a' }))).toBe(false);
  });
});

describe('readyToRelease', () => {
  const b = task({ id: 'b' });

  it('is vacuously true for an unchained card', () => {
    expect(readyToRelease(b, [], index(b))).toBe(true);
  });

  it('waits for its one predecessor', () => {
    const links = [link('a', 'b')];
    expect(readyToRelease(b, links, index(task({ id: 'a' }), b))).toBe(false);
    expect(readyToRelease(b, links, index(task({ id: 'a', landedAt: 5 }), b))).toBe(true);
  });

  it('AND-joins a diamond: both sides must land', () => {
    const d = task({ id: 'd' });
    const links = [link('b', 'd'), link('c', 'd')];
    const landed = task({ id: 'b', landedAt: 1 });
    expect(readyToRelease(d, links, index(landed, task({ id: 'c' }), d))).toBe(false);
    expect(readyToRelease(d, links, index(landed, task({ id: 'c', landedAt: 2 }), d))).toBe(true);
  });

  it('judges each incoming link by its own gate', () => {
    const d = task({ id: 'd' });
    const links = [link('b', 'd', 'after-merge'), link('c', 'd', 'stacked')];
    const byId = index(task({ id: 'b', landedAt: 1 }), task({ id: 'c', status: 'in-review' }), d);
    expect(readyToRelease(d, links, byId)).toBe(true);
  });

  it('keeps waiting when a predecessor has gone missing', () => {
    expect(readyToRelease(b, [link('a', 'b')], index(b))).toBe(false);
  });
});

describe('readyToReleaseGiven', () => {
  it('takes the named predecessor as satisfied however the board looks', () => {
    const b = task({ id: 'b' });
    // Mid-settle: the run has ended, but the card's status has not been written yet, so
    // asking `linkSatisfied` about it would answer "still running".
    const a = task({ id: 'a', status: 'running' });
    const links = [link('a', 'b', 'stacked')];
    expect(readyToRelease(b, links, index(a, b))).toBe(false);
    expect(readyToReleaseGiven(b, links, index(a, b), 'a')).toBe(true);
  });

  it('judges every OTHER arm of a diamond normally', () => {
    const d = task({ id: 'd' });
    const links = [link('a', 'd', 'stacked'), link('c', 'd')];
    const a = task({ id: 'a', status: 'running' });
    expect(readyToReleaseGiven(d, links, index(a, task({ id: 'c' }), d), 'a')).toBe(false);
    expect(readyToReleaseGiven(d, links, index(a, task({ id: 'c', landedAt: 2 }), d), 'a')).toBe(
      true,
    );
  });

  it('asserts nothing for null — exactly readyToRelease', () => {
    const b = task({ id: 'b' });
    const links = [link('a', 'b')];
    expect(readyToReleaseGiven(b, links, index(task({ id: 'a' }), b), null)).toBe(false);
  });
});

describe('blockedBy', () => {
  it('names only the predecessors that are still holding the card', () => {
    const d = task({ id: 'd' });
    const b = task({ id: 'b', title: 'API', landedAt: 1 });
    const c = task({ id: 'c', title: 'schema' });
    const waiting = blockedBy(d, [link('b', 'd'), link('c', 'd')], index(b, c, d));
    expect(waiting.map((t) => t.title)).toEqual(['schema']);
  });

  it('is empty exactly when the card is ready', () => {
    const d = task({ id: 'd' });
    const links = [link('b', 'd')];
    const byId = index(task({ id: 'b', landedAt: 1 }), d);
    expect(blockedBy(d, links, byId)).toEqual([]);
    expect(readyToRelease(d, links, byId)).toBe(true);
  });
});

describe('awaitingMerge', () => {
  const b = task({ id: 'b' });

  it('names a predecessor whose work is written but not landed', () => {
    const written = task({ id: 'a', status: 'in-review' });
    expect(awaitingMerge(b, [link('a', 'b')], index(written, b)).map((t) => t.id)).toEqual(['a']);
  });

  it('is empty once it has landed — there is nothing left to press', () => {
    const landed = task({ id: 'a', status: 'in-review', landedAt: 7 });
    expect(awaitingMerge(b, [link('a', 'b')], index(landed, b))).toEqual([]);
  });

  it('is empty for a stacked link, whose gate never wanted a merge', () => {
    const written = task({ id: 'a', status: 'in-review' });
    expect(awaitingMerge(b, [link('a', 'b', 'stacked')], index(written, b))).toEqual([]);
  });

  it('is empty while the predecessor is still running — nobody can merge that yet', () => {
    const running = task({ id: 'a', status: 'running' });
    expect(awaitingMerge(b, [link('a', 'b')], index(running, b))).toEqual([]);
  });

  it('names a run that stopped part-way but left a branch behind', () => {
    // `linkSatisfied`'s escape hatch, asserted deliberately: a card that failed or was
    // stopped mid-run is NOT in-review, yet it has run and it has a branch — so a `stacked`
    // gate would release on it, and the chip says the merge is what stands in the way.
    const halfDone = task({ id: 'a', status: 'failed', sessionId: 's1', agentBranch: 'task/a' });
    expect(awaitingMerge(b, [link('a', 'b')], index(halfDone, b)).map((t) => t.id)).toEqual(['a']);
  });

  it('names the same card blockedBy does — the chip is a lie if they disagree', () => {
    const d = task({ id: 'd' });
    const landed = task({ id: 'a', status: 'done', landedAt: 3 });
    const written = task({ id: 'c', status: 'in-review' });
    const links = [link('a', 'd'), link('c', 'd')];
    const byId = index(landed, written, d);
    expect(blockedBy(d, links, byId).map((t) => t.id)).toEqual(['c']);
    expect(awaitingMerge(d, links, byId).map((t) => t.id)).toEqual(['c']);
  });
});
