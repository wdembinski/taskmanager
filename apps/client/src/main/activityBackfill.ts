/**
 * Backfilling the activity log (F2.4, `@shared/activity`) with the thirty days of history
 * that predate it. `activity_log` only gains a row when a live recorder calls
 * `appendActivity` — F2.6/F2.8's work. Nothing wrote that recorder before those builds
 * shipped, so every run and every column move from before then is invisible to the Activity
 * dashboard even though the facts it would need are already sitting in `task_events` and
 * `task_activity`. This derives them once, after the fact.
 *
 * What each kind reconstructs from, and why it is shaped the way it is:
 *
 *  - **run-started**: one `task_events` row per `runId` whose event is `kind: 'started'`,
 *    `MIN(id)` — a run only ever starts once, but `MIN` is cheap insurance against a
 *    duplicate `started` landing twice. `outcome`/`costUsd` are NULL; a start carries
 *    neither.
 *  - **run-finished**: the LAST `result` per `runId`, `MAX(id)` — a run can settle more than
 *    once (memory `settled-run-resurrection-trap`), and the final settle is the truthful
 *    one. `outcome` comes from the event's own `success` flag; `empty`/`stopped` are engine
 *    verdicts this transcript cannot distinguish from a plain failure, so they are not
 *    guessed at. `costUsd` is whatever the event recorded, NULL staying NULL — never
 *    defaulted to 0, which would read as "free" rather than "unknown".
 *  - **status-moved**: every `task_activity` row with `kind = 'status'`. These were always
 *    a human dragging a card — there was no other way to move one before F1's tracker
 *    automations — so `origin` is hardcoded `'human'`, not inferred.
 *
 * Every row's `title` is `COALESCE(t.title, '')`, a snapshot taken at backfill time via a
 * LEFT JOIN against `tasks` — a card deleted since the event fired still gets a row, just
 * with an empty title, the same convention `appendActivity` itself follows going forward.
 * Every row's `detail` carries `backfilled: true` so the feed (and any future re-run of this
 * file) can tell a derived row from one a live recorder wrote.
 *
 * `runId` has no column on `task_activity`, so a status-moved row's `runId` is NULL — a
 * column move is never part of a run.
 *
 * The window is `[sinceMs, untilMs)`: `sinceMs` is `now - ACTIVITY_BACKFILL_DAYS`, matching
 * the retention this log otherwise keeps. `untilMs` is the earliest `at` already in
 * `activity_log` that this backfill did NOT write (or `now + 1` when the log is empty) —
 * never a fixed "now", because a database on which F2.6/F2.8 have already been running for a
 * while has live rows newer than `sinceMs`, and re-deriving those from the raw tables would
 * duplicate them. `run-started`/`run-finished` are protected from that duplication a second
 * way too, by `idx_activity_log_run_once`'s `INSERT OR IGNORE`; `status-moved` has no unique
 * index to fall back on, so the `untilMs` cutoff is the ONLY thing keeping it from double-
 * inserting a move the live recorder already logged.
 *
 * Like `cloudOutboxBackfill.ts`, this file is the pure half — a structural `BackfillDb` so a
 * test can watch it work — and `store.ts` owns the `app_state` guard and the transaction that
 * makes running it twice safe.
 */

/** Guard for the one-shot derivation of activity-log history from the older tables. */
export const ACTIVITY_BACKFILL_KEY = 'migration.activityBackfill';

/** How far back to look, in days — matches the window this log otherwise retains. */
export const ACTIVITY_BACKFILL_DAYS = 30;

/**
 * The earliest `at` already in `activity_log` that this backfill itself did not write —
 * everything from `sinceMs` up to that point is fair game to derive; anything at or after it
 * is a live recorder's row and must not be duplicated. NULL (an empty log) is read by the
 * caller as "no ceiling but `now`".
 */
export const SELECT_ACTIVITY_BACKFILL_UNTIL_SQL = `
  SELECT MIN(at) AS untilMs
    FROM activity_log
   WHERE json_extract(detail, '$.backfilled') IS NULL
      OR json_extract(detail, '$.backfilled') != 1
`;

/** One row per `runId` that started in the window, taken from `task_events`. */
export const BACKFILL_RUN_STARTED_SQL = `
  INSERT OR IGNORE INTO activity_log
      (at, projectId, taskId, runId, kind, outcome, origin, title, costUsd, detail)
  SELECT e.createdAt, e.projectId, e.taskId, e.runId, 'run-started', NULL, NULL,
         COALESCE(t.title, ''), NULL, json_object('backfilled', json('true'))
    FROM task_events e
    LEFT JOIN tasks t ON t.id = e.taskId
   WHERE e.id IN (
           SELECT MIN(id) FROM task_events
            WHERE json_extract(event, '$.kind') = 'started'
              AND createdAt >= ? AND createdAt < ?
            GROUP BY runId
         )
`;

/**
 * The LAST `result` per `runId` in the window — a run can settle more than once (memory
 * settled-run-resurrection-trap), and only the final settle should become this run's
 * `run-finished` row.
 */
export const BACKFILL_RUN_FINISHED_SQL = `
  INSERT OR IGNORE INTO activity_log
      (at, projectId, taskId, runId, kind, outcome, origin, title, costUsd, detail)
  SELECT e.createdAt, e.projectId, e.taskId, e.runId, 'run-finished',
         CASE json_extract(e.event, '$.success') WHEN 1 THEN 'done' ELSE 'failed' END,
         NULL, COALESCE(t.title, ''), json_extract(e.event, '$.costUsd'),
         json_object('backfilled', json('true'))
    FROM task_events e
    LEFT JOIN tasks t ON t.id = e.taskId
   WHERE e.id IN (
           SELECT MAX(id) FROM task_events
            WHERE json_extract(event, '$.kind') = 'result'
              AND createdAt >= ? AND createdAt < ?
            GROUP BY runId
         )
`;

/** Every column move in the window, taken from `task_activity`. Always a human's doing. */
export const BACKFILL_STATUS_MOVED_SQL = `
  INSERT OR IGNORE INTO activity_log
      (at, projectId, taskId, runId, kind, outcome, origin, title, costUsd, detail)
  SELECT a.createdAt, a.projectId, a.taskId, NULL, 'status-moved', NULL, 'human',
         COALESCE(t.title, ''), NULL,
         json_object('from', a.fromStatus, 'to', a.toStatus, 'backfilled', json('true'))
    FROM task_activity a
    LEFT JOIN tasks t ON t.id = a.taskId
   WHERE a.kind = 'status'
     AND a.createdAt >= ? AND a.createdAt < ?
`;

/** How many rows a statement wrote/read. `better-sqlite3`'s `RunResult`, narrowed. */
export interface BackfillRunResult {
  changes: number;
}

/** The one statement shape this needs — enough for a `better-sqlite3` `Statement` to fit. */
export interface BackfillStatement {
  run(...params: unknown[]): BackfillRunResult;
  get(...params: unknown[]): unknown;
}

/** The one database shape this needs — enough for a `better-sqlite3` `Database` to fit. */
export interface BackfillDb {
  prepare(sql: string): BackfillStatement;
}

/** What the back-fill derived, for the guard row to record. */
export interface ActivityBackfillCounts {
  runsStarted: number;
  runsFinished: number;
  moves: number;
}

/**
 * Derive up to thirty days of `run-started`/`run-finished`/`status-moved` rows from
 * `task_events`/`task_activity` and insert them into `activity_log`, stamped
 * `backfilled: true`.
 *
 * Idempotent on its own terms (`INSERT OR IGNORE` against `idx_activity_log_run_once` for the
 * run rows; the `untilMs` ceiling for the status rows, which have no such index) but NOT a
 * substitute for the caller's `app_state` guard — see this file's own docstring for why a
 * database that has since grown live rows must never be re-derived from scratch.
 */
export function backfillActivityLog(db: BackfillDb, now: number): ActivityBackfillCounts {
  const sinceMs = now - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const untilRow = db.prepare(SELECT_ACTIVITY_BACKFILL_UNTIL_SQL).get() as
    { untilMs: number | null } | undefined;
  const untilMs = untilRow?.untilMs ?? now + 1;

  const runsStarted = db.prepare(BACKFILL_RUN_STARTED_SQL).run(sinceMs, untilMs).changes;
  const runsFinished = db.prepare(BACKFILL_RUN_FINISHED_SQL).run(sinceMs, untilMs).changes;
  const moves = db.prepare(BACKFILL_STATUS_MOVED_SQL).run(sinceMs, untilMs).changes;

  return { runsStarted, runsFinished, moves };
}
