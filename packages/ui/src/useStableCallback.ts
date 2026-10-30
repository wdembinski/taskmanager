/**
 * A callback whose identity never changes but which always calls the newest `fn` — the
 * latest-ref pattern. What lets a memoised child (`BoardCardRow`) take a host's handler
 * without the host having to `useCallback` it: an inline arrow passed in on every render
 * still reaches the child as the same function.
 *
 * Absence is the caller's to keep: many of the board's handlers hide a button by being
 * absent, so pass `props.onX && stable`, never the stable wrapper alone.
 */
import { useCallback, useRef } from 'react';

export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current?.(...args) as R, []);
}
