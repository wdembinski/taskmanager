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
 * and never stack a tick on a sweep that is still running.
 */
import { logMain } from './log';
import type { Store } from './store';

/** One thing a tick refreshes. `run` is the same body the manual button invokes. */
export interface SyncService {
  id: string;
  /** Read fresh per tick: an integration switched off mid-run must stop being swept. */
  isEnabled: (store: Store) => boolean;
  run: () => Promise<unknown>;
}

export class SyncPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow sweep overlapping the next tick. */
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly services: readonly SyncService[],
  ) {}

  /** (Re)arm from current settings. No-op while the interval is 0 ("off"). */
  reschedule(): void {
    this.stop();
    const minutes = Math.max(0, Math.round(this.store.getSettings().syncIntervalMinutes ?? 0));
    if (minutes <= 0) return; // 0 = off; the manual Sync button still works.
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
  }

  /** Sweep every enabled service once. Exposed for tests; the timer calls it. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.services.filter((s) => s.isEnabled(this.store));
      // `allSettled`, not `all`: one integration being unreachable must not cancel the
      // others, and a background poll must never crash the app. A rejection here is a tick
      // skipped for that one service — the next one retries, and the status bar already
      // carries the reason (see `trackSync`).
      const results = await Promise.allSettled(due.map((s) => s.run()));
      results.forEach((r, i) => {
        // To file, because nobody is watching a console when this fires.
        if (r.status === 'rejected') logMain(`${due[i].id} background sync failed`, r.reason);
      });
    } finally {
      this.running = false;
    }
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
