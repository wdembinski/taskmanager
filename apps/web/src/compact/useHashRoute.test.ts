import { describe, expect, it } from 'vitest';
import { stableRouteFor } from './useHashRoute';

describe('stableRouteFor', () => {
  it('returns the SAME route object for the same hash across repeated calls', () => {
    const a = stableRouteFor('#/board/todo');
    const b = stableRouteFor('#/board/todo');
    expect(a).toBe(b);
  });

  it('returns a new route once the hash actually changes', () => {
    stableRouteFor('#/board/todo');
    const before = stableRouteFor('#/board/todo');
    const after = stableRouteFor('#/search');
    expect(after).not.toBe(before);
    expect(after).toEqual({ kind: 'search' });
  });

  it('caches the fallback for an unparseable hash too', () => {
    const a = stableRouteFor('#/not-a-real-route');
    const b = stableRouteFor('#/not-a-real-route');
    expect(a).toBe(b);
    expect(a).toEqual({ kind: 'inbox' });
  });
});
