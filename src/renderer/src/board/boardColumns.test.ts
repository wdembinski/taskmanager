import { describe, expect, it } from 'vitest';
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import {
  COLUMN_META,
  columnForStatus,
  columnForTask,
  statusForColumn,
  visibleColumns,
} from './boardColumns';

const task = (status: TaskStatus): Task => ({
  id: 't',
  projectId: 'p',
  phase: '',
  title: 'x',
  status,
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
});

describe('columnForStatus', () => {
  const cases: Array<[TaskStatus, BoardColumn]> = [
    ['pending', 'todo'],
    ['in-progress', 'in-progress'],
    ['running', 'in-progress'],
    ['waiting-input', 'in-progress'],
    ['blocked-by-limit', 'in-progress'],
    ['blocked', 'blocked'],
    ['done', 'done'],
    ['failed', 'done'],
    ['stopped', 'done'],
    ['cancelled', 'done'],
  ];

  it.each(cases)('maps %s → %s', (status, column) => {
    expect(columnForStatus(status)).toBe(column);
  });

  it('covers every TaskStatus (no undefined)', () => {
    for (const [status] of cases) {
      expect(columnForStatus(status)).toBeDefined();
    }
    expect(cases).toHaveLength(10);
  });
});

describe('columnForTask', () => {
  it('delegates to the task status', () => {
    expect(columnForTask(task('blocked'))).toBe('blocked');
  });
});

describe('statusForColumn', () => {
  it('round-trips the four columns to a manual status', () => {
    expect(statusForColumn('todo')).toBe('pending');
    expect(statusForColumn('in-progress')).toBe('in-progress');
    expect(statusForColumn('blocked')).toBe('blocked');
    expect(statusForColumn('done')).toBe('done');
  });
});

describe('visibleColumns', () => {
  it('hides Done when the toggle is off', () => {
    expect(visibleColumns(false)).toEqual(['todo', 'in-progress', 'blocked']);
  });
  it('shows all four when on', () => {
    expect(visibleColumns(true)).toEqual(['todo', 'in-progress', 'blocked', 'done']);
  });
  it('column order matches COLUMN_META', () => {
    expect(COLUMN_META.map((c) => c.column)).toEqual(['todo', 'in-progress', 'blocked', 'done']);
  });
});
