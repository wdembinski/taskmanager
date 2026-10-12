import { describe, expect, it } from 'vitest';
import type { DailyUsagePoint } from '@tm/shared/usage';
import {
  formatTrendValue,
  trendPath,
  trendPeak,
  trendValues,
  TREND_DAYS,
  TREND_METRICS,
  viewerTzOffsetMinutes,
} from './dailyTrend';

const point = (overrides: Partial<DailyUsagePoint>): DailyUsagePoint => ({
  dayStart: 0,
  date: '2026-01-01',
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  ...overrides,
});

describe('TREND_METRICS / TREND_DAYS', () => {
  it('lists cost, input and output in order', () => {
    expect(TREND_METRICS).toEqual([
      { id: 'cost', label: 'Cost' },
      { id: 'input', label: 'Input' },
      { id: 'output', label: 'Output' },
    ]);
  });

  it('defaults the backfill window to 30 days', () => {
    expect(TREND_DAYS).toBe(30);
  });
});

describe('viewerTzOffsetMinutes', () => {
  it('negates Date#getTimezoneOffset (east-of-UTC sign convention)', () => {
    const now = { getTimezoneOffset: () => 300 } as Date;
    expect(viewerTzOffsetMinutes(now)).toBe(-300);
  });
});

describe('trendValues', () => {
  const points = [
    point({ costUsd: 1.5, inputTokens: 10, outputTokens: 20 }),
    point({ costUsd: null, inputTokens: 30, outputTokens: 40 }),
    point({ costUsd: 0, inputTokens: 0, outputTokens: 0 }),
  ];

  it('picks cost, keeping null for an unpriced day and 0 for an empty day', () => {
    expect(trendValues(points, 'cost')).toEqual([1.5, null, 0]);
  });

  it('picks input tokens, always numbers', () => {
    expect(trendValues(points, 'input')).toEqual([10, 30, 0]);
  });

  it('picks output tokens, always numbers', () => {
    expect(trendValues(points, 'output')).toEqual([20, 40, 0]);
  });
});

describe('trendPeak', () => {
  it('ignores nulls and returns the max of what is left', () => {
    expect(trendPeak([1, null, 5, null, 3])).toBe(5);
  });

  it('is 0 when every value is null', () => {
    expect(trendPeak([null, null])).toBe(0);
  });

  it('is 0 for an empty series', () => {
    expect(trendPeak([])).toBe(0);
  });
});

describe('formatTrendValue', () => {
  it('shows an em dash for null, never $0.00', () => {
    expect(formatTrendValue('cost', null)).toBe('—');
    expect(formatTrendValue('input', null)).toBe('—');
  });

  it('formats a real zero cost as $0.0000, not a dash', () => {
    expect(formatTrendValue('cost', 0)).toBe('$0.0000');
  });

  it('formats cost with formatCost', () => {
    expect(formatTrendValue('cost', 12.3)).toBe('$12.30');
  });

  it('formats tokens with formatTokens', () => {
    expect(formatTrendValue('input', 9500)).toBe('9.5k');
    expect(formatTrendValue('output', 942)).toBe('942');
  });
});

describe('trendPath', () => {
  it('is empty for 0 points', () => {
    expect(trendPath([], 100, 50, 0, 0)).toEqual({ line: '', area: '' });
  });

  it('is empty for 1 point', () => {
    expect(trendPath([5], 100, 50, 0, 0)).toEqual({ line: '', area: '' });
  });

  it('draws one unbroken M/L run when there are no nulls', () => {
    const { line, area } = trendPath([0, 10, 5], 100, 50, 0, 0);
    expect(line.match(/M /g)).toHaveLength(1);
    expect(line.match(/L /g)).toHaveLength(2);
    expect(area).not.toBe('');
    expect(area.endsWith('Z')).toBe(true);
  });

  it('breaks into two M segments around a null', () => {
    const { line } = trendPath([1, null, 2, 3], 100, 50, 0, 0);
    expect(line.match(/M /g)).toHaveLength(2);
  });

  it('closes each multi-point segment into its own area piece', () => {
    const { area } = trendPath([1, null, 2, 3], 100, 50, 0, 0);
    expect(area.match(/Z/g)).toHaveLength(1);
  });

  it('leaves out a lone point stranded between nulls from the area', () => {
    const { line, area } = trendPath([1, null, 2, null, 3], 100, 50, 0, 0);
    expect(line.match(/M /g)).toHaveLength(3);
    expect(area).toBe('');
  });
});
