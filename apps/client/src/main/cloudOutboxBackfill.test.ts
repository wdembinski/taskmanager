/**
 * The back-fill is driven through a recorder rather than a real database: the
 * `better-sqlite3` binary in this repo is built for Electron's ABI, not the Node that runs
 * Vitest (see `store.ts`'s own docstring), so what can be asserted here is the SQL that is
 * issued, the order it is issued in and what comes back — which is precisely the part that
 * would be wrong if this module were wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_PROJECTS_SQL,
  BACKFILL_TASKS_SQL,
  type BackfillDb,
  CLOUD_OUTBOX_BACKFILL_KEY,
  backfillCloudOutbox,
} from './cloudOutboxBackfill';

interface Call {
  sql: string;
  params: unknown[];
}

/** A `BackfillDb` that records every statement and hands back the `changes` it was given. */
function recorder(changes: number[]): { db: BackfillDb; calls: Call[] } {
  const calls: Call[] = [];
  const db: BackfillDb = {
    prepare(sql) {
      return {
        run(...params) {
          calls.push({ sql, params });
          return { changes: changes[calls.length - 1] ?? 0 };
        },
      };
    },
  };
  return { db, calls };
}

describe('backfillCloudOutbox', () => {
  it('runs both statements, projects before tasks', () => {
    const { db, calls } = recorder([2, 7]);
    backfillCloudOutbox(db, 1000);
    expect(calls.map((c) => c.sql)).toEqual([BACKFILL_PROJECTS_SQL, BACKFILL_TASKS_SQL]);
  });

  it('threads `at` into both statements', () => {
    const { db, calls } = recorder([0, 0]);
    backfillCloudOutbox(db, 1_691_000_000_000);
    expect(calls.map((c) => c.params)).toEqual([[1_691_000_000_000], [1_691_000_000_000]]);
  });

  it('returns the counts the statements reported', () => {
    const { db } = recorder([3, 41]);
    expect(backfillCloudOutbox(db, 1000)).toEqual({ projects: 3, tasks: 41 });
  });

  it('reports nothing queued on a board the outbox already speaks for', () => {
    // The second run on the same database: `NOT EXISTS` matches nothing, so both statements
    // change zero rows. The caller writes its guard either way.
    const { db } = recorder([0, 0]);
    expect(backfillCloudOutbox(db, 1000)).toEqual({ projects: 0, tasks: 0 });
  });
});

describe('the back-fill statements', () => {
  it('only queue what the outbox has never spoken for', () => {
    // Without this the back-fill would double-log every entity the triggers already caught.
    for (const sql of [BACKFILL_PROJECTS_SQL, BACKFILL_TASKS_SQL]) {
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('FROM cloud_outbox o');
    }
  });

  it('queue rows in a deterministic order, parents before their steps', () => {
    // `seq` is AUTOINCREMENT, so the SELECT's order IS the order a capped batch drains in.
    expect(BACKFILL_PROJECTS_SQL).toContain('ORDER BY p.rowid');
    expect(BACKFILL_TASKS_SQL).toContain(
      'ORDER BY (t.parentTaskId IS NOT NULL), t."order", t.rowid',
    );
  });

  it("says 'insert' — the server has never seen these", () => {
    expect(BACKFILL_PROJECTS_SQL).toContain("'project', p.id, 'insert'");
    expect(BACKFILL_TASKS_SQL).toContain("'task', t.id, 'insert'");
  });

  it('has a guard key of its own, not shared with another migration', () => {
    expect(CLOUD_OUTBOX_BACKFILL_KEY).toBe('migration.cloudOutboxBackfill');
  });
});
