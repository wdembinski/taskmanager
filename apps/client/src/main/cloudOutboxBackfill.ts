/**
 * Mirroring the board that was already there when the mirror was switched on.
 *
 * `cloud_outbox` is filled by triggers (see `store.ts`), and a trigger only ever hears about
 * a WRITE. Every project and card that existed before Phase 25's triggers were created has
 * therefore never produced an outbox row, and never will until somebody happens to edit it —
 * which is the whole reason the web app shows an all-but-empty board against a desktop full
 * of tickets. The rows are not missing from the server because a sync failed; they were never
 * queued to be sent.
 *
 * So they are queued once, here.
 *
 * Three details that are load-bearing:
 *
 *  - **Projects first, then tasks.** Projects get the lower `seq`, so a first batch that the
 *    byte cap or `OUTBOX_LIMIT` cuts short still carries the Personal project ahead of the
 *    cards that point at it, rather than a heap of cards belonging to a project the server
 *    has not been told about.
 *  - **Tasks ordered `(parentTaskId IS NOT NULL), "order", rowid`.** Parents before their
 *    steps for the same reason, then the board's own order, then `rowid` so the whole thing
 *    is deterministic and a partial mirror is a PREFIX of the board rather than a sample of
 *    it. (`INSERT ... SELECT ... ORDER BY` is meaningful precisely because `seq` is
 *    `INTEGER PRIMARY KEY AUTOINCREMENT`: the rows are numbered in the order they are
 *    inserted.)
 *  - **`op = 'insert'`.** The truthful word for "the server has never seen this".
 *    `buildMirrorDelta` treats insert and update identically — both resolve to the current
 *    row and go out as an upsert — so nothing downstream depends on the choice; it is the
 *    log that should not lie.
 *
 * A plain `INSERT ... SELECT` is safe to run against these tables: the triggers are on
 * `tasks` and `projects`, and there is none on `cloud_outbox`, so writing outbox rows writes
 * nothing else. The trap to avoid is the other shape — `UPDATE tasks SET updatedAt =
 * updatedAt` to make the update trigger do the logging — which rewrites every row and bumps
 * the whole board's `updatedAt` in one go, so every card looks touched today.
 *
 * **No chunking**, deliberately, because it is the first thing a reader will want to add: an
 * outbox row is five small columns, twenty thousand of them is one easy SQLite transaction,
 * and nothing here reaches the network. The drain is bounded downstream anyway, by
 * `OUTBOX_LIMIT` and `SYNC_BYTES_LIMIT` in `cloudPoller`/`cloudDelta`.
 *
 * **It must run exactly once**, and it takes BOTH guards to get there. `NOT EXISTS` alone is
 * not enough: `pruneCloudOutbox` deletes the rows the server has acked, so once the backfill
 * has drained there is nothing left for `NOT EXISTS` to see and the next launch mirrors the
 * whole board again, forever. The `app_state` key alone is not enough either: a crash between
 * the inserts and the guard would leave the rows queued and the key unwritten, and the launch
 * after that would queue them a second time. Together they hold — the SQL takes the pass, the
 * key remembers it happened. The function below is the pure half, driven by a structural
 * `BackfillDb` so a test can watch it work; `store.ts` owns the `app_state` guard and the
 * transaction, exactly as `blockOwnerMigration.ts` splits the same way.
 */

/** Guard for the one-shot mirror of the projects and cards that predate the outbox triggers. */
export const CLOUD_OUTBOX_BACKFILL_KEY = 'migration.cloudOutboxBackfill';

/** Every project the outbox has never spoken for, oldest row first. */
export const BACKFILL_PROJECTS_SQL = `
  INSERT INTO cloud_outbox (entity, entityId, op, at)
  SELECT 'project', p.id, 'insert', ?
    FROM projects p
   WHERE NOT EXISTS (
     SELECT 1 FROM cloud_outbox o WHERE o.entity = 'project' AND o.entityId = p.id
   )
   ORDER BY p.rowid
`;

/** Every task the outbox has never spoken for: parents before steps, board order preserved. */
export const BACKFILL_TASKS_SQL = `
  INSERT INTO cloud_outbox (entity, entityId, op, at)
  SELECT 'task', t.id, 'insert', ?
    FROM tasks t
   WHERE NOT EXISTS (
     SELECT 1 FROM cloud_outbox o WHERE o.entity = 'task' AND o.entityId = t.id
   )
   ORDER BY (t.parentTaskId IS NOT NULL), t."order", t.rowid
`;

/** How many outbox rows a statement wrote. `better-sqlite3`'s `RunResult`, narrowed. */
export interface BackfillRunResult {
  changes: number;
}

/** The one statement shape this needs — enough for a `better-sqlite3` `Statement` to fit. */
export interface BackfillStatement {
  run(...params: unknown[]): BackfillRunResult;
}

/** The one database shape this needs — enough for a `better-sqlite3` `Database` to fit. */
export interface BackfillDb {
  prepare(sql: string): BackfillStatement;
}

/** What the back-fill queued, for the guard row to record. */
export interface CloudOutboxBackfillCounts {
  projects: number;
  tasks: number;
}

/**
 * Queue an outbox row for every project and task that has none, stamped `at = nowMs`.
 *
 * Idempotent on its own terms (`NOT EXISTS`) but NOT a substitute for the caller's
 * `app_state` guard — see the note above on why pruning defeats the SQL guard alone.
 */
export function backfillCloudOutbox(db: BackfillDb, nowMs: number): CloudOutboxBackfillCounts {
  const projects = db.prepare(BACKFILL_PROJECTS_SQL).run(nowMs).changes;
  const tasks = db.prepare(BACKFILL_TASKS_SQL).run(nowMs).changes;
  return { projects, tasks };
}
