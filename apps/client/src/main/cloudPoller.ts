/**
 * The cloud mirror's OWN background timer — a self-scheduling `setTimeout` rather than
 * `SyncPoller`'s `setInterval`, because the wait between ticks changes on every tick:
 * `nextPollDelayMs` (`@tm/protocol/cadence`) folds in the server's own directive, this
 * window's focus state and a run of consecutive failures, so the delay decided after tick
 * N is only ever correct until tick N's response lands.
 *
 * The two rules `SyncPoller`'s header states still hold here — read the cadence fresh on
 * every (re)schedule, and never stack a tick on a sweep still running — "cadence" just
 * means `nextPollDelayMs`'s inputs now, not one fixed number of minutes.
 *
 * `SyncPoller` itself is NOT touched: JIRA and GitLab share its minutes-scale clock, and
 * the cloud mirror's seconds-scale, server-directed one would either starve behind their
 * far slower interval or drag them down to match it. See `syncPoller.ts`'s own header.
 *
 * Deliberately fetch-only at its network edge — no `Store`-shaped assumptions beyond the
 * few methods it's handed, no Electron import — so it can be driven by a mocked `fetch`
 * in a test the same way `GitLabClient` can.
 */
import { CADENCE_MS, nextPollDelayMs } from '@protocol/cadence';
import type { CommandEnvelope, SyncRequest, SyncResponse } from '@protocol/wire';
import type { CloudSettings } from '@shared/settings';
import { buildMirrorDelta } from './cloudDelta';
import { logMain } from './log';
import type { Store } from './store';

/** The one fact about this window `cloudPoller.ts` needs — see `focusTracker.ts`. */
export interface FocusSignal {
  isFocused(): boolean;
  onChange(cb: (focused: boolean) => void): () => void;
}

export interface CloudPollerDeps {
  store: Store;
  focus: FocusSignal;
  /** Read fresh on every (re)schedule and every tick, exactly like `SyncService.isEnabled`. */
  getSettings: () => CloudSettings;
  /** A bearer access token for this tick, or null when not signed in — the tick then
   * fails like any other network error (counted, backed off, retried next time). */
  getAccessToken: () => Promise<string | null>;
  /** Commands the server relayed for this client this tick. Applying them is later work
   * (Phase 25's "Apply queued cloud commands on the client") — this only hands them off. */
  onCommands: (commands: CommandEnvelope[]) => void;
  /** Wraps one tick so the status bar can watch it, exactly as `trackSync` wraps JIRA/GitLab. */
  runTracked: <T>(run: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

/** Outbox rows resolved to entities per request — same order of magnitude as `JIRA_BOARD_LIMIT`. */
const OUTBOX_LIMIT = 200;

export class CloudPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private consecutiveFailures = 0;
  /** The server's last cadence directive, or null before the first successful tick —
   * `computeDelay` seeds from the settings' own interval until one lands. */
  private lastServerIntervalMs: number | null = null;
  private lastPollAt = 0;
  private readonly unsubscribeFocus: () => void;

  constructor(private readonly deps: CloudPollerDeps) {
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

  /**
   * Focusing the window polls now, not in up to `idleIntervalMs` — that immediacy is the
   * whole point of reporting focus at all. But never inside `CADENCE_MS.active`: a burst of
   * alt-tabbing must not turn into a burst of requests, so the next poll is brought forward
   * only as far as one active-tier interval since the last one actually went out.
   */
  private onFocusChange(): void {
    if (!this.timer || this.disposed) return; // not scheduled at all — nothing to bring forward
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;
    const sinceLastPoll = Date.now() - this.lastPollAt;
    this.arm(Math.max(0, CADENCE_MS.active - sinceLastPoll));
  }

  private computeDelay(settings: CloudSettings): number {
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
      logMain('cloud sync failed', e);
    } finally {
      this.running = false;
      // Re-arm from here, not from the caller: a failure's backoff and a success's fresh
      // server interval both have to reach the NEXT delay, and both are only known now.
      this.reschedule();
    }
  }

  private async send(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;

    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const rows = this.deps.store.getCloudDelta(0, OUTBOX_LIMIT);
    const request: SyncRequest = {
      clientId: this.deps.store.loadCloudClientId(),
      cursor: this.deps.store.loadCloudCursor(),
      focused: this.deps.focus.isFocused(),
      deltas: buildMirrorDelta(rows, this.deps.store.getTask, this.deps.store.getProject),
    };

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, '')}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    if (!res.ok) throw new Error(`cloud sync failed (${res.status} ${res.statusText})`);
    const body = (await res.json()) as SyncResponse;

    // Only the rows actually SENT are acked — `rows` may be a capped prefix of a larger
    // outbox (`shapeCloudDelta`'s cap), and every entity left out of it has a strictly
    // higher seq than every one sent, so this can never prune an unsent write.
    if (rows.length > 0) {
      this.deps.store.pruneCloudOutbox(Math.max(...rows.map((r) => r.seq)));
    }
    this.deps.store.saveCloudCursor(body.cursor);
    this.lastServerIntervalMs = body.cadence.intervalMs;
    if (body.commands.length > 0) this.deps.onCommands(body.commands);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribeFocus();
  }
}
