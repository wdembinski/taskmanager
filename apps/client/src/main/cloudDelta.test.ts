/**
 * Unit tests for the pure cloud-outbox shaping. No database — just proving the
 * collapse/cap/order rules `getCloudDelta` relies on.
 */
import { describe, expect, it } from 'vitest';
import { type CloudOutboxRow, shapeCloudDelta } from './cloudDelta';

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
      [
        row({ seq: 1, op: 'insert' }),
        row({ seq: 2, op: 'update' }),
        row({ seq: 3, op: 'update' }),
      ],
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
      [row({ seq: 1, entityId: 'a' }), row({ seq: 2, entityId: 'b' }), row({ seq: 3, entityId: 'c' })],
      2,
    );
    expect(result.map((r) => r.entityId)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty outbox', () => {
    expect(shapeCloudDelta([], 10)).toEqual([]);
  });
});
