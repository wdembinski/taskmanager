/**
 * The back-fill is driven through a recorder rather than a real database: the
 * `better-sqlite3` binary in this repo is built for Electron's ABI, not the Node that runs
 * Vitest (see `store.ts`'s own docstring), so what can be asserted here is the SQL that is
 * issued, the order it is issued in and what comes back — which is precisely the part that
 * would be wrong if this module were wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_AUTOMATION_RUNS_SQL,
  BACKFILL_AUTOMATION_RUN_MAX_AGE_MS,
  BACKFILL_AUTOMATIONS_SQL,
  BACKFILL_MILESTONES_SQL,
  BACKFILL_PROJECTS_SQL,
  BACKFILL_TASKS_SQL,
  type BackfillDb,
  CLOUD_OUTBOX_AUTOMATION_BACKFILL_KEY,
  CLOUD_OUTBOX_BACKFILL_KEY,
  CLOUD_OUTBOX_MILESTONE_BACKFILL_KEY,
  backfillAutomationCloudOutbox,
  backfillCloudOutbox,
  backfillMilestoneCloudOutbox,
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

describe('backfillAutomationCloudOutbox', () => {
  it('runs both statements, automations before runs', () => {
    const { db, calls } = recorder([1, 3]);
    backfillAutomationCloudOutbox(db, 1000);
    expect(calls.map((c) => c.sql)).toEqual([
      BACKFILL_AUTOMATIONS_SQL,
      BACKFILL_AUTOMATION_RUNS_SQL,
    ]);
  });

  it('threads `at` into the automations statement, and `at` plus the retention cutoff into the runs one', () => {
    const { db, calls } = recorder([0, 0]);
    backfillAutomationCloudOutbox(db, 1_691_000_000_000);
    expect(calls[0]?.params).toEqual([1_691_000_000_000]);
    expect(calls[1]?.params).toEqual([
      1_691_000_000_000,
      1_691_000_000_000 - BACKFILL_AUTOMATION_RUN_MAX_AGE_MS,
    ]);
  });

  it('returns the counts the statements reported', () => {
    const { db } = recorder([2, 9]);
    expect(backfillAutomationCloudOutbox(db, 1000)).toEqual({ automations: 2, automationRuns: 9 });
  });

  it('reports nothing queued on a board the outbox already speaks for', () => {
    const { db } = recorder([0, 0]);
    expect(backfillAutomationCloudOutbox(db, 1000)).toEqual({
      automations: 0,
      automationRuns: 0,
    });
  });

  it('has a guard key of its own, shared with neither the task/project nor another migration', () => {
    expect(CLOUD_OUTBOX_AUTOMATION_BACKFILL_KEY).toBe('migration.cloudOutboxAutomationBackfill');
    expect(CLOUD_OUTBOX_AUTOMATION_BACKFILL_KEY).not.toBe(CLOUD_OUTBOX_BACKFILL_KEY);
  });
});

describe('the automation back-fill statements', () => {
  it('only queue what the outbox has never spoken for', () => {
    for (const sql of [BACKFILL_AUTOMATIONS_SQL, BACKFILL_AUTOMATION_RUNS_SQL]) {
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('FROM cloud_outbox o');
    }
  });

  it("says 'insert' — the server has never seen these", () => {
    expect(BACKFILL_AUTOMATIONS_SQL).toContain("'automation', a.id, 'insert'");
    expect(BACKFILL_AUTOMATION_RUNS_SQL).toContain("'automationRun', r.id, 'insert'");
  });

  it('keeps the runs statement inside the same retention window pruning uses', () => {
    // A run older than 30 days is retention's to drop, not this backfill's to queue for a
    // server about to drop it right back.
    expect(BACKFILL_AUTOMATION_RUNS_SQL).toContain('r.at >= ?');
  });
});

describe('backfillMilestoneCloudOutbox', () => {
  it('runs the one statement', () => {
    const { db, calls } = recorder([5]);
    backfillMilestoneCloudOutbox(db, 1000);
    expect(calls.map((c) => c.sql)).toEqual([BACKFILL_MILESTONES_SQL]);
  });

  it('threads `at` into the statement', () => {
    const { db, calls } = recorder([0]);
    backfillMilestoneCloudOutbox(db, 1_691_000_000_000);
    expect(calls.map((c) => c.params)).toEqual([[1_691_000_000_000]]);
  });

  it('returns the count the statement reported', () => {
    const { db } = recorder([6]);
    expect(backfillMilestoneCloudOutbox(db, 1000)).toEqual({ milestones: 6 });
  });

  it('reports nothing queued on a board the outbox already speaks for', () => {
    const { db } = recorder([0]);
    expect(backfillMilestoneCloudOutbox(db, 1000)).toEqual({ milestones: 0 });
  });

  it('has a guard key of its own, shared with neither other backfill', () => {
    expect(CLOUD_OUTBOX_MILESTONE_BACKFILL_KEY).toBe('migration.cloudOutboxMilestoneBackfill');
    expect(CLOUD_OUTBOX_MILESTONE_BACKFILL_KEY).not.toBe(CLOUD_OUTBOX_BACKFILL_KEY);
    expect(CLOUD_OUTBOX_MILESTONE_BACKFILL_KEY).not.toBe(CLOUD_OUTBOX_AUTOMATION_BACKFILL_KEY);
  });
});

describe('the milestone back-fill statement', () => {
  it('only queues what the outbox has never spoken for', () => {
    expect(BACKFILL_MILESTONES_SQL).toContain('NOT EXISTS');
    expect(BACKFILL_MILESTONES_SQL).toContain('FROM cloud_outbox o');
  });

  it('queues rows in a deterministic order', () => {
    expect(BACKFILL_MILESTONES_SQL).toContain('ORDER BY m.rowid');
  });

  it("says 'insert' — the server has never seen these", () => {
    expect(BACKFILL_MILESTONES_SQL).toContain("'milestone', m.id, 'insert'");
  });
});
