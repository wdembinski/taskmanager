import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import { SEARCH_CARDS_RESULT_LIMIT, searchCards } from './searchCards';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: PERSONAL_PROJECT_ID,
    phase: '',
    title: 'A task',
    status: 'pending',
    order: 0,
    ...overrides,
  } as Task;
}

describe('searchCards', () => {
  it('returns [] for an empty query', () => {
    expect(searchCards([task({ title: 'Fix the login bug' })], '')).toEqual([]);
  });

  it('returns [] for an all-whitespace query', () => {
    expect(searchCards([task({ title: 'Fix the login bug' })], '   ')).toEqual([]);
  });

  it('matches a title substring case-insensitively', () => {
    const t = task({ title: 'Fix the Login bug' });
    expect(searchCards([t], 'login')).toEqual([t]);
  });

  it('matches a ticket key case-insensitively', () => {
    const t = task({ title: 'Something else', ticketKey: 'TM-42' });
    expect(searchCards([t], 'tm-42')).toEqual([t]);
  });

  it('never matches on an absent ticket key', () => {
    const t = task({ title: 'Something else', ticketKey: null });
    expect(searchCards([t], 'tm-42')).toEqual([]);
  });

  it('excludes tasks matching neither field', () => {
    const t = task({ title: 'Unrelated card', ticketKey: 'TM-1' });
    expect(searchCards([t], 'nope')).toEqual([]);
  });

  it('caps results at SEARCH_CARDS_RESULT_LIMIT', () => {
    const tasks = Array.from({ length: SEARCH_CARDS_RESULT_LIMIT + 10 }, (_, i) =>
      task({ id: `t${i}`, title: 'match me' }),
    );
    expect(searchCards(tasks, 'match')).toHaveLength(SEARCH_CARDS_RESULT_LIMIT);
  });
});
