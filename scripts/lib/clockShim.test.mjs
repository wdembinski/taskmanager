/**
 * Collected by the root `vitest.config.ts` the same way `shotChecks.test.mjs` is. Evaluates
 * `clockShimSource` in a fresh `vm` context, so the shim replaces that context's own `Date`
 * and never this process's.
 */
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { clockShimSource } from './clockShim.mjs';

const CLOCK = Date.UTC(2026, 0, 15, 12, 0, 0);

function shimmedContext(clock) {
  const context = createContext({ performance });
  runInContext(clockShimSource(clock), context);
  return context;
}

describe('clockShimSource', () => {
  it('starts Date.now() and a no-arg new Date() at the clock', () => {
    const context = shimmedContext(CLOCK);
    expect(Math.abs(runInContext('Date.now()', context) - CLOCK)).toBeLessThan(1000);
    expect(Math.abs(runInContext('new Date().getTime()', context) - CLOCK)).toBeLessThan(1000);
  });

  it('leaves an explicit construction and the other statics untouched', () => {
    const context = shimmedContext(CLOCK);
    expect(runInContext('new Date(0).getTime()', context)).toBe(0);
    expect(runInContext('Date.UTC(2020, 0, 1)', context)).toBe(Date.UTC(2020, 0, 1));
    expect(runInContext('new Date(0) instanceof Date', context)).toBe(true);
  });

  it('is empty for a row without a clock', () => {
    expect(clockShimSource(undefined)).toBe('');
    expect(clockShimSource(null)).toBe('');
  });
});
