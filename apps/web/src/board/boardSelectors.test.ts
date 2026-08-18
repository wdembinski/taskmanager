import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@tm/shared/model';
import {
  selectAgentProjects,
  selectArchivedTasks,
  selectBoardTasks,
  type BoardTaskState,
} from './boardSelectors';

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

// Phase 24: a board scoped to a native ticket project reads the SAME two selectors, with an
// explicit `projectId` instead of the default.
describe('scoping to a ticket project', () => {
  it('selectBoardTasks reads the named project instead of Personal', () => {
    expect(selectBoardTasks(board, 'p2').map((t) => t.id)).toEqual(['other']);
  });

  it('selectArchivedTasks reads the named project instead of Personal', () => {
    const state = stateOf([
      otherProject,
      task({ id: 'otherArchived', projectId: 'p2', archivedAt: 1 }),
    ]);
    expect(selectArchivedTasks(state, 'p2').map((t) => t.id)).toEqual(['otherArchived']);
  });
});

/** The mirror's own shape — `CloudBoardState.projects` is keyed by id, not a list. */
function mirrorOf(...projects: Project[]): Record<string, Project> {
  return Object.fromEntries(projects.map((p) => [p.id, p]));
}

describe('selectAgentProjects', () => {
  const mirroredAgent = project({ id: 'm1', name: 'Mirrored', path: '/repos/m1' });
  const personalBoard = project({
    id: 'personal',
    name: 'Personal',
    path: '/repos/personal',
    planPath: '/repos/personal/plan.md',
  });
  const mirror = mirrorOf(mirroredAgent, personalBoard);

  it('falls back to the mirrored rows while the relay has not answered', () => {
    expect(selectAgentProjects(mirror, [], false).map((p) => p.id)).toEqual(['m1']);
  });

  it('lets the relay win once it has answered', () => {
    const relayed = [project({ id: 'r1', name: 'Relayed', path: '/repos/r1' })];
    expect(selectAgentProjects(mirror, relayed, true).map((p) => p.id)).toEqual(['r1']);
  });

  it('answers nothing for an answered-but-empty relay, rather than the mirror', () => {
    // The whole point of the flag: an account whose desktop really has no agent projects must
    // show none. Reading emptiness as "nobody was home" would resurrect every deleted repo.
    expect(selectAgentProjects(mirror, [], true)).toEqual([]);
  });

  it('keeps only a repo with no plan file, on both branches', () => {
    const ticketProject = project({ id: 'tk', name: 'Tickets', path: '' });
    const planProject = project({
      id: 'pl',
      name: 'Legacy',
      path: '/repos/pl',
      planPath: '/repos/pl/plan.md',
    });
    const agent = project({ id: 'ag', name: 'Repo', path: '/repos/ag' });

    expect(
      selectAgentProjects(mirrorOf(ticketProject, planProject, agent), [], false).map((p) => p.id),
    ).toEqual(['ag']);
    expect(
      selectAgentProjects({}, [ticketProject, planProject, agent], true).map((p) => p.id),
    ).toEqual(['ag']);
  });

  it('orders by name either way round, so the relay replacing the mirror does not reshuffle', () => {
    const alpha = project({ id: 'z', name: 'Alpha', path: '/repos/z' });
    const zulu = project({ id: 'a', name: 'Zulu', path: '/repos/a' });
    expect(selectAgentProjects(mirrorOf(zulu, alpha), [], false).map((p) => p.name)).toEqual([
      'Alpha',
      'Zulu',
    ]);
    expect(selectAgentProjects({}, [zulu, alpha], true).map((p) => p.name)).toEqual([
      'Alpha',
      'Zulu',
    ]);
  });

  it('breaks a name tie by id, so two repos of the same name keep one order', () => {
    const first = project({ id: 'b', name: 'Same', path: '/repos/b' });
    const second = project({ id: 'a', name: 'Same', path: '/repos/a' });
    expect(selectAgentProjects({}, [first, second], true).map((p) => p.id)).toEqual(['a', 'b']);
    expect(selectAgentProjects(mirrorOf(first, second), [], false).map((p) => p.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('does not sort the relayed array in place', () => {
    // It is `useBoardExtras`'s state: sorting the caller's array would mutate React state
    // held elsewhere, which is the kind of thing that only shows up as a stale render.
    const relayed = [
      project({ id: 'z', name: 'Zulu', path: '/repos/z' }),
      project({ id: 'a', name: 'Alpha', path: '/repos/a' }),
    ];
    selectAgentProjects({}, relayed, true);
    expect(relayed.map((p) => p.name)).toEqual(['Zulu', 'Alpha']);
  });
});
