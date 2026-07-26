import { describe, expect, it } from 'vitest';
import type { BoardColumn, Task, TaskStatus } from '@shared/model';
import {
  COLUMN_META,
  columnForStatus,
  columnForTask,
  groupSubtasks,
  hasLiveSubtask,
  statusForColumn,
  stepPosition,
  subtaskProgress,
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

/** A card/step with an explicit id, order, parent and status, for the grouping tests. */
const card = (id: string, overrides: Partial<Task> = {}): Task => ({
  ...task('pending'),
  id,
  title: id,
  ...overrides,
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

describe('groupSubtasks', () => {
  it('leaves an ordinary board untouched, each card with no steps', () => {
    const cards = groupSubtasks([card('a'), card('b')]);
    expect(cards.map((c) => c.task.id)).toEqual(['a', 'b']);
    expect(cards.every((c) => c.subtasks.length === 0)).toBe(true);
  });

  it('attaches steps to their parent and drops them from the top level', () => {
    const cards = groupSubtasks([
      card('parent'),
      card('s2', { parentTaskId: 'parent', order: 1 }),
      card('other'),
      card('s1', { parentTaskId: 'parent', order: 0 }),
    ]);
    expect(cards.map((c) => c.task.id)).toEqual(['parent', 'other']);
    expect(cards[0].subtasks.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(cards[1].subtasks).toEqual([]);
  });

  it('keeps a step with its parent whatever its own status', () => {
    const cards = groupSubtasks([
      card('parent', { status: 'in-progress' }),
      card('s1', { parentTaskId: 'parent', order: 0, status: 'done' }),
      card('s2', { parentTaskId: 'parent', order: 1, status: 'failed' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].subtasks.map((s) => s.status)).toEqual(['done', 'failed']);
  });

  it('preserves the input order of the top-level cards', () => {
    const cards = groupSubtasks([card('b'), card('a'), card('c')]);
    expect(cards.map((c) => c.task.id)).toEqual(['b', 'a', 'c']);
  });

  it('promotes an orphaned step rather than hiding it', () => {
    // The parent is on another board (or was deleted): the step still needs to be
    // reachable, so it renders as a card of its own.
    const cards = groupSubtasks([card('orphan', { parentTaskId: 'gone' })]);
    expect(cards.map((c) => c.task.id)).toEqual(['orphan']);
  });

  it('handles an empty board', () => {
    expect(groupSubtasks([])).toEqual([]);
  });
});

describe('subtaskProgress', () => {
  it('counts only steps that actually landed', () => {
    const steps = [
      card('s1', { status: 'done' }),
      card('s2', { status: 'failed' }),
      card('s3', { status: 'running' }),
      card('s4', { status: 'pending' }),
    ];
    expect(subtaskProgress(steps)).toEqual({ done: 1, total: 4 });
  });

  it('is 0/0 for a card with no steps', () => {
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe('hasLiveSubtask', () => {
  it('is true while a step runs or waits on the human', () => {
    expect(
      hasLiveSubtask([card('s1', { status: 'done' }), card('s2', { status: 'running' })]),
    ).toBe(true);
    expect(hasLiveSubtask([card('s1', { status: 'waiting-input' })])).toBe(true);
  });

  it('is false for a finished, failed or not-yet-started chain', () => {
    expect(hasLiveSubtask([])).toBe(false);
    expect(
      hasLiveSubtask([card('s1', { status: 'done' }), card('s2', { status: 'pending' })]),
    ).toBe(false);
    expect(hasLiveSubtask([card('s1', { status: 'failed' })])).toBe(false);
  });
});

describe('stepPosition', () => {
  const steps = [card('s1'), card('s2'), card('s3')];

  it('numbers a step from 1 among its siblings', () => {
    expect(stepPosition(steps, 's1')).toBe(1);
    expect(stepPosition(steps, 's3')).toBe(3);
  });

  it('is null for a task that is not one of the steps', () => {
    expect(stepPosition(steps, 'parent')).toBeNull();
    expect(stepPosition([], 's1')).toBeNull();
  });
});
