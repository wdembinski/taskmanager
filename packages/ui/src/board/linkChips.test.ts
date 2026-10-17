/**
 * `linkChips`'s own rules: which key each predecessor/successor prints, and which of the
 * three tones a `needs` chip picks — the part most likely to be wrong, since it has to agree
 * with `chainArrows.ts`'s `blocked`/`releasing` split without importing it.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { linkChips } from './linkChips';

function link(id: string, fromTaskId: string, toTaskId: string): TaskLink {
  return { id, fromTaskId, toTaskId, gate: 'after-merge', createdAt: 0 };
}

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    type: 'feature',
    status: 'pending',
    projectId: 'p1',
    source: 'internal',
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  } as Task;
}

describe('linkChips', () => {
  it('returns no chips for a card with no links', () => {
    expect(linkChips('a', [], new Map())).toEqual({ needs: [], unblocks: [] });
  });

  it('names a predecessor by its ticket key, falling back to its title', () => {
    const links = [link('ab', 'a', 'b')];
    const withKey = new Map([['a', task('a', { ticketKey: 'TM-1' })]]);
    expect(linkChips('b', links, withKey).needs).toEqual([{ key: 'TM-1', tone: 'waiting' }]);

    const withExternalKey = new Map([['a', task('a', { externalKey: 'PROJ-9' })]]);
    expect(linkChips('b', links, withExternalKey).needs).toEqual([
      { key: 'PROJ-9', tone: 'waiting' },
    ]);

    const withTitleOnly = new Map([['a', task('a')]]);
    expect(linkChips('b', links, withTitleOnly).needs).toEqual([
      { key: 'Task a', tone: 'waiting' },
    ]);
  });

  it('falls back to the raw id for a predecessor the board does not have', () => {
    const links = [link('ab', 'a', 'b')];
    expect(linkChips('b', links, new Map()).needs).toEqual([{ key: 'a', tone: 'waiting' }]);
  });

  it('tones a satisfied predecessor as satisfied, whatever its status', () => {
    const links = [link('ab', 'a', 'b')];
    const tasksById = new Map([['a', task('a', { ticketKey: 'TM-1', landedAt: 123 })]]);
    expect(linkChips('b', links, tasksById).needs).toEqual([{ key: 'TM-1', tone: 'satisfied' }]);
  });

  it('tones an unsatisfied, running predecessor as releasing', () => {
    const links = [link('ab', 'a', 'b')];
    const tasksById = new Map([['a', task('a', { ticketKey: 'TM-1', status: 'running' })]]);
    expect(linkChips('b', links, tasksById).needs).toEqual([{ key: 'TM-1', tone: 'releasing' }]);
  });

  it('tones an unsatisfied predecessor the caller knows is running as releasing too', () => {
    const links = [link('ab', 'a', 'b')];
    const tasksById = new Map([['a', task('a', { ticketKey: 'TM-1', status: 'pending' })]]);
    expect(linkChips('b', links, tasksById, new Set(['a'])).needs).toEqual([
      { key: 'TM-1', tone: 'releasing' },
    ]);
  });

  it('tones an unsatisfied, idle predecessor as waiting', () => {
    const links = [link('ab', 'a', 'b')];
    const tasksById = new Map([['a', task('a', { ticketKey: 'TM-1', status: 'pending' })]]);
    expect(linkChips('b', links, tasksById).needs).toEqual([{ key: 'TM-1', tone: 'waiting' }]);
  });

  it('names successors on unblocks, with no tone of their own', () => {
    const links = [link('ab', 'a', 'b')];
    const tasksById = new Map([['b', task('b', { ticketKey: 'TM-2' })]]);
    expect(linkChips('a', links, tasksById).unblocks).toEqual([{ key: 'TM-2' }]);
  });

  it('answers both directions for a card in the middle of a chain', () => {
    const links = [link('ab', 'a', 'b'), link('bc', 'b', 'c')];
    const tasksById = new Map([
      ['a', task('a', { ticketKey: 'TM-1', landedAt: 1 })],
      ['c', task('c', { ticketKey: 'TM-3' })],
    ]);
    expect(linkChips('b', links, tasksById)).toEqual({
      needs: [{ key: 'TM-1', tone: 'satisfied' }],
      unblocks: [{ key: 'TM-3' }],
    });
  });

  it('names every predecessor and successor of a diamond, each with its own tone', () => {
    // a -> d, b -> d (both feed d); d -> e, d -> f (d releases both)
    const links = [
      link('ad', 'a', 'd'),
      link('bd', 'b', 'd'),
      link('de', 'd', 'e'),
      link('df', 'd', 'f'),
    ];
    const tasksById = new Map([
      ['a', task('a', { ticketKey: 'TM-1', landedAt: 1 })],
      ['b', task('b', { ticketKey: 'TM-2', status: 'running' })],
      ['e', task('e', { ticketKey: 'TM-5' })],
      ['f', task('f', { ticketKey: 'TM-6' })],
    ]);
    const chips = linkChips('d', links, tasksById);
    expect(chips.needs).toEqual([
      { key: 'TM-1', tone: 'satisfied' },
      { key: 'TM-2', tone: 'releasing' },
    ]);
    expect(chips.unblocks).toEqual([{ key: 'TM-5' }, { key: 'TM-6' }]);
  });
});
