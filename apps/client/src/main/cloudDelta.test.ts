/**
 * Unit tests for the pure cloud-outbox shaping. No database — just proving the
 * collapse/cap/order rules `getCloudDelta` relies on.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@shared/model';
import { buildMirrorDelta, type CloudOutboxRow, shapeCloudDelta } from './cloudDelta';

function row(partial: Partial<CloudOutboxRow> & Pick<CloudOutboxRow, 'seq'>): CloudOutboxRow {
  return {
    entity: 'task',
    entityId: 't1',
    op: 'update',
    at: partial.seq,
    ...partial,
  };
}

describe('shapeCloudDelta', () => {
  it('collapses repeated rows for one entity to its last write', () => {
    const result = shapeCloudDelta(
      [row({ seq: 1, op: 'insert' }), row({ seq: 2, op: 'update' }), row({ seq: 3, op: 'update' })],
      10,
    );
    expect(result).toEqual([row({ seq: 3, op: 'update' })]);
  });

  it('collapses insert-then-delete to a single delete row', () => {
    const result = shapeCloudDelta(
      [row({ seq: 1, op: 'insert' }), row({ seq: 2, op: 'delete' })],
      10,
    );
    expect(result).toEqual([row({ seq: 2, op: 'delete' })]);
  });

  it('keeps distinct entities and distinct kinds of entity separate', () => {
    const result = shapeCloudDelta(
      [
        row({ seq: 1, entity: 'task', entityId: 't1', op: 'insert' }),
        row({ seq: 2, entity: 'project', entityId: 't1', op: 'insert' }),
        row({ seq: 3, entity: 'task', entityId: 't2', op: 'insert' }),
      ],
      10,
    );
    expect(result).toHaveLength(3);
  });

  it('orders deletes after inserts/updates, even when they sort earlier by seq', () => {
    const result = shapeCloudDelta(
      [
        row({ seq: 1, entityId: 'del-me', op: 'delete' }),
        row({ seq: 2, entityId: 'keep-me', op: 'update' }),
      ],
      10,
    );
    expect(result.map((r) => r.entityId)).toEqual(['keep-me', 'del-me']);
  });

  it('caps the batch to the least-progressed entities, preserving seq order', () => {
    const result = shapeCloudDelta(
      [
        row({ seq: 1, entityId: 'a' }),
        row({ seq: 2, entityId: 'b' }),
        row({ seq: 3, entityId: 'c' }),
      ],
      2,
    );
    expect(result.map((r) => r.entityId)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty outbox', () => {
    expect(shapeCloudDelta([], 10)).toEqual([]);
  });
});

describe('buildMirrorDelta', () => {
  const t1 = { id: 't1', title: 'Fix export' } as Task;
  const p1 = { id: 'p1', name: 'Widgets' } as Project;
  const getTask = (id: string): Task | undefined => (id === 't1' ? t1 : undefined);
  const getProject = (id: string): Project | undefined => (id === 'p1' ? p1 : undefined);

  it('resolves an insert/update row to the entity the lookup returns', () => {
    const result = buildMirrorDelta(
      [row({ seq: 1, entity: 'task', entityId: 't1', op: 'update' })],
      getTask,
      getProject,
    );
    expect(result).toEqual({
      tasks: [t1],
      projects: [],
      deletedTaskIds: [],
      deletedProjectIds: [],
    });
  });

  it('sends a delete row as an id, with no lookup', () => {
    const result = buildMirrorDelta(
      [row({ seq: 1, entity: 'project', entityId: 'gone', op: 'delete' })],
      getTask,
      getProject,
    );
    expect(result).toEqual({
      tasks: [],
      projects: [],
      deletedTaskIds: [],
      deletedProjectIds: ['gone'],
    });
  });

  it('folds an insert/update lookup MISS into a delete — the entity is gone either way', () => {
    const result = buildMirrorDelta(
      [row({ seq: 1, entity: 'task', entityId: 'vanished', op: 'insert' })],
      getTask,
      getProject,
    );
    expect(result).toEqual({
      tasks: [],
      projects: [],
      deletedTaskIds: ['vanished'],
      deletedProjectIds: [],
    });
  });

  it('sorts tasks and projects into their own arrays from one mixed batch', () => {
    const result = buildMirrorDelta(
      [
        row({ seq: 1, entity: 'task', entityId: 't1', op: 'insert' }),
        row({ seq: 2, entity: 'project', entityId: 'p1', op: 'insert' }),
      ],
      getTask,
      getProject,
    );
    expect(result).toEqual({
      tasks: [t1],
      projects: [p1],
      deletedTaskIds: [],
      deletedProjectIds: [],
    });
  });
});
