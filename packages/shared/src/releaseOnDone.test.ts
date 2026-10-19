import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  heldSuccessors,
  releasableByHand,
  releaseDefault,
  releasePrompt,
  type ReleaseMr,
} from './releaseOnDone';
import type { LinkGate, TaskLink } from './taskChain';

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

const link = (from: string, to: string, gate: LinkGate = 'after-merge'): TaskLink => ({
  id: `${from}->${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate,
  createdAt: 0,
});

const index = (...tasks: Task[]): Map<string, Task> => new Map(tasks.map((t) => [t.id, t]));

const mr = (state: ReleaseMr['state'], over: Partial<ReleaseMr> = {}): ReleaseMr => ({
  taskId: 'a',
  openedForTaskId: null,
  state,
  ...over,
});

describe('heldSuccessors', () => {
  it('keeps after-merge targets that are still open, in link order', () => {
    const b = task({ id: 'b' });
    const c = task({ id: 'c', status: 'done' });
    const d = task({ id: 'd', status: 'cancelled' });
    const e = task({ id: 'e', status: 'in-review' });
    const f = task({ id: 'f' });
    const links = [
      link('a', 'b'),
      link('a', 'c'),
      link('a', 'd'),
      link('a', 'e'),
      link('a', 'f', 'stacked'),
      link('x', 'b'),
    ];
    expect(heldSuccessors({ id: 'a' }, links, index(b, c, d, e, f)).map((t) => t.id)).toEqual([
      'b',
      'e',
    ]);
  });
});

describe('releaseDefault', () => {
  it('releases a branchless card', () => {
    expect(releaseDefault(task({ id: 'a' }), [])).toBe('release');
  });

  it('releases a card whose MR merged, even one filed only by the button', () => {
    const worked = task({ id: 'a', agentProjectId: 'repo', workedAt: 1 });
    expect(releaseDefault(worked, [mr('merged')])).toBe('release');
    expect(releaseDefault(worked, [mr('merged', { taskId: null, openedForTaskId: 'a' })])).toBe(
      'release',
    );
  });

  it('keeps waiting on an open MR', () => {
    expect(releaseDefault(task({ id: 'a' }), [mr('opened')])).toBe('keep');
  });

  it('keeps waiting on a branch with no MR', () => {
    expect(releaseDefault(task({ id: 'a', agentProjectId: 'repo', workedAt: 1 }), [])).toBe('keep');
  });

  it('ignores an MR filed under another card', () => {
    expect(releaseDefault(task({ id: 'a' }), [mr('opened', { taskId: 'z' })])).toBe('release');
  });
});

describe('releasePrompt', () => {
  const before = task({ id: 'a', status: 'in-review' });
  const after = task({ id: 'a', status: 'done' });
  const b = task({ id: 'b' });
  const base = {
    origin: 'human' as const,
    before,
    after,
    links: [link('a', 'b')],
    byId: index(after, b),
    mergeRequests: [] as ReleaseMr[],
  };

  it('asks a human who moved a branchless card into Done, leading with release', () => {
    const prompt = releasePrompt(base);
    expect(prompt?.targets.map((t) => t.id)).toEqual(['b']);
    expect(prompt?.defaultChoice).toBe('release');
  });

  it('leads with keep when an MR is still open', () => {
    expect(releasePrompt({ ...base, mergeRequests: [mr('opened')] })?.defaultChoice).toBe('keep');
  });

  it('does not ask when no arrow leaves the card', () => {
    expect(releasePrompt({ ...base, links: [] })).toBeNull();
  });

  it('does not ask when every successor is already Done', () => {
    const doneB = task({ id: 'b', status: 'done' });
    expect(releasePrompt({ ...base, byId: index(after, doneB) })).toBeNull();
  });

  it('does not ask about a card that has already landed', () => {
    expect(releasePrompt({ ...base, after: { ...after, landedAt: 10 } })).toBeNull();
  });

  it('does not ask when a sync moved the card', () => {
    expect(releasePrompt({ ...base, origin: 'sync' })).toBeNull();
  });

  it('does not ask unless the move goes into Done', () => {
    expect(releasePrompt({ ...base, after: { ...after, status: 'in-review' } })).toBeNull();
    expect(releasePrompt({ ...base, before: { ...before, status: 'done' } })).toBeNull();
    expect(releasePrompt({ ...base, before: { ...before, status: 'failed' } })).toBeNull();
  });
});

describe('releasableByHand', () => {
  const b = task({ id: 'b' });

  it('offers the held cards of a Done card that has not landed', () => {
    const a = task({ id: 'a', status: 'done' });
    expect(releasableByHand(a, [link('a', 'b')], index(a, b)).map((t) => t.id)).toEqual(['b']);
  });

  it('offers nothing once landed, or before Done', () => {
    const landed = task({ id: 'a', status: 'done', landedAt: 3 });
    const open = task({ id: 'a', status: 'in-review' });
    expect(releasableByHand(landed, [link('a', 'b')], index(landed, b))).toEqual([]);
    expect(releasableByHand(open, [link('a', 'b')], index(open, b))).toEqual([]);
  });
});
