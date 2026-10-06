import { describe, expect, it } from 'vitest';
import { githubLabelsByColumn, nativeStatusesByColumn, statusesByColumn } from './columnStatuses';

describe('statusesByColumn', () => {
  const statuses = [
    { name: 'To Do', category: 'To Do' as const },
    { name: 'In Progress', category: 'In Progress' as const },
    { name: 'In Review', category: 'In Progress' as const },
    { name: 'Done', category: 'Done' as const },
  ];

  it('groups every status by the category-only resolution when nothing overrides it', () => {
    const groups = statusesByColumn(statuses);
    expect(groups.todo).toEqual(['To Do']);
    // "In Progress" has no review-ish name, so it stays by category; "In Review" is caught
    // by the name heuristic even with no map at all.
    expect(groups['in-progress']).toEqual(['In Progress']);
    expect(groups['in-review']).toEqual(['In Review']);
    expect(groups.blocked).toEqual([]);
    expect(groups.done).toEqual(['Done']);
  });

  // The behaviour this helper exists to prove: an explicit override moves a status into
  // IN REVIEW exactly where the board itself would put it, because both read the same
  // `resolveStatusColumn`.
  it('moves a status into IN REVIEW when an explicit override says so', () => {
    const groups = statusesByColumn(statuses, { 'In Progress': 'in-review' });
    expect(groups['in-review']).toEqual(['In Progress', 'In Review']);
    expect(groups['in-progress']).toEqual([]);
  });

  it('is empty in every column for an empty status list', () => {
    const groups = statusesByColumn([]);
    expect(groups).toEqual({ todo: [], 'in-progress': [], 'in-review': [], blocked: [], done: [] });
  });
});

describe('githubLabelsByColumn', () => {
  it('groups labels by the column resolveGitHubColumn would land them in, as if OPEN', () => {
    // resolveGitHubColumn never guesses from a label's own name (see its docstring) — only
    // the user's map or the learned one may move a label off TO DO, so mapped labels are
    // what this groups by.
    const map = {
      'in review': 'in-review' as const,
      blocked: 'blocked' as const,
      wip: 'in-progress' as const,
    };
    const groups = githubLabelsByColumn(['in review', 'blocked', 'wip', 'no-opinion'], map);
    expect(groups['in-review']).toEqual(['in review']);
    expect(groups.blocked).toEqual(['blocked']);
    expect(groups['in-progress']).toEqual(['wip']);
    // An unmapped label falls to the open-issue default, TO DO.
    expect(groups.todo).toEqual(['no-opinion']);
    expect(groups.done).toEqual([]);
  });

  it('is empty in every column for no labels', () => {
    expect(githubLabelsByColumn([])).toEqual({
      todo: [],
      'in-progress': [],
      'in-review': [],
      blocked: [],
      done: [],
    });
  });
});

describe('nativeStatusesByColumn', () => {
  it('buckets the manual statuses by columnForStatus, by default', () => {
    const groups = nativeStatusesByColumn();
    expect(groups.todo).toEqual(['pending']);
    expect(groups['in-progress']).toEqual(['in-progress']);
    expect(groups['in-review']).toEqual(['in-review']);
    expect(groups.blocked).toEqual(['blocked']);
    expect(groups.done).toEqual(['done', 'cancelled']);
  });

  it('also buckets the run-owned statuses when given the full list', () => {
    const groups = nativeStatusesByColumn(['running', 'waiting-input', 'blocked-by-limit']);
    expect(groups['in-progress']).toEqual(['running', 'waiting-input', 'blocked-by-limit']);
  });
});
