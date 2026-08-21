/**
 * The web app's own read loop — `GET /v1/board?since=<cursor>` on the same self-scheduling
 * `setTimeout` shape as `apps/client/src/main/cloudPoller.ts`'s `CloudPoller` (that file's
 * own header explains why a fixed `setInterval` is wrong here: the wait between ticks
 * changes on every tick, from `@tm/protocol/cadence`'s `nextPollDelayMs`).
 *
 * The difference from `CloudPoller` is the request itself: this app keeps no local mirror
 * to build a `SyncRequest.deltas` from (a browser tab is a read-only view — see
 * `BoardResponse`'s own docstring), so there is nothing to push. `X-TM-Client-Id` and
 * `X-TM-Focus` carry this session's presence beat instead of a request body, since a GET
 * has none — see `@tm/protocol/wire`'s `BOARD_CLIENT_HEADER`/`BOARD_FOCUS_HEADER`.
 */
import { CADENCE_MS, nextPollDelayMs } from '@tm/protocol/cadence';
import { BOARD_CLIENT_HEADER, BOARD_FOCUS_HEADER, type BoardResponse } from '@tm/protocol/wire';

/** The one fact about this tab `BoardPoller` needs — see `focusSignal.ts`. */
export interface FocusSignal {
  isFocused(): boolean;
  onChange(cb: (focused: boolean) => void): () => void;
}

export interface BoardPollerDeps {
  apiBase: string;
  clientId: string;
  focus: FocusSignal;
  /** A bearer access token for this tick, or null when not signed in — the tick then fails
   *  like any other network error (counted, backed off, retried next time). */
  getAccessToken: () => Promise<string | null>;
  /** Read fresh on every tick, exactly like `CloudPoller`'s `store.loadCloudCursor`. */
  getCursor: () => string | null;
  onResponse: (response: BoardResponse) => void;
  onError?: (error: unknown) => void;
  /** A request is now in flight, or has just settled — the status bar's claim, which is
   *  about a request in flight, not about what `onResponse`/`onError` last said. */
  onPollingChange?: (polling: boolean) => void;
  fetchImpl?: typeof fetch;
  random?: () => number;
  /** Seed intervals before the first server directive has been heard back. Matches
   *  `@tm/protocol/cadence`'s own `CADENCE_MS` out of the box. */
  jitterRatio?: number;
}

export class BoardPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private consecutiveFailures = 0;
  private lastServerIntervalMs: number | null = null;
  private lastPollAt = 0;
  /**
   * Set when the last read said there were more rows past its cursor
   * (`BoardResponse.hasMore`), which makes the next poll immediate instead of one cadence
   * interval away.
   *
   * The read side is capped now (`MirrorService.BOARD_PAGE_LIMIT`), so a first poll against
   * a mature board comes back in several bounded trips rather than one unbounded one. Left
   * to the ordinary cadence, that catch-up would take a page every 2.5 seconds and the board
   * would visibly fill in over a minute.
   */
  private catchingUp = false;
  private readonly unsubscribeFocus: () => void;

  constructor(private readonly deps: BoardPollerDeps) {
    this.unsubscribeFocus = deps.focus.onChange(() => this.onFocusChange());
  }

  /** (Re)arm from the last known server cadence, or the active/idle seed before one exists. */
  reschedule(): void {
    this.clearTimer();
    if (this.disposed) return;
    this.arm(this.computeDelay());
  }

  /** Same immediacy rule as `CloudPoller.onFocusChange` — see its own docstring. */
  private onFocusChange(): void {
    if (!this.timer || this.disposed) return;
    const sinceLastPoll = Date.now() - this.lastPollAt;
    this.arm(Math.max(0, CADENCE_MS.active - sinceLastPoll));
  }

  private computeDelay(): number {
    // Mid-catch-up the cadence is not the question: there is known, already-committed data
    // waiting, and the only reason to wait at all is to yield the event loop.
    if (this.catchingUp && this.consecutiveFailures === 0) return 0;
    const serverIntervalMs =
      this.lastServerIntervalMs ??
      (this.deps.focus.isFocused() ? CADENCE_MS.active : CADENCE_MS.idle);
    return nextPollDelayMs({
      serverIntervalMs,
      localFocused: this.deps.focus.isFocused(),
      consecutiveFailures: this.consecutiveFailures,
      jitterRatio: this.deps.jitterRatio ?? 0.1,
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
    this.deps.onPollingChange?.(true);
    this.lastPollAt = Date.now();
    try {
      await this.send();
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      this.deps.onError?.(e);
    } finally {
      this.running = false;
      this.deps.onPollingChange?.(false);
      this.reschedule();
    }
  }

  private async send(): Promise<void> {
    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const cursor = this.deps.getCursor();
    const url = new URL('/v1/board', this.deps.apiBase);
    if (cursor) url.searchParams.set('since', cursor);

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(url.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        [BOARD_CLIENT_HEADER]: this.deps.clientId,
        [BOARD_FOCUS_HEADER]: String(this.deps.focus.isFocused()),
      },
    });
    if (!res.ok) throw new Error(`board read failed (${res.status} ${res.statusText})`);
    const body = (await res.json()) as BoardResponse;

    this.lastServerIntervalMs = body.cadence.intervalMs;
    this.catchingUp = body.hasMore === true;
    this.deps.onResponse(body);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribeFocus();
  }
}
