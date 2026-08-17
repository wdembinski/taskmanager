import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import { selectArchivedTasks, selectBoardTasks, type BoardTaskState } from './boardSelectors';

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

function stateOf(...tasks: Task[]): BoardTaskState {
  return { tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) };
}

/** One board holding every kind of row the mirror can carry. */
const live = task({ id: 'live', order: 1 });
const archived = task({ id: 'archived', order: 0, archivedAt: 5_000 });
const otherProject = task({ id: 'other', projectId: 'p2', order: 0 });
const step = task({ id: 'step', parentTaskId: 'live', order: 0 });
const board = stateOf(live, archived, otherProject, step);

describe('selectBoardTasks', () => {
  it('keeps only the un-archived Personal rows', () => {
    expect(selectBoardTasks(board).map((t) => t.id)).toEqual(['step', 'live']);
  });

  it('keeps a step, which groupSubtasks needs to hang under its parent', () => {
    expect(selectBoardTasks(board).some((t) => t.id === 'step')).toBe(true);
  });

  it('sorts by order', () => {
    const state = stateOf(task({ id: 'c', order: 2 }), task({ id: 'a', order: 0 }));
    expect(selectBoardTasks(state).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('treats a missing archivedAt as not archived', () => {
    const state = stateOf(task({ id: 'undef', archivedAt: undefined }));
    expect(selectBoardTasks(state).map((t) => t.id)).toEqual(['undef']);
  });
});

describe('selectArchivedTasks', () => {
  it('keeps only the archived Personal rows', () => {
    expect(selectArchivedTasks(board).map((t) => t.id)).toEqual(['archived']);
  });

  it('ignores another project, archived or not', () => {
    const state = stateOf(
      task({ id: 'otherArchived', projectId: 'p2', archivedAt: 1 }),
      otherProject,
    );
    expect(selectArchivedTasks(state)).toEqual([]);
    expect(selectBoardTasks(state)).toEqual([]);
  });

  it('sorts most recently archived first, then by order', () => {
    const state = stateOf(
      task({ id: 'old', archivedAt: 1_000, order: 0 }),
      task({ id: 'new', archivedAt: 9_000, order: 3 }),
      task({ id: 'newAlso', archivedAt: 9_000, order: 1 }),
    );
    expect(selectArchivedTasks(state).map((t) => t.id)).toEqual(['newAlso', 'new', 'old']);
  });
});

// Phase 24: a board scoped to a native ticket project reads the SAME two selectors, with an
// explicit `projectId` instead of the default.
describe('scoping to a ticket project', () => {
  it('selectBoardTasks reads the named project instead of Personal', () => {
    expect(selectBoardTasks(board, 'p2').map((t) => t.id)).toEqual(['other']);
  });

  it('selectArchivedTasks reads the named project instead of Personal', () => {
    const state = stateOf(
      otherProject,
      task({ id: 'otherArchived', projectId: 'p2', archivedAt: 1 }),
    );
    expect(selectArchivedTasks(state, 'p2').map((t) => t.id)).toEqual(['otherArchived']);
  });

  it('an explicit Personal id behaves exactly like the default', () => {
    expect(selectBoardTasks(board, PERSONAL_PROJECT_ID)).toEqual(selectBoardTasks(board));
  });
});
