/**
 * The task ids the engine currently has a run for.
 *
 * `runPhase` needs this because a run's existence is not derivable from `Task`:
 * `task:assignAgent` persists `status: 'pending'` and only *then* calls `runTask`, so the
 * task that patches the card says `pending` while a session is already spawning. That
 * window is exactly the "it's clearly working but there's no spinner" complaint. Once an
 * agent can be assigned *without* being started, `assigned + pending` also becomes a
 * legitimate resting state — so status alone can no longer tell the two apart at all.
 *
 * Re-read on `task:changed` rather than polled: `scheduler:activeRuns` is an in-memory
 * snapshot (`Scheduler.activeRuns`), so the call is essentially free, and a task changing
 * is precisely when the set can have moved.
 */
import { useEffect, useState } from 'react';

export function useActiveRuns(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void window.api
        .invoke('scheduler:activeRuns')
        .then((runs) => {
          if (cancelled) return;
          setIds((prev) => {
            const next = new Set(runs.map((r) => r.taskId));
            // Same membership → same object, so consumers memoised on this set don't
            // re-render on every unrelated task change.
            if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
            return next;
          });
        })
        .catch(() => undefined);
    };
    refresh();
    const off = window.api.on('task:changed', refresh);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return ids;
}
