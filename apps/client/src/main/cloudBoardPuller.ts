/**
 * The desktop's own read half of the cloud mirror — `GET /v1/board?since=<cursor>`, on the
 * same self-scheduling `setTimeout` shape as `cloudPoller.ts`'s `CloudPoller` and apps/web's
 * `BoardPoller` (that file's own header explains why a fixed `setInterval` is wrong here).
 *
 * A SEPARATE POLLER, NOT A SECOND FETCH BOLTED ONTO `CloudPoller.send()`
 * -----------------------------------------------------------------------
 * `CloudPoller` only ever PUSHED: `POST /v1/sync` carries this desktop's outbox up and gets
 * back commands, never task/project rows. That is exactly right for what it was built for —
 * a desktop's own edits — but it means nothing ever taught this app to read back a row that
 * originated elsewhere: a second desktop's edit, or (Phase 27) a ticket created straight
 * through the server's own CRUD API and never relayed as a command at all. `GET /v1/board`
 * already answers that (apps/web's own read path); this class is the same request, issued
 * from the desktop's own clock, applied to the local SQLite mirror instead of to React state.
 *
 * It runs on its own timer beside `CloudPoller`'s rather than inside it so the two can never
 * interfere: `CloudPoller.send()`'s push, its 413 backoff and its outbox pruning are exactly
 * as they were before this file existed, and a board pull failing (a network blip, a stale
 * token) backs off on its own schedule without touching the push cadence at all.
 */
import { CADENCE_MS, nextPollDelayMs } from '@protocol/cadence';
import { BOARD_CLIENT_HEADER, BOARD_FOCUS_HEADER, type BoardResponse } from '@protocol/wire';
import type { CloudSettings } from '@shared/settings';
import { applyCloudBoardDelta } from './cloudBoardApply';
import type { FocusSignal } from './cloudPoller';
import { logMain } from './log';
import type { Store } from './store';

export interface CloudBoardPullerDeps {
  store: Store;
  focus: FocusSignal;
  /** Read fresh on every (re)schedule and every tick, exactly like `CloudPoller`. */
  getSettings: () => CloudSettings;
  /** A bearer access token for this tick, or null when not signed in — the tick then fails
   *  like any other network error (counted, backed off, retried next time). */
  getAccessToken: () => Promise<string | null>;
  /** Wraps one tick so the status bar can watch it, exactly as `CloudPoller` does. */
  runTracked: <T>(run: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

export class CloudBoardPuller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private consecutiveFailures = 0;
  private lastServerIntervalMs: number | null = null;
  private lastPollAt = 0;
  /**
   * Set when the last read said there were more rows past its cursor
   * (`BoardResponse.hasMore`), which makes the next poll immediate instead of one cadence
   * interval away — see `MirrorService.BOARD_PAGE_LIMIT`.
   */
  private catchingUp = false;
  private readonly unsubscribeFocus: () => void;

  constructor(private readonly deps: CloudBoardPullerDeps) {
    this.unsubscribeFocus = deps.focus.onChange(() => this.onFocusChange());
  }

  /** (Re)arm from current settings. No-op while cloud sync is off or has no server to poll. */
  reschedule(): void {
    this.clearTimer();
    if (this.disposed) return;
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;
    this.arm(this.computeDelay(settings));
  }

  /** Same immediacy rule as `CloudPoller.onFocusChange` — see its own docstring. */
  private onFocusChange(): void {
    if (!this.timer || this.disposed) return;
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;
    const sinceLastPoll = Date.now() - this.lastPollAt;
    this.arm(Math.max(0, CADENCE_MS.active - sinceLastPoll));
  }

  private computeDelay(settings: CloudSettings): number {
    // Mid-catch-up the cadence is not the question: there is known, already-committed data
    // waiting, and the only reason to wait at all is to yield the event loop.
    if (this.catchingUp && this.consecutiveFailures === 0) return 0;
    const serverIntervalMs =
      this.lastServerIntervalMs ??
      (this.deps.focus.isFocused() ? settings.activeIntervalMs : settings.idleIntervalMs);
    return nextPollDelayMs({
      serverIntervalMs,
      localFocused: this.deps.focus.isFocused(),
      consecutiveFailures: this.consecutiveFailures,
      jitterRatio: settings.jitterRatio,
      random: this.deps.random ?? Math.random,
    });
  }

  private arm(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One request/response round trip. Exposed for tests; the timer calls it. */
  async tick(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastPollAt = Date.now();
    try {
      await this.deps.runTracked(() => this.send());
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      logMain('cloud board pull failed', e);
    } finally {
      this.running = false;
      this.reschedule();
    }
  }

  private async send(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;

    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const cursor = this.deps.store.loadCloudBoardCursor();
    const url = new URL('/v1/board', settings.baseUrl);
    if (cursor) url.searchParams.set('since', cursor);

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(url.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        [BOARD_CLIENT_HEADER]: this.deps.store.loadCloudClientId(),
        [BOARD_FOCUS_HEADER]: String(this.deps.focus.isFocused()),
      },
    });
    if (!res.ok) throw new Error(`cloud board pull failed (${res.status} ${res.statusText})`);
    const body = (await res.json()) as BoardResponse;

    applyCloudBoardDelta(this.deps.store, body.deltas);
    // Saved only once the delta above has actually landed — a crash between the two would
    // simply re-read the same page next tick, which `applyCloudBoardDelta` handles for free
    // (an upsert of a row already at the current state is a no-op in effect).
    this.deps.store.saveCloudBoardCursor(body.cursor);
    this.lastServerIntervalMs = body.cadence.intervalMs;
    this.catchingUp = body.hasMore === true;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribeFocus();
  }
}
