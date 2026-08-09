/**
 * Pure shaping of the `cloud_outbox` table into a bounded sync batch. Mirrors
 * `taskReconcile`/`jiraSync` in spirit: no DB, no Electron — `store.getCloudDelta`
 * reads the raw rows and hands them here, because the row-per-write log the SQLite
 * triggers append is not yet the batch a `/v1/sync` request wants to send.
 *
 * Ids are never reused (every entity is a fresh `randomUUID`), so once a row for an
 * id is a `delete` no later row for that same id can exist — collapsing to the
 * LAST row per entity is therefore always correct, not just an approximation.
 *
 * `buildMirrorDelta` is the one further step `shapeCloudDelta`'s own docstring names
 * but doesn't take: turning a shaped ROW (entity + id + op) into the actual `Task`/
 * `Project` `@tm/protocol/wire`'s `MirrorDelta` wants, via lookup callbacks rather than
 * a `Store` — `cloudPoller.ts` is the only caller, and it already has `store.getTask`/
 * `store.getProject` to pass in directly.
 */
import type { MirrorDelta } from '@protocol/wire';
import type { Project, Task } from '@shared/model';

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
export function shapeCloudDelta(rows: readonly CloudOutboxRow[], limit: number): CloudOutboxRow[] {
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

/**
 * Resolve a shaped outbox batch into the full-entity batch `POST /v1/sync` wants: an
 * insert/update row is looked up by id and sent as the real row the caller's own copy
 * currently holds; a delete row needs no lookup — the id IS the message. A lookup MISS on
 * an insert/update (the entity was deleted again since the outbox row was written, and the
 * later delete hasn't reached this batch — see `shapeCloudDelta`'s cap) is folded into a
 * delete too, since "gone" is the true current state either way and the receiving side has
 * no use for a row that no longer exists.
 */
export function buildMirrorDelta(
  rows: readonly CloudOutboxRow[],
  getTask: (id: string) => Task | undefined,
  getProject: (id: string) => Project | undefined,
): MirrorDelta {
  const tasks: Task[] = [];
  const projects: Project[] = [];
  const deletedTaskIds: string[] = [];
  const deletedProjectIds: string[] = [];

  for (const row of rows) {
    if (row.op === 'delete') {
      (row.entity === 'task' ? deletedTaskIds : deletedProjectIds).push(row.entityId);
      continue;
    }
    if (row.entity === 'task') {
      const task = getTask(row.entityId);
      if (task) tasks.push(task);
      else deletedTaskIds.push(row.entityId);
    } else {
      const project = getProject(row.entityId);
      if (project) projects.push(project);
      else deletedProjectIds.push(row.entityId);
    }
  }

  return { tasks, projects, deletedTaskIds, deletedProjectIds };
}
