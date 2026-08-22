import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import type { BoardTaskState } from '../board/boardSelectors';
import {
  EMPTY_BACKLOG_FILTERS,
  NO_EPIC,
  backlogEpics,
  backlogLabels,
  epicChildren,
  epicProgress,
  filterBacklogTasks,
  matchesBacklogFilters,
  selectBacklogTasks,
} from './backlogSelectors';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    phase: '',
    title: 'A ticket',
    status: 'pending',
    order: 0,
    ...overrides,
  } as Task;
}

function stateOf(...tasks: Task[]): BoardTaskState {
  return { tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) };
}

describe('selectBacklogTasks', () => {
  it('keeps the project’s top-level tickets and drops steps', () => {
    const card = task({ id: 'card', order: 0 });
    const step = task({ id: 'step', order: 1, parentTaskId: 'card' });
    const other = task({ id: 'other', projectId: 'p2' });
    expect(selectBacklogTasks(stateOf(card, step, other), 'p1').map((t) => t.id)).toEqual(['card']);
  });

  it('drops archived rows, like the board itself', () => {
    const archived = task({ id: 'gone', archivedAt: 1 });
    expect(selectBacklogTasks(stateOf(archived), 'p1')).toEqual([]);
  });
});

describe('matchesBacklogFilters', () => {
  it('passes everything against the empty filter set', () => {
    expect(matchesBacklogFilters(task(), EMPTY_BACKLOG_FILTERS)).toBe(true);
  });

  it('filters by status', () => {
    const t = task({ status: 'in-progress' });
    expect(
      matchesBacklogFilters(t, { ...EMPTY_BACKLOG_FILTERS, statuses: new Set(['done']) }),
    ).toBe(false);
    expect(
      matchesBacklogFilters(t, { ...EMPTY_BACKLOG_FILTERS, statuses: new Set(['in-progress']) }),
    ).toBe(true);
  });

  it('filters by label', () => {
    const t = task({ labels: ['backend', 'urgent'] });
    expect(matchesBacklogFilters(t, { ...EMPTY_BACKLOG_FILTERS, label: 'urgent' })).toBe(true);
    expect(matchesBacklogFilters(t, { ...EMPTY_BACKLOG_FILTERS, label: 'frontend' })).toBe(false);
    expect(matchesBacklogFilters(task(), { ...EMPTY_BACKLOG_FILTERS, label: 'urgent' })).toBe(
      false,
    );
  });

  it('filters by epic', () => {
    const t = task({ epicTaskId: 'epic-1' });
    expect(matchesBacklogFilters(t, { ...EMPTY_BACKLOG_FILTERS, epicId: 'epic-1' })).toBe(true);
    expect(matchesBacklogFilters(t, { ...EMPTY_BACKLOG_FILTERS, epicId: 'epic-2' })).toBe(false);
  });

  it('the NO_EPIC sentinel matches only tickets with no epic', () => {
    const withEpic = task({ epicTaskId: 'epic-1' });
    const withoutEpic = task();
    expect(matchesBacklogFilters(withEpic, { ...EMPTY_BACKLOG_FILTERS, epicId: NO_EPIC })).toBe(
      false,
    );
    expect(matchesBacklogFilters(withoutEpic, { ...EMPTY_BACKLOG_FILTERS, epicId: NO_EPIC })).toBe(
      true,
    );
  });
});

describe('filterBacklogTasks', () => {
  it('keeps only the rows matching every active filter', () => {
    const a = task({ id: 'a', status: 'done', labels: ['urgent'] });
    const b = task({ id: 'b', status: 'pending', labels: ['urgent'] });
    const filters = { ...EMPTY_BACKLOG_FILTERS, statuses: new Set(['done']), label: 'urgent' };
    expect(filterBacklogTasks([a, b], filters).map((t) => t.id)).toEqual(['a']);
  });
});

describe('backlogLabels', () => {
  it('collects every distinct label, alphabetically', () => {
    const a = task({ id: 'a', labels: ['zeta', 'alpha'] });
    const b = task({ id: 'b', labels: ['alpha', 'beta'] });
    expect(backlogLabels([a, b])).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('reads a missing labels array as none', () => {
    expect(backlogLabels([task()])).toEqual([]);
  });
});

describe('backlogEpics', () => {
  it('keeps only issueType: epic rows', () => {
    const epic = task({ id: 'e1', issueType: 'epic' });
    const story = task({ id: 's1', issueType: 'story' });
    expect(backlogEpics([epic, story]).map((t) => t.id)).toEqual(['e1']);
  });
});

describe('epicChildren', () => {
  it('keeps rows filed under the epic, excluding an epic even if mis-filed under itself', () => {
    const epic = task({ id: 'e1', issueType: 'epic' });
    const child = task({ id: 'c1', epicTaskId: 'e1' });
    const nestedEpic = task({ id: 'e2', issueType: 'epic', epicTaskId: 'e1' });
    const other = task({ id: 'o1', epicTaskId: 'e2' });
    expect(epicChildren([epic, child, nestedEpic, other], 'e1').map((t) => t.id)).toEqual(['c1']);
  });
});

describe('epicProgress', () => {
  it('counts done against total', () => {
    const children = [
      task({ status: 'done' }),
      task({ status: 'pending' }),
      task({ status: 'done' }),
    ];
    expect(epicProgress(children)).toEqual({ done: 2, total: 3 });
  });

  it('reads no children as 0 of 0', () => {
    expect(epicProgress([])).toEqual({ done: 0, total: 0 });
  });
});
