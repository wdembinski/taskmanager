import { describe, expect, it } from 'vitest';
import { MAPPABLE_COLUMNS, rowsToStatusMap, statusMapToRows } from './statusMap';

describe('statusMapToRows', () => {
  it('is empty for an absent map', () => {
    expect(statusMapToRows(undefined)).toEqual([]);
  });

  it('keeps the stored order', () => {
    expect(statusMapToRows({ 'Code Review': 'in-review', Backlog: 'todo' })).toEqual([
      { name: 'Code Review', column: 'in-review' },
      { name: 'Backlog', column: 'todo' },
    ]);
  });
});

describe('rowsToStatusMap', () => {
  it('drops rows the user has added but not named yet', () => {
    expect(
      rowsToStatusMap([
        { name: '', column: 'in-review' },
        { name: '   ', column: 'todo' },
      ]),
    ).toEqual({});
  });

  it('trims the name', () => {
    expect(rowsToStatusMap([{ name: '  Code Review  ', column: 'in-review' }])).toEqual({
      'Code Review': 'in-review',
    });
  });

  it('lets the last row win on a duplicate, whatever its spelling', () => {
    expect(
      rowsToStatusMap([
        { name: 'Code Review', column: 'todo' },
        { name: 'CODE REVIEW', column: 'in-review' },
      ]),
    ).toEqual({ 'CODE REVIEW': 'in-review' });
  });

  it('round-trips a map unchanged', () => {
    const map = { 'Code Review': 'in-review' as const, Backlog: 'todo' as const };
    expect(rowsToStatusMap(statusMapToRows(map))).toEqual(map);
  });
});

describe('MAPPABLE_COLUMNS', () => {
  // Blocked is internal-only: a JIRA status mapped onto it would produce cards the
  // next sync could not explain, so it must never be offered.
  it('offers every column except blocked', () => {
    expect(MAPPABLE_COLUMNS).toEqual(['todo', 'in-progress', 'in-review', 'done']);
  });
});
