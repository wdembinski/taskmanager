/**
 * Unit tests for the pure cloud-outbox shaping. No database — just proving the
 * collapse/cap/order rules `getCloudDelta` relies on.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@shared/model';
import {
  buildMirrorDelta,
  buildMirrorDeltaWithin,
  type CloudOutboxRow,
  shapeCloudDelta,
} from './cloudDelta';

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

describe('buildMirrorDeltaWithin', () => {
  /** A task of a known, chunky size, so a byte budget can be expressed in whole cards. */
  function bigTask(id: string, bytes = 1000): Task {
    return { id, title: 'x'.repeat(bytes) } as Task;
  }

  function byId(tasks: Task[]): (id: string) => Task | undefined {
    return (id) => tasks.find((task) => task.id === id);
  }
  const noProject = (): Project | undefined => undefined;

  function taskRows(ids: string[]): CloudOutboxRow[] {
    return ids.map((id, index) => row({ seq: index + 1, entityId: id, op: 'update' }));
  }

  it('stops before the cap, leaving the rest for the next tick', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id) => bigTask(id));
    const { delta, sent } = buildMirrorDeltaWithin(
      taskRows(['a', 'b', 'c', 'd']),
      byId(tasks),
      noProject,
      2500, // two ~1030-byte tasks fit; the third does not
    );

    expect(sent.map((r) => r.entityId)).toEqual(['a', 'b']);
    expect(delta.tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('always sends at least one entity, even one bigger than the whole budget', () => {
    // Skipping it would drop that card from the cloud forever AND block everything behind
    // it in seq order; `cloudPoller` logs the oversize instead.
    const huge = bigTask('huge', 5000);
    const { delta, sent } = buildMirrorDeltaWithin(
      taskRows(['huge', 'next']),
      byId([huge, bigTask('next')]),
      noProject,
      100,
    );

    expect(sent.map((r) => r.entityId)).toEqual(['huge']);
    expect(delta.tasks).toEqual([huge]);
  });

  it('takes everything when the batch fits', () => {
    const tasks = ['a', 'b'].map((id) => bigTask(id, 10));
    const { sent } = buildMirrorDeltaWithin(taskRows(['a', 'b']), byId(tasks), noProject);
    expect(sent).toHaveLength(2);
  });

  it('returns an empty batch for an empty outbox', () => {
    const result = buildMirrorDeltaWithin([], byId([]), noProject);
    expect(result.sent).toEqual([]);
    expect(result.delta).toEqual({
      tasks: [],
      projects: [],
      deletedTaskIds: [],
      deletedProjectIds: [],
    });
  });

  it('cuts in seq order, not in the deletes-last order shapeCloudDelta hands over', () => {
    // The trap this exists for: `shapeCloudDelta` puts the delete last, so a naive prefix
    // would send [b, c] and prune through seq 3 — silently discarding the seq-1 delete,
    // which then never reaches the cloud at all.
    const shaped = shapeCloudDelta(
      [
        row({ seq: 1, entityId: 'gone', op: 'delete' }),
        row({ seq: 2, entityId: 'b', op: 'update' }),
        row({ seq: 3, entityId: 'c', op: 'update' }),
      ],
      10,
    );
    expect(shaped.map((r) => r.entityId)).toEqual(['b', 'c', 'gone']); // deletes last, as given

    const { sent } = buildMirrorDeltaWithin(
      shaped,
      byId([bigTask('b'), bigTask('c')]),
      noProject,
      1500, // room for the tiny delete plus one task
    );

    expect(sent.map((r) => r.entityId)).toEqual(['b', 'gone']);
  });

  it('orders deletes last within the taken set', () => {
    const { sent, delta } = buildMirrorDeltaWithin(
      [
        row({ seq: 1, entityId: 'del', op: 'delete' }),
        row({ seq: 2, entityId: 'keep', op: 'update' }),
      ],
      byId([bigTask('keep', 10)]),
      noProject,
    );

    expect(sent.map((r) => r.entityId)).toEqual(['keep', 'del']);
    expect(delta.tasks.map((t) => t.id)).toEqual(['keep']);
    expect(delta.deletedTaskIds).toEqual(['del']);
  });

  it('never prunes past a row it sent: every unsent row has a higher seq', () => {
    // This is the invariant `cloudPoller.pruneCloudOutbox(max(sent.seq))` rests on.
    const rows = shapeCloudDelta(
      [
        row({ seq: 1, entityId: 'a', op: 'update' }),
        row({ seq: 2, entityId: 'del', op: 'delete' }),
        row({ seq: 3, entityId: 'c', op: 'update' }),
        row({ seq: 4, entityId: 'd', op: 'update' }),
      ],
      10,
    );
    const { sent } = buildMirrorDeltaWithin(
      rows,
      byId(['a', 'c', 'd'].map((id) => bigTask(id))),
      noProject,
      1500,
    );

    const sentIds = new Set(sent.map((r) => r.entityId));
    const pruneThrough = Math.max(...sent.map((r) => r.seq));
    const unsent = rows.filter((r) => !sentIds.has(r.entityId));
    expect(unsent.length).toBeGreaterThan(0);
    for (const pending of unsent) expect(pending.seq).toBeGreaterThan(pruneThrough);
  });

  it('folds a lookup miss into a delete, and counts it as the id it becomes', () => {
    const { delta, sent } = buildMirrorDeltaWithin(
      taskRows(['vanished', 'b']),
      byId([bigTask('b')]),
      noProject,
      1200,
    );

    // The miss costs a few bytes, not a task's worth, so `b` still fits behind it.
    expect(sent.map((r) => r.entityId)).toEqual(['vanished', 'b']);
    expect(delta.deletedTaskIds).toEqual(['vanished']);
    expect(delta.tasks.map((t) => t.id)).toEqual(['b']);
  });
});
