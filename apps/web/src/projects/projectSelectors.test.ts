import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@tm/shared/model';
import {
  projectStats,
  selectHubProjects,
  type HubProjectState,
  type HubTaskState,
} from './projectSelectors';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Widgets',
    path: '',
    planPath: '',
    kind: 'ticket',
    ticketPrefix: 'WID',
    createdAt: 0,
    ...overrides,
  } as Project;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    phase: '',
    title: 'A task',
    status: 'pending',
    order: 0,
    ...overrides,
  } as Task;
}

describe('selectHubProjects', () => {
  it('excludes the Personal board', () => {
    const state: HubProjectState = {
      projects: {
        [PERSONAL_PROJECT_ID]: project({ id: PERSONAL_PROJECT_ID, name: 'Personal' }),
        p1: project({ id: 'p1' }),
      },
    };
    expect(selectHubProjects(state).map((p) => p.id)).toEqual(['p1']);
  });

  it('sorts alphabetically by name', () => {
    const state: HubProjectState = {
      projects: {
        b: project({ id: 'b', name: 'Beta' }),
        a: project({ id: 'a', name: 'Alpha' }),
      },
    };
    expect(selectHubProjects(state).map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('projectStats', () => {
  it('counts un-archived tickets filed in the project', () => {
    const state: HubTaskState = {
      tasks: {
        t1: task({ id: 't1' }),
        t2: task({ id: 't2' }),
        archived: task({ id: 'archived', archivedAt: 5 }),
        other: task({ id: 'other', projectId: 'p2' }),
      },
    };
    expect(projectStats(state, 'p1').ticketCount).toBe(2);
  });

  it('counts cards delegated here, separately from the ticket count', () => {
    const state: HubTaskState = {
      tasks: {
        assigned: task({ id: 'assigned', projectId: 'other', agentProjectId: 'p1' }),
      },
    };
    const stats = projectStats(state, 'p1');
    expect(stats.assignedCount).toBe(1);
    expect(stats.ticketCount).toBe(0);
  });

  it('is null when nothing has happened yet', () => {
    const state: HubTaskState = { tasks: { t1: task() } };
    expect(projectStats(state, 'p1').lastActivityAt).toBeNull();
  });

  it('reads the later of workedAt and statusNoteAt, across every ticket', () => {
    const state: HubTaskState = {
      tasks: {
        t1: task({ id: 't1', workedAt: 100, statusNoteAt: 50 }),
        t2: task({ id: 't2', workedAt: 20, statusNoteAt: 200 }),
      },
    };
    expect(projectStats(state, 'p1').lastActivityAt).toBe(200);
  });
});
