/**
 * The back-fill is driven through a recorder rather than a real database: the
 * `better-sqlite3` binary in this repo is built for Electron's ABI, not the Node that runs
 * Vitest (see `store.ts`'s own docstring), so what can be asserted here is the SQL that is
 * issued, the order it is issued in, the `sinceMs`/`untilMs` threaded into it, and what comes
 * back — which is precisely the part that would be wrong if this module were wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_BACKFILL_DAYS,
  ACTIVITY_BACKFILL_KEY,
  BACKFILL_RUN_FINISHED_SQL,
  BACKFILL_RUN_STARTED_SQL,
  BACKFILL_STATUS_MOVED_SQL,
  type BackfillDb,
  SELECT_ACTIVITY_BACKFILL_UNTIL_SQL,
  backfillActivityLog,
} from './activityBackfill';

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * A `BackfillDb` that records every statement. `get()` always answers the `untilMs` select
 * with the row given here; `run()` hands back the next `changes` count in order.
 */
function recorder(
  untilRow: { untilMs: number | null } | undefined,
  changes: number[],
): { db: BackfillDb; calls: Call[] } {
  const calls: Call[] = [];
  let runIndex = 0;
  const db: BackfillDb = {
    prepare(sql) {
      return {
        get(...params: unknown[]) {
          calls.push({ sql, params });
          return untilRow;
        },
        run(...params: unknown[]) {
          calls.push({ sql, params });
          const changed = changes[runIndex] ?? 0;
          runIndex += 1;
          return { changes: changed };
        },
      };
    },
  };
  return { db, calls };
}

describe('backfillActivityLog', () => {
  it('reads untilMs first, then runs started/finished/moved in that order', () => {
    const { db, calls } = recorder({ untilMs: 1000 }, [1, 1, 1]);
    backfillActivityLog(db, 2000);
    expect(calls.map((c) => c.sql)).toEqual([
      SELECT_ACTIVITY_BACKFILL_UNTIL_SQL,
      BACKFILL_RUN_STARTED_SQL,
      BACKFILL_RUN_FINISHED_SQL,
      BACKFILL_STATUS_MOVED_SQL,
    ]);
  });

  it('threads [sinceMs, untilMs] into every insert, sinceMs thirty days before now', () => {
    const now = 2_600_000_000_000;
    const untilMs = 2_599_000_000_000;
    const sinceMs = now - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
    const { db, calls } = recorder({ untilMs }, [0, 0, 0]);
    backfillActivityLog(db, now);
    expect(calls.slice(1).map((c) => c.params)).toEqual([
      [sinceMs, untilMs],
      [sinceMs, untilMs],
      [sinceMs, untilMs],
    ]);
  });

  it('falls back to now + 1 when the log has no un-backfilled row yet (untilMs is NULL)', () => {
    const now = 5000;
    const { db, calls } = recorder({ untilMs: null }, [0, 0, 0]);
    backfillActivityLog(db, now);
    expect(calls[1]?.params).toEqual([now - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000, now + 1]);
  });

  it('falls back to now + 1 when the log is empty (no row at all)', () => {
    const now = 5000;
    const { db, calls } = recorder(undefined, [0, 0, 0]);
    backfillActivityLog(db, now);
    expect(calls[1]?.params).toEqual([now - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000, now + 1]);
  });

  it('returns the counts the statements reported', () => {
    const { db } = recorder({ untilMs: 1000 }, [4, 2, 9]);
    expect(backfillActivityLog(db, 2000)).toEqual({ runsStarted: 4, runsFinished: 2, moves: 9 });
  });

  it('reports nothing derived on a database already fully backfilled', () => {
    const { db } = recorder({ untilMs: 1000 }, [0, 0, 0]);
    expect(backfillActivityLog(db, 2000)).toEqual({ runsStarted: 0, runsFinished: 0, moves: 0 });
  });
});

describe('the back-fill statements', () => {
  it('insert-or-ignore, so a second pass or a resurrected event never doubles a row', () => {
    for (const sql of [
      BACKFILL_RUN_STARTED_SQL,
      BACKFILL_RUN_FINISHED_SQL,
      BACKFILL_STATUS_MOVED_SQL,
    ]) {
      expect(sql).toContain('INSERT OR IGNORE INTO activity_log');
    }
  });

  it('stamp every derived row backfilled: true', () => {
    for (const sql of [
      BACKFILL_RUN_STARTED_SQL,
      BACKFILL_RUN_FINISHED_SQL,
      BACKFILL_STATUS_MOVED_SQL,
    ]) {
      expect(sql).toContain("'backfilled', json('true')");
    }
  });

  it('run-started takes MIN(id) per runId; run-finished takes MAX(id)', () => {
    expect(BACKFILL_RUN_STARTED_SQL).toContain('SELECT MIN(id) FROM task_events');
    expect(BACKFILL_RUN_FINISHED_SQL).toContain('SELECT MAX(id) FROM task_events');
  });

  it("status-moved hardcodes origin 'human' and leaves runId NULL — a move is never part of a run", () => {
    expect(BACKFILL_STATUS_MOVED_SQL).toContain("'status-moved', NULL, 'human'");
  });

  it('every statement snapshots the title via a LEFT JOIN, never an inner one', () => {
    for (const sql of [
      BACKFILL_RUN_STARTED_SQL,
      BACKFILL_RUN_FINISHED_SQL,
      BACKFILL_STATUS_MOVED_SQL,
    ]) {
      expect(sql).toContain('LEFT JOIN tasks t ON t.id');
      expect(sql).toContain("COALESCE(t.title, '')");
    }
  });

  it('the untilMs select excludes rows this backfill itself already wrote', () => {
    expect(SELECT_ACTIVITY_BACKFILL_UNTIL_SQL).toContain("json_extract(detail, '$.backfilled')");
  });

  it('has a guard key of its own, not shared with another migration', () => {
    expect(ACTIVITY_BACKFILL_KEY).toBe('migration.activityBackfill');
  });

  it("looks back thirty days, matching the log's own retention window", () => {
    expect(ACTIVITY_BACKFILL_DAYS).toBe(30);
  });
});
