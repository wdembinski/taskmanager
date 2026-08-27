/**
 * True only once `value` has held true for `delayMs` — false immediately on the falling
 * edge. Asymmetric on purpose: it exists to stop a skeleton flashing for one frame on a
 * load that turns out to be fast, not to smooth over a load ending, which should read as
 * "done" the instant it is.
 */
import { useEffect, useState } from 'react';

export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!value) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return delayed;
}
