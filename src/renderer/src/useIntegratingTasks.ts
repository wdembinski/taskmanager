/**
 * The task ids whose branch the engine is merging right now.
 *
 * A merge is the only long job in the app that changes NOTHING while it runs: pressing
 * "Merge branch" starts a rebase onto a moving base and a fast-forward that can take a
 * minute, and until it settles there is no run, no status change and no streamed line — so
 * every surface showed the card resting and the button read as one that had done nothing.
 * This is the missing fact, and `runPhase` turns it into the spinner and the words.
 *
 * Pushed rather than polled, and unlike `useActiveRuns` it does NOT re-read on
 * `task:changed`: there is no task change to react to (that is the whole problem), so the
 * engine sends the whole set whenever it moves. The initial fetch is only for a board that
 * mounts while a merge is already under way.
 */
import { useEffect, useState } from 'react';

/** Same membership → same object, so consumers memoised on the set don't re-render. */
function sameIds(prev: ReadonlySet<string>, next: Set<string>): boolean {
  return prev.size === next.size && [...next].every((id) => prev.has(id));
}

export function useIntegratingTasks(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    let pushed = false;
    const apply = (taskIds: readonly string[]): void => {
      if (cancelled) return;
      setIds((prev) => {
        const next = new Set(taskIds);
        return sameIds(prev, next) ? prev : next;
      });
    };
    // Subscribed BEFORE the seeding fetch, so a merge that starts while that fetch is in
    // flight cannot fall between the two — and the seed is then dropped, because a reply
    // describing an earlier moment would otherwise undo the push that overtook it. Each
    // message carries the whole set, so the newest is always the complete truth.
    const off = window.api.on('task:integrating', (taskIds) => {
      pushed = true;
      apply(taskIds);
    });
    void window.api
      .invoke('scheduler:integrating')
      .then((taskIds) => {
        if (!pushed) apply(taskIds);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return ids;
}
