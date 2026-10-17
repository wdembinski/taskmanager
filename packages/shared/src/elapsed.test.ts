import { describe, expect, it } from 'vitest';
import { formatElapsed } from './elapsed';

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [1_000, '1s'],
    [42_000, '42s'],
    [59_000, '59s'],
    [60_000, '1m 00s'],
    [252_000, '4m 12s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 00m'],
    [3_780_000, '1h 03m'],
    [7_384_000, '2h 03m'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });

  it('never goes negative, even when the clock is behind startedAt', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});
