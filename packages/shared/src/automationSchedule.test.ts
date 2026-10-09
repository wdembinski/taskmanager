import { describe, expect, it } from 'vitest';
import {
  cronOf,
  nextOccurrence,
  occurrencesBetween,
  scheduleLabel,
  wallToUtc,
} from './automationSchedule';
import type { ScheduleShape } from './automation';

const WARSAW = 'Europe/Warsaw';

const iso = (s: string): number => new Date(s).getTime();

describe('nextOccurrence — daily', () => {
  it('resolves 04:00 Warsaw (CET, UTC+1) to 03:00 UTC', () => {
    const shape: ScheduleShape = { type: 'daily', hour: 4, minute: 0 };
    expect(nextOccurrence(shape, iso('2026-01-10T12:00:00Z'), WARSAW)).toBe(
      iso('2026-01-11T03:00:00Z'),
    );
  });

  it('is strictly after — landing exactly on an occurrence gives the next day, not the same one', () => {
    const shape: ScheduleShape = { type: 'daily', hour: 4, minute: 0 };
    const occurrence = iso('2026-01-11T03:00:00Z');
    expect(nextOccurrence(shape, occurrence, WARSAW)).toBe(iso('2026-01-12T03:00:00Z'));
  });
});

describe('nextOccurrence — weekdays', () => {
  it('skips the weekend: Friday after 04:00 resolves to Monday', () => {
    const shape: ScheduleShape = { type: 'weekdays', hour: 4, minute: 0 };
    // 2026-01-09 is a Friday; 05:00 Warsaw local is well after the 04:00 trigger.
    const fridayAfterwards = iso('2026-01-09T05:00:00Z');
    expect(nextOccurrence(shape, fridayAfterwards, WARSAW)).toBe(iso('2026-01-12T03:00:00Z'));
  });

  it('occurrencesBetween over a full week yields 5 weekday occurrences', () => {
    const shape: ScheduleShape = { type: 'weekdays', hour: 4, minute: 0 };
    const from = wallToUtc(2026, 1, 5, 0, 0, WARSAW); // Monday local midnight
    const to = wallToUtc(2026, 1, 12, 0, 0, WARSAW); // the following Monday local midnight
    const occurrences = occurrencesBetween(shape, from, to, WARSAW);
    expect(occurrences).toHaveLength(5);
  });
});

describe('nextOccurrence — weekly (ISO day 7 = Sunday)', () => {
  const shape: ScheduleShape = { type: 'weekly', day: 7, hour: 4, minute: 0 };

  it('from a Wednesday resolves to that week’s Sunday', () => {
    // 2026-01-07 is a Wednesday; 2026-01-11 is the next Sunday.
    expect(nextOccurrence(shape, iso('2026-01-07T10:00:00Z'), WARSAW)).toBe(
      iso('2026-01-11T03:00:00Z'),
    );
  });

  it('from Sunday after the trigger time resolves to the following Sunday', () => {
    const thatSunday = iso('2026-01-11T03:00:00Z');
    expect(nextOccurrence(shape, thatSunday, WARSAW)).toBe(iso('2026-01-18T03:00:00Z'));
  });
});

describe('nextOccurrence — hours/6 across midnight', () => {
  it('steps from 23:30 Warsaw to the next 00:00, then 06:00, local', () => {
    const shape: ScheduleShape = { type: 'hours', every: 6 };
    // 2026-01-10T22:30Z is 23:30 Warsaw (CET, UTC+1).
    const from = iso('2026-01-10T22:30:00Z');
    const midnightLocal = nextOccurrence(shape, from, WARSAW);
    expect(midnightLocal).toBe(iso('2026-01-10T23:00:00Z'));
    const sixAmLocal = nextOccurrence(shape, midnightLocal, WARSAW);
    expect(sixAmLocal).toBe(iso('2026-01-11T05:00:00Z'));
  });
});

describe('wallToUtc and nextOccurrence — DST spring-forward (Warsaw 2026-03-29)', () => {
  it('a wall time inside the gap fires at the transition instant', () => {
    // 02:30 CET does not exist on 2026-03-29 — Warsaw jumps straight to 03:00 CEST.
    expect(wallToUtc(2026, 3, 29, 2, 30, WARSAW)).toBe(iso('2026-03-29T01:00:00Z'));
  });

  it('nextOccurrence resolves the same gap, then the following day at the normal offset', () => {
    const shape: ScheduleShape = { type: 'daily', hour: 2, minute: 30 };
    const dayBefore = wallToUtc(2026, 3, 28, 12, 0, WARSAW);
    const onGapDay = nextOccurrence(shape, dayBefore, WARSAW);
    expect(onGapDay).toBe(iso('2026-03-29T01:00:00Z'));
    const nextDay = nextOccurrence(shape, onGapDay, WARSAW);
    expect(nextDay).toBe(iso('2026-03-30T00:30:00Z'));
  });
});

describe('wallToUtc and nextOccurrence — DST fall-back (Warsaw 2026-10-25)', () => {
  it('a wall time that occurs twice fires once, at the first (earlier) instant', () => {
    expect(wallToUtc(2026, 10, 25, 2, 30, WARSAW)).toBe(iso('2026-10-25T00:30:00Z'));
  });

  it('occurrencesBetween over that local day gives exactly one daily occurrence', () => {
    const shape: ScheduleShape = { type: 'daily', hour: 2, minute: 30 };
    const from = wallToUtc(2026, 10, 25, 0, 0, WARSAW);
    const to = wallToUtc(2026, 10, 26, 0, 0, WARSAW);
    const occurrences = occurrencesBetween(shape, from, to, WARSAW);
    expect(occurrences).toEqual([iso('2026-10-25T00:30:00Z')]);
  });

  it('occurrencesBetween over that local day gives 24 hourly occurrences, not 25', () => {
    const shape: ScheduleShape = { type: 'hours', every: 1 };
    const from = wallToUtc(2026, 10, 25, 0, 0, WARSAW);
    const to = wallToUtc(2026, 10, 26, 0, 0, WARSAW);
    const occurrences = occurrencesBetween(shape, from, to, WARSAW);
    expect(occurrences).toHaveLength(24);
  });
});

describe('occurrencesBetween — a normal January week', () => {
  const from = wallToUtc(2026, 1, 5, 0, 0, WARSAW); // Monday local midnight
  const to = wallToUtc(2026, 1, 12, 0, 0, WARSAW); // the following Monday local midnight

  it.each<[ScheduleShape, number]>([
    [{ type: 'daily', hour: 4, minute: 0 }, 7],
    [{ type: 'weekdays', hour: 4, minute: 0 }, 5],
    [{ type: 'weekly', day: 7, hour: 4, minute: 0 }, 1],
    [{ type: 'hours', every: 6 }, 28],
    [{ type: 'hours', every: 1 }, 168],
  ])('%j yields %i occurrences', (shape, expectedCount) => {
    const occurrences = occurrencesBetween(shape, from, to, WARSAW);
    expect(occurrences).toHaveLength(expectedCount);
    expect(occurrences.every((t) => t >= from && t < to)).toBe(true);
    for (let i = 1; i < occurrences.length; i++) {
      expect(occurrences[i]).toBeGreaterThan(occurrences[i - 1]);
    }
  });
});

describe('occurrencesBetween — the spring-forward week loses an hour', () => {
  it('hours/1 over the week containing the gap gives 167, not 168', () => {
    const shape: ScheduleShape = { type: 'hours', every: 1 };
    const from = wallToUtc(2026, 3, 23, 0, 0, WARSAW); // Monday local midnight
    const to = wallToUtc(2026, 3, 30, 0, 0, WARSAW); // the following Monday local midnight
    const occurrences = occurrencesBetween(shape, from, to, WARSAW);
    expect(occurrences).toHaveLength(167);
    for (let i = 1; i < occurrences.length; i++) {
      expect(occurrences[i]).toBeGreaterThan(occurrences[i - 1]);
    }
  });
});

describe('a non-Warsaw zone sanity check', () => {
  it('America/New_York daily 09:00 resolves at the EST offset (UTC-5) in January', () => {
    const shape: ScheduleShape = { type: 'daily', hour: 9, minute: 0 };
    const occurrence = nextOccurrence(shape, iso('2026-01-10T00:00:00Z'), 'America/New_York');
    expect(occurrence).toBe(iso('2026-01-10T14:00:00Z'));
  });

  it('Asia/Kolkata (+05:30, no DST) daily 09:00 resolves at a half-hour offset', () => {
    const shape: ScheduleShape = { type: 'daily', hour: 9, minute: 0 };
    const occurrence = nextOccurrence(shape, iso('2026-01-10T00:00:00Z'), 'Asia/Kolkata');
    expect(occurrence).toBe(iso('2026-01-10T03:30:00Z'));
  });
});

describe('scheduleLabel', () => {
  it('renders every shape, with no time zone in the string', () => {
    expect(scheduleLabel({ type: 'daily', hour: 4, minute: 0 })).toBe('daily at 04:00');
    expect(scheduleLabel({ type: 'weekdays', hour: 9, minute: 5 })).toBe('weekdays at 09:05');
    expect(scheduleLabel({ type: 'weekly', day: 7, hour: 4, minute: 0 })).toBe(
      'every Sunday at 04:00',
    );
    expect(scheduleLabel({ type: 'weekly', day: 1, hour: 23, minute: 59 })).toBe(
      'every Monday at 23:59',
    );
    expect(scheduleLabel({ type: 'hours', every: 1 })).toBe('every hour');
    expect(scheduleLabel({ type: 'hours', every: 6 })).toBe('every 6 hours');
  });
});

describe('cronOf', () => {
  it('renders every shape, remapping ISO Sunday (7) to cron Sunday (0)', () => {
    expect(cronOf({ type: 'daily', hour: 4, minute: 0 })).toBe('0 4 * * *');
    expect(cronOf({ type: 'weekdays', hour: 4, minute: 0 })).toBe('0 4 * * 1-5');
    expect(cronOf({ type: 'weekly', day: 7, hour: 4, minute: 0 })).toBe('0 4 * * 0');
    expect(cronOf({ type: 'weekly', day: 3, hour: 4, minute: 0 })).toBe('0 4 * * 3');
    expect(cronOf({ type: 'hours', every: 1 })).toBe('0 * * * *');
    expect(cronOf({ type: 'hours', every: 6 })).toBe('0 */6 * * *');
  });
});
