/**
 * Unit tests for the pure task reconciliation. No database — just proving that
 * re-parsing a plan preserves live status and re-orders correctly.
 */
import { describe, expect, it } from 'vitest';
import { reconcileTasks } from './taskReconcile';
import type { Task } from '@shared/model';

/** Build a stored task with sensible defaults for the fields under test. */
function task(partial: Partial<Task> & Pick<Task, 'phase' | 'title'>): Task {
  return {
    id: `id-${partial.title}`,
    projectId: 'proj',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'plan',
    dependsOn: [],
    ...partial,
  };
}

// Deterministic id generator for newly created tasks.
function idSeq(): () => string {
  let n = 0;
  return () => `new-${n++}`;
}

describe('reconcileTasks', () => {
  it('creates tasks for a first-time sync, using done-state from the plan', () => {
    const result = reconcileTasks(
      'proj',
      [],
      [
        { phase: 'P1', title: 'a', done: true, needs: [] },
        { phase: 'P1', title: 'b', done: false, needs: [] },
      ],
      idSeq(),
    );
    expect(result).toEqual([
      {
        id: 'new-0',
        projectId: 'proj',
        phase: 'P1',
        title: 'a',
        status: 'done',
        sessionId: null,
        order: 0,
        source: 'plan',
        dependsOn: [],
      },
      {
        id: 'new-1',
        projectId: 'proj',
        phase: 'P1',
        title: 'b',
        status: 'pending',
        sessionId: null,
        order: 1,
        source: 'plan',
        dependsOn: [],
      },
    ]);
  });

  it('preserves id, live status, and sessionId for matched tasks', () => {
    const existing = [
      task({
        phase: 'P1',
        title: 'a',
        id: 'keep',
        status: 'running',
        sessionId: 'sess-1',
        order: 0,
      }),
    ];
    const result = reconcileTasks(
      'proj',
      existing,
      [{ phase: 'P1', title: 'a', done: false, needs: [] }],
      idSeq(),
    );
    expect(result[0]).toMatchObject({ id: 'keep', status: 'running', sessionId: 'sess-1' });
  });

  it('does NOT let a plan checkbox override live status of an existing task', () => {
    // Task is running; plan marks it [x]. We keep 'running', not 'done'.
    const existing = [task({ phase: 'P', title: 'x', status: 'running' })];
    const result = reconcileTasks('proj', existing, [{ phase: 'P', title: 'x', done: true, needs: [] }]);
    expect(result[0].status).toBe('running');
  });

  it('refreshes order to match the plan even when a task moves', () => {
    const existing = [
      task({ phase: 'P', title: 'a', order: 0 }),
      task({ phase: 'P', title: 'b', order: 1 }),
    ];
    // Plan swaps their order.
    const result = reconcileTasks('proj', existing, [
      { phase: 'P', title: 'b', done: false, needs: [] },
      { phase: 'P', title: 'a', done: false, needs: [] },
    ]);
    expect(result.map((t) => [t.title, t.order])).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
  });

  it('drops resting plan tasks that no longer appear in the plan', () => {
    const existing = [task({ phase: 'P', title: 'stays' }), task({ phase: 'P', title: 'removed' })];
    const result = reconcileTasks('proj', existing, [{ phase: 'P', title: 'stays', done: false, needs: [] }]);
    expect(result.map((t) => t.title)).toEqual(['stays']);
  });

  it('keeps a mid-flight plan task even if the agent removed its line from the plan', () => {
    // The agent edited the plan during a run; the running task must not be dropped.
    const existing = [
      task({ phase: 'P', title: 'stays' }),
      task({ phase: 'P', title: 'running-one', status: 'running', sessionId: 's1' }),
    ];
    const result = reconcileTasks('proj', existing, [{ phase: 'P', title: 'stays', done: false, needs: [] }]);
    expect(result.map((t) => t.title)).toEqual(['stays', 'running-one']);
    expect(result[1]).toMatchObject({ status: 'running', sessionId: 's1' });
  });

  it('keeps a plan task the user is working (in-progress/blocked) if its line is removed', () => {
    const existing = [
      task({ phase: 'P', title: 'stays' }),
      task({ phase: 'P', title: 'in-flight', status: 'in-progress' }),
      task({ phase: 'P', title: 'stuck', status: 'blocked' }),
      task({ phase: 'P', title: 'gone', status: 'cancelled' }), // resting → dropped
    ];
    const result = reconcileTasks('proj', existing, [{ phase: 'P', title: 'stays', done: false, needs: [] }]);
    expect(result.map((t) => t.title)).toEqual(['stays', 'in-flight', 'stuck']);
  });

  it('never drops ad-hoc tasks — they are outside the plan', () => {
    const existing = [
      task({ phase: 'P', title: 'planned' }),
      task({ phase: 'Extra', title: 'added in app', source: 'adhoc', status: 'done' }),
    ];
    const result = reconcileTasks('proj', existing, [{ phase: 'P', title: 'planned', done: false, needs: [] }]);
    // Ad-hoc task survives the sync and is appended after the plan tasks.
    expect(result.map((t) => t.title)).toEqual(['planned', 'added in app']);
    expect(result[1]).toMatchObject({ source: 'adhoc', status: 'done', order: 1 });
  });

  it('carries @needs dependencies onto tasks and refreshes them on re-sync', () => {
    // First sync: 'b' declares a dependency on 'a'.
    const first = reconcileTasks('proj', [], [
      { phase: 'P', title: 'a', done: false, needs: [] },
      { phase: 'P', title: 'b', done: false, needs: ['a'] },
    ]);
    expect(first[0].dependsOn).toEqual([]);
    expect(first[1].dependsOn).toEqual(['a']);

    // Re-sync with an edited @needs clause: the matched task picks up the change.
    const second = reconcileTasks('proj', first, [
      { phase: 'P', title: 'a', done: false, needs: [] },
      { phase: 'P', title: 'b', done: false, needs: ['a', 'c'] },
    ]);
    expect(second[1].id).toBe(first[1].id); // matched, not recreated
    expect(second[1].dependsOn).toEqual(['a', 'c']);
  });

  it('treats same title under different phases as distinct tasks', () => {
    const existing = [task({ phase: 'P1', title: 'a', id: 'p1a', sessionId: 's1' })];
    const result = reconcileTasks(
      'proj',
      existing,
      [
        { phase: 'P1', title: 'a', done: false, needs: [] },
        { phase: 'P2', title: 'a', done: false, needs: [] },
      ],
      idSeq(),
    );
    expect(result[0]).toMatchObject({ id: 'p1a', sessionId: 's1' });
    expect(result[1]).toMatchObject({ id: 'new-0', phase: 'P2', sessionId: null });
  });
});
