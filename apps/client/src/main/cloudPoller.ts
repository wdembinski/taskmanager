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
import type { CommandEnvelope, CommandResult, SyncRequest, SyncResponse } from '@protocol/wire';
import { PROTOCOL_VERSION } from '@protocol/wire';
import type { CloudSettings } from '@shared/settings';
import { SYNC_BYTES_LIMIT, buildMirrorDeltaWithin } from './cloudDelta';
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
  /**
   * Commands the server relayed for this client this tick. `CloudPoller` only hands them
   * off — applying them (`cloudCommands.ts`, drained by `main/commandQueue.ts` and wired in
   * `ipc.ts`) is the caller's job, and acking them back (`Store`'s applied-command ledger) is
   * what feeds the next tick's `SyncRequest.ackedCommandIds` above.
   *
   * Deliberately still `=> void`, and deliberately still fire-and-forget. Making it `async`
   * and awaiting it here would couple poll liveness to handler latency: a relayed `jira:sync`
   * running for two minutes would stop the mirror for two minutes, and a channel that never
   * resolved would stop it forever. The queue on the other side is what keeps two ticks'
   * batches from interleaving; see its own header.
   */
  onCommands: (commands: CommandEnvelope[]) => void;
  /** Wraps one tick so the status bar can watch it, exactly as `trackSync` wraps JIRA/GitLab. */
  runTracked: <T>(run: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

/** Outbox rows resolved to entities per request — same order of magnitude as `JIRA_BOARD_LIMIT`.
 *  An upper bound on the COUNT only; `SYNC_BYTES_LIMIT` is what bounds the actual request. */
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
  /**
   * How many outbox rows this tick asks the store for. Normally `OUTBOX_LIMIT`, halved on
   * every `413 Payload Too Large` and reset by any success.
   *
   * `SYNC_BYTES_LIMIT` already bounds a request against the SERVER's limit, but not against
   * an intermediary's: a reverse proxy or an App Service front end with its own, tighter
   * idea of "too large" would 413 a batch the origin would happily have taken, and every
   * retry rebuilds the identical body. Halving is what turns that permanent wedge into a
   * few wasted ticks, and it converges on the "at least one entity" floor rather than zero.
   */
  private batchLimit = OUTBOX_LIMIT;
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

    const rows = this.deps.store.getCloudDelta(0, this.batchLimit);
    // Commands applied (or rejected) since the last successful sync — see
    // `cloudCommands.ts`'s own header for why acking happens here rather than the moment a
    // command is applied: this is the only place a "the server heard back" round trip exists.
    const ackedCommandIds = this.deps.store.getPendingCloudAcks();
    // The answers to relayed `ipc-invoke`s, riding the same request as the acks. Two
    // separate ledger columns and two separate "sent" marks, because they are two facts: an
    // ack retires the command on the server's queue, a result is what a browser is awaiting.
    const pendingResults = this.deps.store.getPendingCloudResults();
    const results: CommandResult[] = pendingResults.map((row) => ({
      commandId: row.commandId,
      ok: row.ok,
      ...(row.value === undefined ? {} : { value: row.value }),
      ...(row.reason === null ? {} : { error: row.reason }),
    }));
    const { delta, sent } = buildMirrorDeltaWithin(
      rows,
      this.deps.store.getTask,
      this.deps.store.getProject,
      SYNC_BYTES_LIMIT,
    );
    const request: SyncRequest = {
      clientId: this.deps.store.loadCloudClientId(),
      cursor: this.deps.store.loadCloudCursor(),
      focused: this.deps.focus.isFocused(),
      deltas: delta,
      ackedCommandIds,
      results,
      protocolVersion: PROTOCOL_VERSION,
    };

    const payload = JSON.stringify(request);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (payloadBytes > SYNC_BYTES_LIMIT) {
      // Practically always `buildMirrorDeltaWithin`'s "always take at least one entity"
      // rule: a single entity that does not fit the budget on its own. Sending it oversized
      // is the lesser evil — skipping it would drop that card from the cloud permanently,
      // and it would block every entity behind it in seq order while it did so. So it goes
      // out, loudly, rather than silently: this line is the only trace it would ever leave.
      logMain(
        `cloud sync batch over the byte cap: ${sent.length} entit${sent.length === 1 ? 'y' : 'ies'}, ` +
          `${payloadBytes} bytes (cap ${SYNC_BYTES_LIMIT}). Sending anyway.`,
      );
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, '')}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: payload,
    });
    if (!res.ok) {
      // 413 is the one failure the NEXT request can do something about — see `batchLimit`.
      if (res.status === 413) this.batchLimit = Math.max(1, Math.floor(this.batchLimit / 2));
      throw new Error(`cloud sync failed (${res.status} ${res.statusText})`);
    }
    this.batchLimit = OUTBOX_LIMIT;
    const body = (await res.json()) as SyncResponse;

    // Only the rows actually SENT are acked — never `rows`, which `buildMirrorDeltaWithin`
    // may have cut short under the byte cap. It walks ascending `seq`, so every entity left
    // out has a strictly higher seq than every one sent, and pruning through this single
    // number can therefore never drop an unsent write.
    if (sent.length > 0) {
      this.deps.store.pruneCloudOutbox(Math.max(...sent.map((r) => r.seq)));
    }
    if (ackedCommandIds.length > 0) this.deps.store.markCloudAcksSent(ackedCommandIds);
    // Only marked once the request that carried them actually succeeded — the same rule the
    // acks and the outbox prune above follow, and for the same reason: a result marked sent
    // on a request that failed is an answer the browser never gets and nothing will resend.
    if (results.length > 0) {
      this.deps.store.markCloudResultsSent(results.map((r) => r.commandId));
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
