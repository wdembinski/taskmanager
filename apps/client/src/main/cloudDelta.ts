/**
 * Pure shaping of the `cloud_outbox` table into a bounded sync batch. Mirrors
 * `taskReconcile`/`jiraSync` in spirit: no DB, no Electron — `store.getCloudDelta`
 * reads the raw rows and hands them here, because the row-per-write log the SQLite
 * triggers append is not yet the batch a `/v1/sync` request wants to send.
 *
 * Ids are never reused (every entity is a fresh `randomUUID`), so once a row for an
 * id is a `delete` no later row for that same id can exist — collapsing to the
 * LAST row per entity is therefore always correct, not just an approximation.
 */

export type CloudEntity = 'task' | 'project';
export type CloudOp = 'insert' | 'update' | 'delete';

export interface CloudOutboxRow {
  seq: number;
  entity: CloudEntity;
  entityId: string;
  op: CloudOp;
  at: number;
}

/**
 * Collapse repeated rows for one entity down to its last write, cap the result to
 * `limit` entities, and order deletes last — so a batch that both creates and
 * removes cards in the same tick applies the creates first.
 *
 * `rows` is assumed ordered by `seq` ascending (what `getCloudDelta`'s query
 * returns); collapsing keeps each entity's LAST occurrence, which is also its
 * highest `seq` — the cap below therefore keeps the entities that made the least
 * progress toward the caller's cursor, so no entity is starved across calls.
 */
export function shapeCloudDelta(
  rows: readonly CloudOutboxRow[],
  limit: number,
): CloudOutboxRow[] {
  const lastByEntity = new Map<string, CloudOutboxRow>();
  for (const row of rows) {
    lastByEntity.set(`${row.entity}:${row.entityId}`, row);
  }

  const bySeq = [...lastByEntity.values()].sort((a, b) => a.seq - b.seq);
  const capped = bySeq.slice(0, Math.max(0, limit));

  const upserts = capped.filter((row) => row.op !== 'delete');
  const deletes = capped.filter((row) => row.op === 'delete');
  return [...upserts, ...deletes];
}
