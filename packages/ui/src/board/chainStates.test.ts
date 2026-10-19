import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { chainStates } from './chainStates';

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

/** `a → b`: b runs after a, once a's branch has landed. */
const link = (from: string, to: string): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate: 'after-merge',
  createdAt: 0,
});

const index = (...tasks: Task[]): Map<string, Task> => new Map(tasks.map((t) => [t.id, t]));

/** The predecessor of every case below, merged and out of the way. */
const landed = task({ id: 'a', status: 'done', landedAt: 7, agentProjectId: 'repo' });

describe('chainStates', () => {
  it('says nothing about a card nobody chained', () => {
    const b = task({ id: 'b' });
    expect(chainStates([], index(b)).get('b')).toBeUndefined();
  });

  it('names what a card is still waiting on, and asks nothing else while it waits', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', agentProjectId: 'repo' });
    const state = chainStates([link('a', 'b')], index(a, b)).get('b');
    expect(state?.waitingOn.map((t) => t.id)).toEqual(['a']);
    expect(state?.ready).toBe(false);
    // Its arrows are the answer; a second complaint about the card itself would be noise.
    expect(state?.blocked).toBeNull();
  });

  it('separates a predecessor that has finished from one that has not started', () => {
    const written = task({ id: 'a', status: 'in-review' });
    const b = task({ id: 'b', agentProjectId: 'repo' });
    const state = chainStates([link('a', 'b')], index(written, b)).get('b');
    expect(state?.mergeHeld.map((t) => t.id)).toEqual(['a']);
  });

  it('is ready once its predecessor has landed and it has an agent', () => {
    const b = task({ id: 'b', agentProjectId: 'repo' });
    const state = chainStates([link('a', 'b')], index(landed, b)).get('b');
    expect(state).toMatchObject({ waitingOn: [], ready: true, blocked: null });
  });

  /**
   * The reported bug, as a test. The card was created through *Runs after…*, which draws
   * the arrow and never asks who does the work — so the chain reached it, declined, and the
   * board went silent: no `waitingOn` (satisfied) and, with the old predicate, no `ready`
   * either. The card sat in In Progress looking exactly like an idle one.
   */
  it('reports an unassigned card as blocked rather than saying nothing at all', () => {
    const b = task({ id: 'b', status: 'in-progress' });
    const state = chainStates([link('a', 'b')], index(landed, b)).get('b');
    expect(state).toMatchObject({ waitingOn: [], ready: false, blocked: 'no-agent' });
  });

  it('calls a card resting in In Progress ready — the engine starts one, so the chip must', () => {
    const b = task({ id: 'b', status: 'in-progress', agentProjectId: 'repo' });
    expect(chainStates([link('a', 'b')], index(landed, b)).get('b')?.ready).toBe(true);
  });

  it('calls a card that has only been PLANNED ready — a session is not work', () => {
    const b = task({ id: 'b', agentProjectId: 'repo', sessionId: 's1' });
    expect(chainStates([link('a', 'b')], index(landed, b)).get('b')?.ready).toBe(true);
  });

  it('reports a Blocked card as held, not as ready', () => {
    const b = task({ id: 'b', status: 'blocked', agentProjectId: 'repo' });
    const state = chainStates([link('a', 'b')], index(landed, b)).get('b');
    expect(state).toMatchObject({ ready: false, blocked: 'resting' });
  });

  it('never calls a card waiting on a decision ready, however satisfied its arrows', () => {
    const b = task({ id: 'b', agentProjectId: 'repo', decisionQuestion: 'Which plan?' });
    const state = chainStates([link('a', 'b')], index(landed, b)).get('b');
    expect(state).toMatchObject({ waitingOn: [], ready: false, blocked: 'needs-decision' });
  });

  it('leaves an unflagged card exactly as it was', () => {
    const b = task({ id: 'b', agentProjectId: 'repo', decisionQuestion: null });
    const state = chainStates([link('a', 'b')], index(landed, b)).get('b');
    expect(state).toMatchObject({ waitingOn: [], ready: true, blocked: null });
  });

  it('is quiet about a card whose own work is done or under way', () => {
    const done = task({ id: 'b', status: 'done', agentProjectId: 'repo' });
    expect(chainStates([link('a', 'b')], index(landed, done)).get('b')).toMatchObject({
      ready: false,
      blocked: 'settled',
    });
    const running = task({ id: 'b', agentProjectId: 'repo' });
    expect(
      chainStates([link('a', 'b')], index(landed, running), new Set(['b'])).get('b'),
    ).toMatchObject({ ready: false, blocked: 'in-flight' });
  });

  it('waits for BOTH arms of a diamond before asking about the card at all', () => {
    const unstarted = task({ id: 'c' });
    const d = task({ id: 'd' });
    const state = chainStates([link('a', 'd'), link('c', 'd')], index(landed, unstarted, d)).get(
      'd',
    );
    expect(state?.waitingOn.map((t) => t.id)).toEqual(['c']);
    expect(state?.blocked).toBeNull();
  });

  it('skips a link whose target the board no longer holds', () => {
    expect(chainStates([link('a', 'gone')], index(landed)).size).toBe(0);
  });

  it('queues nothing when the board passes no lane inputs', () => {
    const b = task({ id: 'b', agentProjectId: 'repo' });
    expect(chainStates([link('a', 'b')], index(landed, b)).get('b')?.queued).toBe(false);
  });
});

describe('chainStates with ready lanes', () => {
  /** Five satisfied successors of `landed`, most urgent first. */
  const five = ['High', 'High', 'Medium', 'Medium', 'Low'].map((p, i) =>
    task({
      id: `l${i + 1}`,
      agentProjectId: 'repo',
      externalPriority: p,
      ticketKey: `FX-${i + 1}`,
    }),
  );
  const links = five.map((t) => link('a', t.id));
  const lanes = (cards: Task[], cap = 3) => ({
    capOf: () => cap,
    openPrTaskIds: new Set<string>(),
    cards,
  });

  it('marks the first three ready and queues the other two at cap 3', () => {
    const cards = [landed, ...five];
    const states = chainStates(links, index(...cards), new Set(), lanes(cards));
    const ready = five.filter((t) => states.get(t.id)?.ready).map((t) => t.id);
    const queued = five.filter((t) => states.get(t.id)?.queued).map((t) => t.id);
    expect(ready).toEqual(['l1', 'l2', 'l3']);
    expect(queued).toEqual(['l4', 'l5']);
    // A queued card is not blocked: the engine would start it, there is just no lane.
    expect(states.get('l4')?.blocked).toBeNull();
  });

  it('counts a running card against the cap', () => {
    const busy = task({ id: 'busy', agentProjectId: 'repo' });
    const cards = [landed, busy, ...five];
    const states = chainStates(links, index(...cards), new Set(['busy']), lanes(cards));
    expect(five.filter((t) => states.get(t.id)?.ready).map((t) => t.id)).toEqual(['l1', 'l2']);
    expect(five.filter((t) => states.get(t.id)?.queued).map((t) => t.id)).toEqual([
      'l3',
      'l4',
      'l5',
    ]);
  });

  it('queues nothing at cap 0', () => {
    const cards = [landed, ...five];
    const states = chainStates(links, index(...cards), new Set(), lanes(cards, 0));
    expect(five.every((t) => states.get(t.id)?.ready && !states.get(t.id)?.queued)).toBe(true);
  });
});
