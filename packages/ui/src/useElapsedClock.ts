/**
 * A millisecond clock that only ticks once a second while `active` is true — the board's
 * elapsed-time chips need "now" to move, but a board with nothing running must not re-render
 * every card every second for no visible change.
 */
import { useEffect, useState } from 'react';

export function useElapsedClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  return now;
}
