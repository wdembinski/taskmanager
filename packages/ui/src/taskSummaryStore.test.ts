import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import type { TaskSummary } from '@tm/shared/taskSummary';
import { applyTaskDelta, deltaFromBoardList, patchTaskSummary } from './taskSummaryStore';

function card(id: string, patch: Partial<Task> = {}): TaskSummary {
  return {
    id,
    projectId: 'p1',
    phase: '',
    title: id,
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'adhoc',
    isContract: false,
    isScaffold: false,
    ...patch,
  };
}

describe('applyTaskDelta', () => {
  const list = [card('a'), card('b')];

  it('replaces an existing card in place', () => {
    const next = applyTaskDelta(
      list,
      { projectId: 'p1', upserted: [card('a', { title: 'A2' })], removed: [] },
      'p1',
    );
    expect(next.map((t) => t.title)).toEqual(['A2', 'b']);
  });

  it('appends a new card', () => {
    const next = applyTaskDelta(
      list,
      { projectId: 'p1', upserted: [card('c')], removed: [] },
      'p1',
    );
    expect(next.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a removed card', () => {
    const next = applyTaskDelta(list, { projectId: 'p1', upserted: [], removed: ['a'] }, 'p1');
    expect(next.map((t) => t.id)).toEqual(['b']);
  });

  it("ignores another board's delta", () => {
    const next = applyTaskDelta(
      list,
      { projectId: 'p2', upserted: [card('c')], removed: ['a'] },
      'p1',
    );
    expect(next).toBe(list);
  });

  it("applies every board's delta on the 'all' scope", () => {
    const next = applyTaskDelta(
      list,
      { projectId: 'p2', upserted: [card('c', { projectId: 'p2' })], removed: ['a'] },
      'all',
    );
    expect(next.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('strips heavy fields from an upserted full row', () => {
    const full = { ...card('a'), agentPlan: 'a long plan' } as Task;
    const [first] = applyTaskDelta(list, { projectId: 'p1', upserted: [full], removed: [] }, 'p1');
    expect(first).not.toHaveProperty('agentPlan');
  });

  it('returns the same reference when nothing changed', () => {
    expect(applyTaskDelta(list, { projectId: 'p1', upserted: [], removed: [] }, 'p1')).toBe(list);
    expect(applyTaskDelta(list, { projectId: 'p1', upserted: [], removed: ['zz'] }, 'p1')).toBe(
      list,
    );
    expect(
      applyTaskDelta(
        list,
        { projectId: 'p1', upserted: [card('a'), card('b')], removed: [] },
        'p1',
      ),
    ).toBe(list);
  });
});

describe('patchTaskSummary', () => {
  const list = [card('a', { dependsOn: ['x'] }), card('b')];

  it('patches a card the list holds', () => {
    const next = patchTaskSummary(list, card('b', { status: 'running' }));
    expect(next[1]!.status).toBe('running');
    expect(next[0]).toBe(list[0]);
  });

  it('ignores a card the list does not hold', () => {
    expect(patchTaskSummary(list, card('c'))).toBe(list);
  });

  it('returns the same reference when nothing changed', () => {
    expect(patchTaskSummary(list, card('a', { dependsOn: ['x'] }))).toBe(list);
  });
});

describe('deltaFromBoardList', () => {
  it('upserts the new list and removes what left that board only', () => {
    const list = [card('a'), card('b'), card('x', { projectId: 'p2' })];
    const delta = deltaFromBoardList(list, 'p1', [card('a', { title: 'A2' }), card('c')]);
    expect(delta.projectId).toBe('p1');
    expect(delta.upserted.map((t) => t.id)).toEqual(['a', 'c']);
    expect(delta.removed).toEqual(['b']);
    const next = applyTaskDelta(list, delta, 'all');
    expect(next.map((t) => [t.id, t.title])).toEqual([
      ['a', 'A2'],
      ['x', 'x'],
      ['c', 'c'],
    ]);
  });

  it('carries summaries, not the heavy fields of a full row', () => {
    const full = { ...card('a'), agentPlan: 'a long plan' } as TaskSummary;
    const delta = deltaFromBoardList([], 'p1', [full]);
    expect(delta.upserted[0]).not.toHaveProperty('agentPlan');
  });
});
