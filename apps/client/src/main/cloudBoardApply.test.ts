import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import type { MirrorDelta } from '@protocol/wire';
import { applyCloudBoardDelta } from './cloudBoardApply';
import type { Store } from './store';

const task = (over: Partial<Task>): Task => ({
  id: 't1',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'ticket',
  isContract: false,
  isScaffold: false,
  ...over,
});

const project = (over: Partial<Project>): Project =>
  ({
    id: 'p1',
    name: 'Some project',
    kind: 'ticket',
    ...over,
  }) as Project;

function delta(over: Partial<MirrorDelta> = {}): MirrorDelta {
  return { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [], ...over };
}

/** An in-memory `Store` stand-in — only the surface `cloudBoardApply.ts` actually calls. */
function fakeStore(
  seed: { tasks?: Task[]; projects?: Project[]; pending?: Set<string> } = {},
): Store & {
  tasks: Map<string, Task>;
  projects: Map<string, Project>;
} {
  const tasks = new Map((seed.tasks ?? []).map((t) => [t.id, t]));
  const projects = new Map((seed.projects ?? []).map((p) => [p.id, p]));
  const pending = seed.pending ?? new Set<string>();

  return {
    tasks,
    projects,
    getTask: (id: string) => tasks.get(id),
    getProject: (id: string) => projects.get(id),
    hasPendingCloudPush: (entity: 'task' | 'project', id: string) => pending.has(`${entity}:${id}`),
    upsertCloudTask: vi.fn((t: Task) => {
      tasks.set(t.id, t);
    }),
    upsertCloudProject: vi.fn((p: Project) => {
      projects.set(p.id, p);
    }),
    deleteTask: vi.fn((id: string) => {
      tasks.delete(id);
    }),
    removeProject: vi.fn((id: string) => {
      projects.delete(id);
    }),
  } as unknown as Store & { tasks: Map<string, Task>; projects: Map<string, Project> };
}

describe('applyCloudBoardDelta', () => {
  it('inserts a cloud-created ticket that has no local row yet', () => {
    const store = fakeStore();
    const cloudTask = task({ id: 't-new', ticketKey: 'TM-1', ticketNumber: 1 });
    const result = applyCloudBoardDelta(store, delta({ tasks: [cloudTask] }));

    expect(store.tasks.get('t-new')).toEqual(cloudTask);
    expect(result.appliedTaskIds).toEqual(['t-new']);
    expect(result.skippedTaskIds).toEqual([]);
  });

  it('inserts a cloud-created project', () => {
    const store = fakeStore();
    const cloudProject = project({ id: 'p-new', name: 'Cloud project' });
    const result = applyCloudBoardDelta(store, delta({ projects: [cloudProject] }));

    expect(store.projects.get('p-new')).toEqual(cloudProject);
    expect(result.appliedProjectIds).toEqual(['p-new']);
  });

  it('updates an existing local row with the cloud copy', () => {
    const store = fakeStore({ tasks: [task({ id: 't1', title: 'old title' })] });
    const updated = task({ id: 't1', title: 'renamed from the web' });
    applyCloudBoardDelta(store, delta({ tasks: [updated] }));

    expect(store.tasks.get('t1')?.title).toBe('renamed from the web');
  });

  it('does not clobber a task with an unsent local edit', () => {
    const local = task({ id: 't1', title: 'local edit not yet pushed' });
    const store = fakeStore({ tasks: [local], pending: new Set(['task:t1']) });
    const stale = task({ id: 't1', title: 'stale cloud copy' });
    const result = applyCloudBoardDelta(store, delta({ tasks: [stale] }));

    expect(store.tasks.get('t1')?.title).toBe('local edit not yet pushed');
    expect(result.skippedTaskIds).toEqual(['t1']);
    expect(result.appliedTaskIds).toEqual([]);
  });

  it('does not clobber a project with an unsent local edit', () => {
    const local = project({ id: 'p1', name: 'local edit not yet pushed' });
    const store = fakeStore({ projects: [local], pending: new Set(['project:p1']) });
    const stale = project({ id: 'p1', name: 'stale cloud copy' });
    applyCloudBoardDelta(store, delta({ projects: [stale] }));

    expect(store.projects.get('p1')?.name).toBe('local edit not yet pushed');
  });

  it('deletes a task the cloud reports gone', () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })] });
    applyCloudBoardDelta(store, delta({ deletedTaskIds: ['t1'] }));
    expect(store.tasks.has('t1')).toBe(false);
  });

  it('does not delete a task that still has an unsent local edit', () => {
    const store = fakeStore({ tasks: [task({ id: 't1' })], pending: new Set(['task:t1']) });
    applyCloudBoardDelta(store, delta({ deletedTaskIds: ['t1'] }));
    expect(store.tasks.has('t1')).toBe(true);
  });

  it('deletes a project the cloud reports gone', () => {
    const store = fakeStore({ projects: [project({ id: 'p1' })] });
    applyCloudBoardDelta(store, delta({ deletedProjectIds: ['p1'] }));
    expect(store.projects.has('p1')).toBe(false);
  });
});
