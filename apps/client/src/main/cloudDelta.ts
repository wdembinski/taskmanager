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

/**
 * How many bytes of resolved entities one `/v1/sync` request may carry.
 *
 * `shapeCloudDelta`'s cap counts ENTITIES, and an entity has no fixed size: one full `Task`
 * carries its description, its plan and its whole chat transcript, so 200 of them is
 * anywhere from a few kilobytes to many megabytes. A count cap therefore bounds nothing
 * that matters to the wire, which is how a backfill of a few hundred cards ends up past the
 * server's body limit and 413s — forever, since the retry rebuilds the identical batch.
 *
 * Deliberately well under `DEFAULT_BODY_LIMIT` (8 MB, apps/server/src/config/bodyLimit.ts):
 * the accounting below measures the entities, not the JSON framing, the acked-command ids
 * or the headers around them, and the margin has to cover all of that plus any intermediary
 * with a tighter idea of "too large" than the origin's.
 */
export const SYNC_BYTES_LIMIT = 1_000_000;

export interface BoundedMirrorDelta {
  delta: MirrorDelta;
  /** Exactly the rows `delta` speaks for — what the caller may prune, and nothing more. */
  sent: CloudOutboxRow[];
}

/**
 * `buildMirrorDelta` under a byte budget: take rows in ascending `seq` until the next one
 * would cross `maxBytes`, and report back which rows were actually taken.
 *
 * Three things this has to get right, each of which loses data if it doesn't:
 *
 *  - **ascending `seq`, re-sorted here.** `shapeCloudDelta` hands its result deletes-last,
 *    and cutting a prefix off THAT order would leave a hole: the caller prunes the outbox
 *    through `max(sent.seq)`, so a delete row sitting past the cut with a seq below that
 *    point would be pruned having never been sent, and the card would live on in the cloud
 *    forever. Sorting first makes "everything not sent has a higher seq than everything
 *    sent" true again, which is the whole premise of pruning by a single number.
 *  - **always at least one entity.** A single entity larger than the budget would otherwise
 *    produce an empty batch every tick, prune nothing, and wedge the mirror behind it.
 *    It goes out oversized instead; `cloudPoller.ts` logs that loudly.
 *  - **deletes last within the taken set**, matching `shapeCloudDelta`'s own contract, so a
 *    batch that creates and removes in one tick applies the creates first.
 *
 * Lookups are memoized because each row is resolved twice — once to measure, once to build.
 */
export function buildMirrorDeltaWithin(
  rows: readonly CloudOutboxRow[],
  getTask: (id: string) => Task | undefined,
  getProject: (id: string) => Project | undefined,
  maxBytes: number = SYNC_BYTES_LIMIT,
): BoundedMirrorDelta {
  const tasks = new Map<string, Task | undefined>();
  const projects = new Map<string, Project | undefined>();
  const lookupTask = (id: string): Task | undefined => {
    if (!tasks.has(id)) tasks.set(id, getTask(id));
    return tasks.get(id);
  };
  const lookupProject = (id: string): Project | undefined => {
    if (!projects.has(id)) projects.set(id, getProject(id));
    return projects.get(id);
  };

  const bySeq = [...rows].sort((a, b) => a.seq - b.seq);
  const taken: CloudOutboxRow[] = [];
  let bytes = 0;
  for (const row of bySeq) {
    const size = rowBytes(row, lookupTask, lookupProject);
    if (taken.length > 0 && bytes + size > maxBytes) break;
    taken.push(row);
    bytes += size;
  }

  const upserts = taken.filter((row) => row.op !== 'delete');
  const deletes = taken.filter((row) => row.op === 'delete');
  const sent = [...upserts, ...deletes];
  return { delta: buildMirrorDelta(sent, lookupTask, lookupProject), sent };
}

/**
 * What this row costs on the wire. A delete is just its id; an insert/update is the entity
 * the lookup returns, or — when it misses, exactly as `buildMirrorDelta` folds it — the id
 * again. `+ 1` for the comma that joins it to its neighbours in the array.
 */
function rowBytes(
  row: CloudOutboxRow,
  getTask: (id: string) => Task | undefined,
  getProject: (id: string) => Project | undefined,
): number {
  const value =
    row.op === 'delete'
      ? row.entityId
      : ((row.entity === 'task' ? getTask(row.entityId) : getProject(row.entityId)) ??
        row.entityId);
  return Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
}
