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
 * is precisely when the set can have moved. The engine also emits a bare `task:changed`
 * when a finished run leaves that set, because the run is removed on `exited` — after the
 * settling event — so the refresh triggered by settling still sees the finished run.
 *
 * This set can only ever ADD a spinner (`runPhase` treats it as a hint and a terminal
 * status overrules it), which is why a stale one showed up as a card claiming to be
 * starting long after its agent had stopped.
 */
import { useEffect, useState } from 'react';

export function useActiveRuns(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    // Several `task:changed` events can land in a row (a chain advancing settles one step
    // and starts the next), so several reads are in flight at once. Their promises are not
    // guaranteed to settle in request order, and an older reply landing last would reinstate
    // a run that has already ended — a spinner that never stops. Only ever accept the newest.
    let issued = 0;
    let applied = 0;
    const refresh = (): void => {
      const seq = ++issued;
      void window.api
        .invoke('scheduler:activeRuns')
        .then((runs) => {
          if (cancelled || seq <= applied) return;
          applied = seq;
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
