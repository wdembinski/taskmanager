/**
 * JIRA background poller.
 *
 * Fetches new/changed JIRA issues onto the Personal board on a timer, so the board
 * stays fresh without the user clicking "Sync JIRA". It reuses the exact same sync
 * path as the manual button (which pushes `project:tasksChanged`), so the renderer
 * needs no changes — a background tick updates the board live.
 *
 * The cadence is the JIRA setting `pollIntervalMinutes` (0 = off). Read fresh on
 * every (re)schedule, so changing it in Settings takes effect immediately via the
 * `settings:save` handler calling `reschedule()`. Mirrors `PlanWatcher`'s lifecycle
 * (constructed at engine boot, `dispose()`d on quit).
 */
import { logMain } from './log';
import type { Store } from './store';

export class JiraPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow sync overlapping the next tick. */
  private running = false;

  constructor(
    private readonly store: Store,
    /** Runs one sync (same body as the `jira:sync` handler). */
    private readonly runSync: () => Promise<unknown>,
  ) {}

  /**
   * (Re)arm the timer from current settings. Call once at boot and again whenever
   * settings change. No-op (and stops any running timer) when JIRA is disabled or
   * the interval is 0 ("off").
   */
  reschedule(): void {
    this.stop();
    const { jira } = this.store.getSettings();
    if (!jira.enabled) return;
    const minutes = Math.max(0, Math.round(jira.pollIntervalMinutes ?? 0));
    if (minutes <= 0) return; // 0 = off; the manual Sync button still works.
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // don't stack a new sync on top of a slow one
    this.running = true;
    try {
      await this.runSync();
    } catch (err) {
      // A background poll must never crash the app — a bad token/network just
      // means this tick is skipped; the next one (or a manual Sync) retries.
      // Logged to file because nobody is watching a console when this fires.
      logMain('JIRA background sync failed', err);
    } finally {
      this.running = false;
    }
  }

  /** Stop the timer (kept re-armable via `reschedule`). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stop for good (app shutdown). */
  dispose(): void {
    this.stop();
  }
}
