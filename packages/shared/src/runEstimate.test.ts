import { describe, expect, it } from 'vitest';
import { estimateRun, type RunEstimateStats } from './runEstimate';

const stats = (overrides: Partial<RunEstimateStats> = {}): RunEstimateStats => ({
  sessionCount: 40,
  costPerSessionUsd: { low: 0.9, high: 1.3 },
  minutesPerSession: 5.7,
  ...overrides,
});

describe('estimateRun', () => {
  it('builds the v11-4 line for a six-step run', () => {
    expect(estimateRun(stats(), 6)).toEqual({
      cost: '$6–12',
      sessions: '7–9 sessions',
      duration: '~40 min',
    });
  });

  it('returns null when there is no history', () => {
    expect(estimateRun(null, 6)).toBeNull();
    expect(estimateRun(undefined, 6)).toBeNull();
    expect(estimateRun(stats({ sessionCount: 0 }), 6)).toBeNull();
  });

  it('returns null for figures that are not numbers', () => {
    expect(estimateRun(stats({ minutesPerSession: Number.NaN }), 6)).toBeNull();
    expect(estimateRun(stats({ costPerSessionUsd: { low: 1, high: Infinity } }), 6)).toBeNull();
    expect(estimateRun(stats(), Number.NaN)).toBeNull();
  });

  it('counts the plan alone for a card with no steps yet', () => {
    expect(estimateRun(stats(), 0)?.sessions).toBe('1–3 sessions');
    expect(estimateRun(stats(), -2)?.sessions).toBe('1–3 sessions');
  });

  it('rounds the cost outward to whole dollars, and collapses an empty range', () => {
    expect(estimateRun(stats({ costPerSessionUsd: { low: 0.33, high: 0.34 } }), 2)?.cost).toBe(
      '$0–2',
    );
    expect(estimateRun(stats({ costPerSessionUsd: { low: 0, high: 0 } }), 2)?.cost).toBe('$0');
  });

  it('reads a swapped low/high the right way round', () => {
    expect(estimateRun(stats({ costPerSessionUsd: { low: 1.3, high: 0.9 } }), 6)?.cost).toBe(
      '$6–12',
    );
  });

  it('keeps a short run in whole minutes rather than rounding it to nothing', () => {
    expect(estimateRun(stats({ minutesPerSession: 1 }), 1)?.duration).toBe('~2 min');
    expect(estimateRun(stats({ minutesPerSession: 0.1 }), 0)?.duration).toBe('~1 min');
  });
});
