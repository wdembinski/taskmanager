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

  it('gives one wait reason per holding arrow, naming a Done card that never landed', () => {
    const a = task({ id: 'a', title: 'Sign-off', externalKey: 'TM-7', status: 'done' });
    const c = task({ id: 'c', title: 'Write the API', status: 'in-review' });
    const b = task({ id: 'b', agentProjectId: 'repo' });
    const state = chainStates([link('a', 'b'), link('c', 'b')], index(a, b, c)).get('b');
    expect(state?.waitReasons).toEqual([
      'Waits for TM-7 to merge (Done, not landed)',
      'Waits for Write the API to merge (In Review)',
    ]);
  });

  it('has no wait reasons once every arrow is satisfied', () => {
    const b = task({ id: 'b', agentProjectId: 'repo' });
    expect(chainStates([link('a', 'b')], index(landed, b)).get('b')?.waitReasons).toEqual([]);
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

describe('chainStates with file holds', () => {
  const lanes = (cards: Task[], openPrs: string[] = []) => ({
    capOf: () => 3,
    openPrTaskIds: new Set(openPrs),
    cards,
  });
  const running = task({
    id: 'f1',
    ticketKey: 'FX-f1',
    agentProjectId: 'repo',
    plannedFiles: ['packages/ui/src/board/taskcard.tsx'],
  });

  it('holds an unchained To Do card whose files a running card touches, naming it', () => {
    const waiting = task({ id: 'f2', plannedFiles: ['packages/ui/src/board/*.tsx'] });
    const cards = [running, waiting];
    const states = chainStates([], index(...cards), new Set(['f1']), lanes(cards));
    expect(states.get('f2')).toMatchObject({
      waitingOn: [],
      ready: false,
      queued: false,
      blocked: null,
      fileHold: { byTaskId: 'f1', byKey: 'FX-f1', files: ['packages/ui/src/board/*.tsx'] },
    });
    // The running card holds the files — it waits for nothing.
    expect(states.get('f1')).toBeUndefined();
  });

  it('takes a held chain candidate out of ready and out of the lanes', () => {
    const waiting = task({
      id: 'f2',
      agentProjectId: 'repo',
      plannedFiles: ['packages/ui/src/board/taskcard.tsx'],
    });
    const cards = [landed, running, waiting];
    const states = chainStates([link('a', 'f2')], index(...cards), new Set(['f1']), lanes(cards));
    expect(states.get('f2')).toMatchObject({
      ready: false,
      queued: false,
      fileHold: { byTaskId: 'f1', byKey: 'FX-f1' },
    });
  });

  it('holds the second of two overlapping candidates for the first', () => {
    const first = task({
      id: 'c1',
      ticketKey: 'FX-1',
      agentProjectId: 'repo',
      plannedFiles: ['apps/client/src/main/store.ts'],
    });
    const second = task({
      id: 'c2',
      ticketKey: 'FX-2',
      agentProjectId: 'repo',
      plannedFiles: ['apps/client/src/main/*.ts'],
    });
    const cards = [landed, first, second];
    const links = [link('a', 'c1'), link('a', 'c2')];
    const states = chainStates(links, index(...cards), new Set(), lanes(cards));
    expect(states.get('c1')).toMatchObject({ ready: true });
    expect(states.get('c1')?.fileHold).toBeUndefined();
    expect(states.get('c2')).toMatchObject({ ready: false, fileHold: { byKey: 'FX-1' } });
  });

  it('counts a review with an open PR as holding its files', () => {
    const review = { ...running, status: 'in-review' as const };
    const waiting = task({ id: 'f2', plannedFiles: ['packages/ui/src/board/taskcard.tsx'] });
    const cards = [review, waiting];
    expect(chainStates([], index(...cards), new Set(), lanes(cards)).get('f2')).toBeUndefined();
    expect(
      chainStates([], index(...cards), new Set(), lanes(cards, ['f1'])).get('f2')?.fileHold,
    ).toMatchObject({ byTaskId: 'f1' });
  });

  it('leaves a card outside To Do, or in another project, unheld', () => {
    const later = task({
      id: 'f2',
      status: 'in-progress',
      plannedFiles: ['packages/ui/src/board/taskcard.tsx'],
    });
    const elsewhere = task({
      id: 'f3',
      projectId: 'other',
      plannedFiles: ['packages/ui/src/board/taskcard.tsx'],
    });
    const cards = [running, later, elsewhere];
    const states = chainStates([], index(...cards), new Set(['f1']), lanes(cards));
    expect(states.get('f2')).toBeUndefined();
    expect(states.get('f3')).toBeUndefined();
  });
});
