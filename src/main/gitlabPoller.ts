/**
 * GitLab background poller — `JiraPoller` with a different setting behind it.
 *
 * Its own interval rather than sharing JIRA's, and a faster default (2 minutes): a
 * ticket's status changes on a human timescale, but a pipeline turns red on a machine's,
 * and a red pipeline you learn about ten minutes later has already cost you the context
 * you needed to fix it.
 *
 * Same lifecycle rules as the JIRA one: read the interval fresh on every (re)schedule so
 * a Settings change takes effect at once, never stack a tick on a slow sync, and never
 * let a failed poll reach the user as anything louder than a log line.
 */
import { logMain } from './log';
import type { Store } from './store';

export class GitLabPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow sync overlapping the next tick. */
  private running = false;

  constructor(
    private readonly store: Store,
    /** Runs one sync (same body as the `gitlab:sync` handler). */
    private readonly runSync: () => Promise<unknown>,
  ) {}

  /** (Re)arm from current settings. No-op while GitLab is off or the interval is 0. */
  reschedule(): void {
    this.stop();
    const { gitlab } = this.store.getSettings();
    if (!gitlab.enabled) return;
    const minutes = Math.max(0, Math.round(gitlab.pollIntervalMinutes ?? 0));
    if (minutes <= 0) return; // 0 = off; the manual sync still works.
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runSync();
    } catch (err) {
      // A background poll must never crash the app: a bad token or a dropped network
      // just means this tick is skipped, and the next one retries. To file, because
      // nobody is watching a console when it fires.
      logMain('GitLab background sync failed', err);
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
