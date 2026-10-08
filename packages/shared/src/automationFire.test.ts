import { describe, expect, it } from 'vitest';
import { DEFAULT_CATCH_UP_MS, DEFAULT_GRACE_MS, decideFire } from './automationFire';
import { nextOccurrence } from './automationSchedule';
import type { ScheduleShape } from './automation';

const WARSAW = 'Europe/Warsaw';

const iso = (s: string): number => new Date(s).getTime();

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

const DAILY: ScheduleShape = { type: 'daily', hour: 4, minute: 0 };
const WEEKDAYS: ScheduleShape = { type: 'weekdays', hour: 4, minute: 0 };
const WEEKLY: ScheduleShape = { type: 'weekly', day: 3, hour: 4, minute: 0 };
const HOURLY: ScheduleShape = { type: 'hours', every: 1 };
const HOURS6: ScheduleShape = { type: 'hours', every: 6 };

/** A genuine occurrence of `shape` — `decideFire`'s `due` is always one of these in practice. */
function dueAt(shape: ScheduleShape, after: number): number {
  return nextOccurrence(shape, after, WARSAW);
}

describe('decideFire — due in the future', () => {
  it('returns null when due > now', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    expect(decideFire({ due, now: due - 1, shape: DAILY, tz: WARSAW })).toBeNull();
  });
});

describe('decideFire — on time', () => {
  it('within grace fires scheduled with nothing skipped', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const now = due + 2 * MIN_MS;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW });
    expect(result).toEqual(
      expect.objectContaining({ kind: 'scheduled', occurrenceAt: due, skippedCount: 0 }),
    );
  });

  it('boundary exactly at graceMs is still scheduled', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const now = due + DEFAULT_GRACE_MS;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW });
    expect(result?.kind).toBe('scheduled');
    expect(result?.skippedCount).toBe(0);
  });

  it('one instant past graceMs is a catch-up, not scheduled', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const now = due + DEFAULT_GRACE_MS + 1;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW });
    expect(result?.kind).toBe('catch-up');
  });
});

describe('decideFire — daily, a few hours late', () => {
  it('3 hours late is a catch-up with nothing skipped', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const now = due + 3 * HOUR_MS;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW });
    expect(result).toEqual(
      expect.objectContaining({ kind: 'catch-up', occurrenceAt: due, skippedCount: 0 }),
    );
  });
});

describe('decideFire — daily asleep through several trigger days', () => {
  it('catches up once for the latest missed day, skipping the earlier two', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z')); // "day 1"
    const latest = due + 2 * DAY_MS; // "day 3" — the latest missed occurrence
    const now = latest + 2 * HOUR_MS; // woke up a couple hours after day 3's trigger
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW });
    expect(result).toEqual(
      expect.objectContaining({ kind: 'catch-up', occurrenceAt: latest, skippedCount: 2 }),
    );
  });
});

describe('decideFire — weekly, missed occurrence older than the catch-up window', () => {
  it('2 days late (past catchUpMs) skips, counting just the one missed occurrence', () => {
    const due = dueAt(WEEKLY, iso('2026-01-05T00:00:00Z'));
    const now = due + 2 * DAY_MS;
    const result = decideFire({ due, now, shape: WEEKLY, tz: WARSAW });
    expect(result).toEqual(
      expect.objectContaining({ kind: 'skip', occurrenceAt: due, skippedCount: 1 }),
    );
  });
});

describe('decideFire — hourly schedules never catch up', () => {
  it('20 minutes late (past grace) skips even though it is well inside catchUpMs', () => {
    const due = dueAt(HOURLY, iso('2026-01-10T00:00:00Z'));
    const now = due + 20 * MIN_MS;
    const result = decideFire({ due, now, shape: HOURLY, tz: WARSAW });
    expect(result).toEqual(
      expect.objectContaining({ kind: 'skip', occurrenceAt: due, skippedCount: 1 }),
    );
  });

  it('5 minutes late (within grace) still fires scheduled', () => {
    const due = dueAt(HOURLY, iso('2026-01-10T00:00:00Z'));
    const now = due + 5 * MIN_MS;
    const result = decideFire({ due, now, shape: HOURLY, tz: WARSAW });
    expect(result).toEqual(
      expect.objectContaining({ kind: 'scheduled', occurrenceAt: due, skippedCount: 0 }),
    );
  });

  it('asleep 30 hours still just skips, counting every missed hour', () => {
    const due = dueAt(HOURLY, iso('2026-01-10T00:00:00Z'));
    const now = due + 30 * HOUR_MS + 20 * MIN_MS;
    const result = decideFire({ due, now, shape: HOURLY, tz: WARSAW });
    // due itself, plus the 30 hourly occurrences strictly after it, up to `now`.
    expect(result).toEqual(
      expect.objectContaining({ kind: 'skip', occurrenceAt: due + 30 * HOUR_MS, skippedCount: 31 }),
    );
  });
});

describe('decideFire — custom graceMs/catchUpMs', () => {
  it('a wider graceMs turns what would be a catch-up into scheduled', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const now = due + 3 * HOUR_MS;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW, graceMs: 4 * HOUR_MS });
    expect(result?.kind).toBe('scheduled');
    expect(result?.skippedCount).toBe(0);
  });

  it('a narrower catchUpMs turns what would be a catch-up into a skip', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const now = due + 3 * HOUR_MS;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW, catchUpMs: 2 * HOUR_MS });
    expect(result?.kind).toBe('skip');
    expect(result?.skippedCount).toBe(1);
  });

  it('boundary exactly at a custom catchUpMs is still a catch-up', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const customCatchUp = 5 * HOUR_MS;
    const now = due + customCatchUp;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW, catchUpMs: customCatchUp });
    expect(result?.kind).toBe('catch-up');
  });

  it('one instant past a custom catchUpMs is a skip', () => {
    const due = dueAt(DAILY, iso('2026-01-10T00:00:00Z'));
    const customCatchUp = 5 * HOUR_MS;
    const now = due + customCatchUp + 1;
    const result = decideFire({ due, now, shape: DAILY, tz: WARSAW, catchUpMs: customCatchUp });
    expect(result?.kind).toBe('skip');
  });
});

describe('decideFire — a huge gap does not corrupt occurrenceAt past the 10,000-occurrence cap', () => {
  it('hourly asleep well over a year still finds the true latest hour, not a capped stale one', () => {
    const due = dueAt(HOURLY, iso('2026-01-10T00:00:00Z'));
    const now = due + 420 * DAY_MS + 15 * MIN_MS; // ~10,080 hourly occurrences missed
    const result = decideFire({ due, now, shape: HOURLY, tz: WARSAW });
    expect(result?.kind).toBe('skip');
    expect(result?.occurrenceAt).toBe(due + 420 * DAY_MS);
    expect(result?.skippedCount).toBeGreaterThanOrEqual(10_000);
    expect(result?.nextRunAt).toBeGreaterThan(now);
  });
});

describe('decideFire — nextRunAt always arms strictly after now', () => {
  const shapes: ScheduleShape[] = [DAILY, WEEKDAYS, WEEKLY, HOURLY, HOURS6];
  const offsets = [
    0,
    5 * MIN_MS,
    20 * MIN_MS,
    3 * HOUR_MS,
    DEFAULT_CATCH_UP_MS,
    2 * DAY_MS,
    30 * HOUR_MS,
  ];

  for (const shape of shapes) {
    for (const offset of offsets) {
      it(`${JSON.stringify(shape)} at +${offset}ms is armed after now`, () => {
        const due = dueAt(shape, iso('2026-01-05T00:00:00Z'));
        const now = due + offset;
        const result = decideFire({ due, now, shape, tz: WARSAW });
        expect(result).not.toBeNull();
        expect(result?.nextRunAt).toBeGreaterThan(now);
      });
    }
  }
});
