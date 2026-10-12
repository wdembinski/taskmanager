import { describe, expect, it } from 'vitest';
import { bucketUsageDaily, DAY_MS, normalizeDailyOptions, USAGE_DAILY_MAX_DAYS } from './usage';
import type { DailyUsageInput } from './usage';

const iso = (s: string): number => new Date(s).getTime();

const sample = (createdAt: string, overrides: Partial<DailyUsageInput> = {}): DailyUsageInput => ({
  createdAt: iso(createdAt),
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: null,
  ...overrides,
});

describe('bucketUsageDaily — empty input', () => {
  const points = bucketUsageDaily([], {
    days: 5,
    tzOffsetMinutes: 60,
    now: iso('2026-01-10T12:00:00Z'),
  });

  it('yields exactly `days` points, all zeroed', () => {
    expect(points).toHaveLength(5);
    for (const p of points) {
      expect(p.inputTokens).toBe(0);
      expect(p.outputTokens).toBe(0);
      expect(p.cacheReadTokens).toBe(0);
      expect(p.costUsd).toBe(0);
    }
  });

  it('has consecutive dayStarts exactly one day apart', () => {
    for (let i = 1; i < points.length; i++) {
      expect(points[i].dayStart - points[i - 1].dayStart).toBe(DAY_MS);
    }
    expect(DAY_MS).toBe(86_400_000);
  });

  it('ends on today’s local day, with correct date labels', () => {
    expect(points.map((p) => p.date)).toEqual([
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
    ]);
  });
});

describe('bucketUsageDaily — a gap day between two active days', () => {
  it('zero-fills the day with no samples', () => {
    const points = bucketUsageDaily(
      [
        sample('2026-01-08T10:00:00Z', { inputTokens: 100 }),
        sample('2026-01-10T10:00:00Z', { inputTokens: 300 }),
      ],
      { days: 3, tzOffsetMinutes: 0, now: iso('2026-01-10T12:00:00Z') },
    );

    expect(points.map((p) => p.date)).toEqual(['2026-01-08', '2026-01-09', '2026-01-10']);
    expect(points[0].inputTokens).toBe(100);
    expect(points[1].inputTokens).toBe(0);
    expect(points[1].costUsd).toBe(0);
    expect(points[2].inputTokens).toBe(300);
  });
});

describe('bucketUsageDaily — local-midnight boundary', () => {
  it('at +120 (Warsaw summer): 21:59:59.999Z is the prior day, 22:00:00Z is the next', () => {
    const points = bucketUsageDaily(
      [
        sample('2026-06-15T21:59:59.999Z', { inputTokens: 1 }),
        sample('2026-06-15T22:00:00.000Z', { inputTokens: 2 }),
      ],
      { days: 2, tzOffsetMinutes: 120, now: iso('2026-06-16T10:00:00Z') },
    );

    expect(points.map((p) => p.date)).toEqual(['2026-06-15', '2026-06-16']);
    expect(points[0].inputTokens).toBe(1);
    expect(points[1].inputTokens).toBe(2);
  });

  it('at -300 (a negative offset, to catch sign errors): the boundary moves to 05:00Z', () => {
    const points = bucketUsageDaily(
      [
        sample('2026-01-15T04:59:59.999Z', { inputTokens: 1 }),
        sample('2026-01-15T05:00:00.000Z', { inputTokens: 2 }),
      ],
      { days: 2, tzOffsetMinutes: -300, now: iso('2026-01-15T20:00:00Z') },
    );

    expect(points.map((p) => p.date)).toEqual(['2026-01-14', '2026-01-15']);
    expect(points[0].inputTokens).toBe(1);
    expect(points[1].inputTokens).toBe(2);
  });

  it('puts the same UTC instant on different dates for two viewers', () => {
    const instant = iso('2026-01-15T23:30:00Z');

    const east = bucketUsageDaily([sample('2026-01-15T23:30:00Z')], {
      days: 1,
      tzOffsetMinutes: 120,
      now: instant,
    });
    const west = bucketUsageDaily([sample('2026-01-15T23:30:00Z')], {
      days: 1,
      tzOffsetMinutes: -300,
      now: instant,
    });

    expect(east[0].date).toBe('2026-01-16');
    expect(west[0].date).toBe('2026-01-15');
  });
});

describe('bucketUsageDaily — cost null vs zero', () => {
  const points = bucketUsageDaily(
    [
      sample('2026-01-08T09:00:00Z', { costUsd: null }),
      sample('2026-01-08T15:00:00Z', { costUsd: null }),
      sample('2026-01-09T09:00:00Z', { costUsd: null }),
      sample('2026-01-09T12:00:00Z', { costUsd: 0.25 }),
      sample('2026-01-09T18:00:00Z', { costUsd: 0.5 }),
    ],
    { days: 3, tzOffsetMinutes: 0, now: iso('2026-01-10T12:00:00Z') },
  );

  it('a day of only null-cost rows is null', () => {
    expect(points[0].date).toBe('2026-01-08');
    expect(points[0].costUsd).toBeNull();
  });

  it('a day with null + 0.25 + 0.5 sums the known costs to 0.75', () => {
    expect(points[1].date).toBe('2026-01-09');
    expect(points[1].costUsd).toBe(0.75);
  });

  it('an empty day is 0, not null', () => {
    expect(points[2].date).toBe('2026-01-10');
    expect(points[2].costUsd).toBe(0);
    expect(points[2].costUsd).not.toBeNull();
  });
});

describe('normalizeDailyOptions', () => {
  it('floors a fractional days and clamps it to [1, USAGE_DAILY_MAX_DAYS]', () => {
    expect(normalizeDailyOptions({ days: 5.9, tzOffsetMinutes: 0 }).days).toBe(5);
    expect(normalizeDailyOptions({ days: 0, tzOffsetMinutes: 0 }).days).toBe(1);
    expect(normalizeDailyOptions({ days: -3, tzOffsetMinutes: 0 }).days).toBe(1);
    expect(normalizeDailyOptions({ days: 1_000, tzOffsetMinutes: 0 }).days).toBe(
      USAGE_DAILY_MAX_DAYS,
    );
  });

  it('clamps tzOffsetMinutes to ±14h', () => {
    expect(normalizeDailyOptions({ days: 1, tzOffsetMinutes: 10_000 }).tzOffsetMinutes).toBe(
      14 * 60,
    );
    expect(normalizeDailyOptions({ days: 1, tzOffsetMinutes: -10_000 }).tzOffsetMinutes).toBe(
      -14 * 60,
    );
  });

  it('leaves in-range values untouched', () => {
    expect(normalizeDailyOptions({ days: 30, tzOffsetMinutes: 120 })).toEqual({
      days: 30,
      tzOffsetMinutes: 120,
    });
  });

  it('throws on non-finite input rather than silently defaulting', () => {
    expect(() => normalizeDailyOptions({ days: Number.NaN, tzOffsetMinutes: 0 })).toThrow();
    expect(() =>
      normalizeDailyOptions({ days: 1, tzOffsetMinutes: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });
});

describe('bucketUsageDaily — out-of-window samples are dropped', () => {
  it('drops samples older than the window and samples in the future', () => {
    const points = bucketUsageDaily(
      [
        sample('2025-01-01T00:00:00Z', { inputTokens: 999 }),
        sample('2026-02-01T00:00:00Z', { inputTokens: 888 }),
      ],
      { days: 3, tzOffsetMinutes: 0, now: iso('2026-01-10T12:00:00Z') },
    );

    expect(points.map((p) => p.date)).toEqual(['2026-01-08', '2026-01-09', '2026-01-10']);
    for (const p of points) {
      expect(p.inputTokens).toBe(0);
    }
  });
});
