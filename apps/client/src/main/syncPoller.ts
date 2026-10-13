/**
 * The background sync timer — **one of them**, for every integration.
 *
 * JIRA and GitLab used to own a poller each, on their own interval, and that was two of
 * everything for one idea: two settings to keep in step, two timers firing at unrelated
 * moments, and a status bar that could only answer "how fresh is this board" one tracker at
 * a time. There is no version of "up to date" that is true of the tickets and not of the
 * merge requests, so the app has no business holding two answers.
 *
 * One tick sweeps every registered service. They run **concurrently and independently**: a
 * JIRA instance that has gone slow must not delay the GitLab refresh behind it, and a
 * service that throws must not cost the sweep the ones that would have succeeded.
 *
 * The lifecycle rules are the two the old pair had, and they are the ones that matter:
 * read the interval fresh on every (re)schedule, so a Settings change takes effect at once;
 * and never stack a tick on a sweep that is still running — now tracked **per service**, so
 * one slow or backed-off integration no longer holds up the others on the next tick.
 */
import { clampSyncInterval } from '@shared/settings';
import { logMain } from './log';
import type { Store } from './store';

/** One thing a tick refreshes. `run` is the same body the manual button invokes. */
export interface SyncService {
  id: string;
  /** Read fresh per tick: an integration switched off mid-run must stop being swept. */
  isEnabled: (store: Store) => boolean;
  run: () => Promise<unknown>;
  /** Given a rejection from `run`, the epoch ms before which this service must not be swept
   *  again — or null for no back-off. Absent entirely for services with no such concept. */
  backoffUntil?: (error: unknown) => number | null;
}

export class SyncPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Services a sweep must skip because their own back-off has not passed yet. */
  private readonly pausedUntil = new Map<string, number>();
  /** Guards against a slow sweep overlapping the next tick, per service. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly services: readonly SyncService[],
  ) {}

  /**
   * (Re)arm from current settings. No-op while the interval is 0 ("off").
   *
   * `clampSyncInterval`, not a bare `Math.max(0, Math.round(...))`: a value past
   * `MAX_SYNC_INTERVAL_MINUTES` overflows `setInterval`'s 32-bit delay, and the runtime
   * clamps THAT silently to ~1ms rather than throwing — turning an oversized interval into
   * a sync that never stops. Guarding here, not just in the Settings screens that write it,
   * because a value can reach the store from before this guard existed or from a synced
   * blob this build did not write itself.
   */
  reschedule(): void {
    this.stop();
    const minutes = clampSyncInterval(this.store.getSettings().syncIntervalMinutes ?? 0);
    if (minutes <= 0) return; // 0 = off; the manual Sync button still works.
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
  }

  /** Sweep every enabled, non-paused, non-in-flight service once. Exposed for tests; the
   *  timer calls it. */
  async tick(): Promise<void> {
    const now = Date.now();
    const due = this.services.filter((s) => {
      if (!s.isEnabled(this.store)) return false;
      if (this.inFlight.has(s.id)) return false;
      const until = this.pausedUntil.get(s.id);
      return until === undefined || now >= until;
    });
    // Each service's own state update is chained off ITS run() directly, not off a
    // `Promise.allSettled` over the whole batch: a service that never settles must not
    // delay clearing `inFlight` for the others once theirs resolve, and must not stop this
    // tick's promise standing for "every due service was launched".
    due.forEach((s) => {
      this.inFlight.add(s.id);
      s.run().then(
        () => {
          this.inFlight.delete(s.id);
          this.pausedUntil.delete(s.id);
        },
        (error: unknown) => {
          this.inFlight.delete(s.id);
          // To file, because nobody is watching a console when this fires.
          logMain(`${s.id} background sync failed`, error);
          const until = s.backoffUntil?.(error) ?? null;
          if (until === null) this.pausedUntil.delete(s.id);
          else this.pausedUntil.set(s.id, until);
        },
      );
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
  }
}
