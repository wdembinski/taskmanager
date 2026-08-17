import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@tm/shared/model';
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

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'A project',
    path: '',
    planPath: '',
    color: '',
    ...overrides,
  } as Project;
}

function stateOf(tasks: Task[], projects: Project[] = []): BoardTaskState {
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
  };
}

/** One board holding every kind of row the mirror can carry. */
const live = task({ id: 'live', order: 1 });
const archived = task({ id: 'archived', order: 0, archivedAt: 5_000 });
const otherProject = task({ id: 'other', projectId: 'p2', order: 0 });
const step = task({ id: 'step', parentTaskId: 'live', order: 0 });
const board = stateOf([live, archived, otherProject, step]);

describe('selectBoardTasks', () => {
  it('keeps only the un-archived Personal rows on the Personal scope', () => {
    expect(selectBoardTasks(board, PERSONAL_PROJECT_ID).map((t) => t.id)).toEqual(['step', 'live']);
  });

  it('keeps a step, which groupSubtasks needs to hang under its parent', () => {
    expect(selectBoardTasks(board, PERSONAL_PROJECT_ID).some((t) => t.id === 'step')).toBe(true);
  });

  it('sorts by order', () => {
    const state = stateOf([task({ id: 'c', order: 2 }), task({ id: 'a', order: 0 })]);
    expect(selectBoardTasks(state, PERSONAL_PROJECT_ID).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('treats a missing archivedAt as not archived', () => {
    const state = stateOf([task({ id: 'undef', archivedAt: undefined })]);
    expect(selectBoardTasks(state, PERSONAL_PROJECT_ID).map((t) => t.id)).toEqual(['undef']);
  });

  it('narrows to one project’s own rows when the scope names it', () => {
    const state = stateOf([live, otherProject]);
    expect(selectBoardTasks(state, 'p2').map((t) => t.id)).toEqual(['other']);
  });

  describe('the "all" scope', () => {
    it('unions Personal with every other project that has no plan file', () => {
      const ticketProject = project({ id: 'p2', planPath: '' });
      const planProject = project({ id: 'p3', planPath: '/repo/plan.md' });
      const state = stateOf(
        [
          live,
          task({ id: 'ticketCard', projectId: 'p2', order: 0 }),
          task({ id: 'queueCard', projectId: 'p3', order: 0 }),
        ],
        [ticketProject, planProject],
      );
      // Personal and the ticket project's cards are both boards; the plan-driven project's
      // queue is not — `isBoardProject` is the same rule `store.ts`'s union read uses.
      expect(
        selectBoardTasks(state, 'all')
          .map((t) => t.id)
          .sort(),
      ).toEqual(['live', 'ticketCard']);
    });

    it('falls back to Personal for a project not yet mirrored', () => {
      // `p2` has no row in `state.projects` yet (a mirror lag), so its task cannot be told
      // apart from a plan-driven project's — excluded, same as any project this state has
      // never heard of.
      const state = stateOf([live, otherProject]);
      expect(selectBoardTasks(state, 'all').map((t) => t.id)).toEqual(['live']);
    });
  });
});

describe('selectArchivedTasks', () => {
  it('keeps only the archived Personal rows on the Personal scope', () => {
    expect(selectArchivedTasks(board, PERSONAL_PROJECT_ID).map((t) => t.id)).toEqual(['archived']);
  });

  it('ignores another project, archived or not, on the Personal scope', () => {
    const state = stateOf([
      task({ id: 'otherArchived', projectId: 'p2', archivedAt: 1 }),
      otherProject,
    ]);
    expect(selectArchivedTasks(state, PERSONAL_PROJECT_ID)).toEqual([]);
    expect(selectBoardTasks(state, PERSONAL_PROJECT_ID)).toEqual([]);
  });

  it('sorts most recently archived first, then by order', () => {
    const state = stateOf([
      task({ id: 'old', archivedAt: 1_000, order: 0 }),
      task({ id: 'new', archivedAt: 9_000, order: 3 }),
      task({ id: 'newAlso', archivedAt: 9_000, order: 1 }),
    ]);
    expect(selectArchivedTasks(state, PERSONAL_PROJECT_ID).map((t) => t.id)).toEqual([
      'newAlso',
      'new',
      'old',
    ]);
  });

  it('unions archived rows across every board project on the "all" scope', () => {
    const ticketProject = project({ id: 'p2', planPath: '' });
    const state = stateOf(
      [
        task({ id: 'personalGone', archivedAt: 1_000 }),
        task({ id: 'ticketGone', projectId: 'p2', archivedAt: 2_000 }),
      ],
      [ticketProject],
    );
    expect(selectArchivedTasks(state, 'all').map((t) => t.id)).toEqual([
      'ticketGone',
      'personalGone',
    ]);
  });
});
