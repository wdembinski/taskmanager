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
 * `Project`/`Automation`/`AutomationRun`/`Milestone` `@tm/protocol/wire`'s `MirrorDelta`
 * wants, via lookup callbacks rather than a `Store` — `cloudPoller.ts` is the only caller,
 * and it already has `store.getTask`/`store.getProject`/`store.getAutomation`/
 * `store.getAutomationRun`/`store.getMilestone` to pass in directly.
 */
import { AUTOMATION_RUNS_PER_SYNC, type MirrorDelta } from '@protocol/wire';
import type { Automation, AutomationRun } from '@shared/automation';
import type { Milestone, Project, Task } from '@shared/model';

export type CloudEntity = 'task' | 'project' | 'automation' | 'automationRun' | 'milestone';
export type CloudOp = 'insert' | 'update' | 'delete';

export interface CloudOutboxRow {
  seq: number;
  entity: CloudEntity;
  entityId: string;
  op: CloudOp;
  at: number;
}

/**
 * The five lookups a shaped outbox row resolves through, one per {@link CloudEntity} — a
 * single object rather than five positional callbacks, since every function below now takes
 * all five and a sixth entity would otherwise mean a sixth parameter at every call site.
 */
export interface CloudDeltaLookups {
  getTask: (id: string) => Task | undefined;
  getProject: (id: string) => Project | undefined;
  getAutomation: (id: string) => Automation | undefined;
  getAutomationRun: (id: string) => AutomationRun | undefined;
  getMilestone: (id: string) => Milestone | undefined;
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
 * currently holds; a delete row needs no lookup — the id IS the message.
 *
 * A lookup MISS on a task/project/automation insert/update (the entity was deleted again
 * since the outbox row was written, and the later delete hasn't reached this batch — see
 * `shapeCloudDelta`'s cap) is folded into a delete too, since "gone" is the true current
 * state either way and the receiving side has no use for a row that no longer exists. A run
 * miss is different: a run is never deleted on its own (only its whole automation is, via
 * `deletedAutomationIds`), so there is no `deletedAutomationRunIds` array to fold a miss
 * into — it is simply dropped, the same "gone either way" outcome with nothing to say about it.
 */
export function buildMirrorDelta(
  rows: readonly CloudOutboxRow[],
  lookups: CloudDeltaLookups,
): MirrorDelta {
  const tasks: Task[] = [];
  const projects: Project[] = [];
  const deletedTaskIds: string[] = [];
  const deletedProjectIds: string[] = [];
  const automations: Automation[] = [];
  const automationRuns: AutomationRun[] = [];
  const deletedAutomationIds: string[] = [];
  const milestones: Milestone[] = [];
  const deletedMilestoneIds: string[] = [];

  for (const row of rows) {
    if (row.op === 'delete') {
      if (row.entity === 'task') deletedTaskIds.push(row.entityId);
      else if (row.entity === 'project') deletedProjectIds.push(row.entityId);
      else if (row.entity === 'automation') deletedAutomationIds.push(row.entityId);
      else if (row.entity === 'milestone') deletedMilestoneIds.push(row.entityId);
      // 'automationRun' deletes never occur — the outbox has no delete trigger for runs,
      // only an automation's own delete, which already carries its runs in this same array.
      continue;
    }
    switch (row.entity) {
      case 'task': {
        const task = lookups.getTask(row.entityId);
        if (task) tasks.push(task);
        else deletedTaskIds.push(row.entityId);
        break;
      }
      case 'project': {
        const project = lookups.getProject(row.entityId);
        if (project) projects.push(project);
        else deletedProjectIds.push(row.entityId);
        break;
      }
      case 'automation': {
        const automation = lookups.getAutomation(row.entityId);
        if (automation) automations.push(automation);
        else deletedAutomationIds.push(row.entityId);
        break;
      }
      case 'automationRun': {
        const run = lookups.getAutomationRun(row.entityId);
        if (run) automationRuns.push(run);
        break;
      }
      case 'milestone': {
        const milestone = lookups.getMilestone(row.entityId);
        if (milestone) milestones.push(milestone);
        else deletedMilestoneIds.push(row.entityId);
        break;
      }
    }
  }

  // All nine fields, always — a v2 server reading an older `MirrorDelta` shape simply
  // ignores the six keys it has never heard of (see wire.ts's own PROTOCOL_VERSION rule).
  return {
    tasks,
    projects,
    deletedTaskIds,
    deletedProjectIds,
    automations,
    automationRuns,
    deletedAutomationIds,
    milestones,
    deletedMilestoneIds,
  };
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
 * would cross `maxBytes` or the batch already has `AUTOMATION_RUNS_PER_SYNC` runs, and
 * report back which rows were actually taken.
 *
 * Four things this has to get right, each of which loses data if it doesn't:
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
 *  - **the run cap stops the WHOLE batch, not just further runs.** An automation that fires
 *    every few minutes can queue far more runs between two ticks than `AUTOMATION_RUNS_PER_SYNC`
 *    allows, and skipping only the runs past the cap while still taking a later task row
 *    would prune an unsent run out from under itself — the same hole the `seq` re-sort above
 *    exists to avoid. Stopping entirely preserves "everything not sent has a higher seq," and
 *    the run past the cut, and anything after it, goes out on the next call untouched.
 *
 * Lookups are memoized because each row is resolved twice — once to measure, once to build.
 */
export function buildMirrorDeltaWithin(
  rows: readonly CloudOutboxRow[],
  lookups: CloudDeltaLookups,
  maxBytes: number = SYNC_BYTES_LIMIT,
): BoundedMirrorDelta {
  const taskCache = new Map<string, Task | undefined>();
  const projectCache = new Map<string, Project | undefined>();
  const automationCache = new Map<string, Automation | undefined>();
  const automationRunCache = new Map<string, AutomationRun | undefined>();
  const milestoneCache = new Map<string, Milestone | undefined>();
  const memoized: CloudDeltaLookups = {
    getTask: (id) => {
      if (!taskCache.has(id)) taskCache.set(id, lookups.getTask(id));
      return taskCache.get(id);
    },
    getProject: (id) => {
      if (!projectCache.has(id)) projectCache.set(id, lookups.getProject(id));
      return projectCache.get(id);
    },
    getAutomation: (id) => {
      if (!automationCache.has(id)) automationCache.set(id, lookups.getAutomation(id));
      return automationCache.get(id);
    },
    getAutomationRun: (id) => {
      if (!automationRunCache.has(id)) {
        automationRunCache.set(id, lookups.getAutomationRun(id));
      }
      return automationRunCache.get(id);
    },
    getMilestone: (id) => {
      if (!milestoneCache.has(id)) milestoneCache.set(id, lookups.getMilestone(id));
      return milestoneCache.get(id);
    },
  };

  const bySeq = [...rows].sort((a, b) => a.seq - b.seq);
  const taken: CloudOutboxRow[] = [];
  let bytes = 0;
  let runsTaken = 0;
  for (const row of bySeq) {
    if (row.entity === 'automationRun' && runsTaken >= AUTOMATION_RUNS_PER_SYNC) break;
    const size = rowBytes(row, memoized);
    if (taken.length > 0 && bytes + size > maxBytes) break;
    taken.push(row);
    bytes += size;
    if (row.entity === 'automationRun') runsTaken += 1;
  }

  const upserts = taken.filter((row) => row.op !== 'delete');
  const deletes = taken.filter((row) => row.op === 'delete');
  const sent = [...upserts, ...deletes];
  return { delta: buildMirrorDelta(sent, memoized), sent };
}

/**
 * What this row costs on the wire. A delete is just its id; an insert/update is the entity
 * the lookup returns, or — when it misses, exactly as `buildMirrorDelta` folds it — the id
 * again. `+ 1` for the comma that joins it to its neighbours in the array.
 */
function rowBytes(row: CloudOutboxRow, lookups: CloudDeltaLookups): number {
  const value = row.op === 'delete' ? row.entityId : (resolveEntity(row, lookups) ?? row.entityId);
  return Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
}

function resolveEntity(
  row: CloudOutboxRow,
  lookups: CloudDeltaLookups,
): Task | Project | Automation | AutomationRun | Milestone | undefined {
  switch (row.entity) {
    case 'task':
      return lookups.getTask(row.entityId);
    case 'project':
      return lookups.getProject(row.entityId);
    case 'automation':
      return lookups.getAutomation(row.entityId);
    case 'automationRun':
      return lookups.getAutomationRun(row.entityId);
    case 'milestone':
      return lookups.getMilestone(row.entityId);
  }
}
