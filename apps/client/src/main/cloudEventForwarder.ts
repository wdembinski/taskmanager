/**
 * The desktop half of the push channel: every engine event this Client emits, batched and
 * posted to `POST /v1/events` so a browser sees an agent working instead of finding out on
 * the next poll.
 *
 * WHY IT IS NOT PART OF `CloudPoller`
 * -----------------------------------
 * Because piggybacking on the sync tick would give back exactly what the push channel was
 * built to remove. That tick is 2.5s while this window is focused and 25s while it is not,
 * so a `session:event` riding it would reach the browser up to 25 seconds after the model
 * wrote the line — which is worse than what `PolledEventBus` already does. So: its own
 * endpoint, its own timer, its own backoff and its own failure counter. Nothing here reads or
 * writes `CloudPoller`'s cadence state, and nothing there waits on this.
 *
 * The two things they DO share are read-only and one-directional: the same `CloudSettings`,
 * and the same access-token getter. Both are handed in.
 *
 * THE GATE THAT MATTERS MOST
 * --------------------------
 * {@link CloudEventForwarder.publish} queues **nothing at all** until something has said a
 * browser is watching — `SyncResponse.eventListeners` on a request `CloudPoller` already
 * makes, or `EventBatchResponse.listeners` on a push of our own. "Nobody has told me" is
 * treated as "nobody is watching", which is why an offline desktop, a signed-out one, or one
 * whose owner has never opened the web app costs zero requests and zero memory no matter how
 * hard an agent is streaming. It is also why `publish` does not read settings per event: it
 * cannot get past the listener gate unless a working sync has already proved the cloud is on.
 *
 * Same fact in reverse: the moment a reply says the audience left, the queue is dropped. An
 * event is a moment, and a moment nobody was present for is not worth delivering late.
 *
 * SHAPED LIKE `cloudPoller.ts`
 * ---------------------------
 * fetch-only at its network edge, no Electron import, every dependency injected — so it runs
 * under vitest with a mocked `fetch` exactly as `CloudPoller` does. It is constructed INERT
 * (no arguments) because the one edit that feeds it — wrapping `send` in `ipc.ts` — sits far
 * above the `store` and the token getter it needs; {@link CloudEventForwarder.configure}
 * supplies those later, beside `cloudPoller`.
 */
import type { EventBatchRequest, EventBatchResponse, EventEnvelope } from '@protocol/wire';
import type { IpcEvents } from '@shared/ipc';
import { coalesceKey, isForwarded, truncateEventPayload } from '@shared/ipcEventFanout';
import type { CloudSettings } from '@shared/settings';
import { logMain } from './log';

export interface CloudEventForwarderDeps {
  /** Read fresh on every flush, exactly as `CloudPoller` reads it on every tick. */
  getSettings: () => CloudSettings;
  /** A bearer token for this batch, or null when not signed in — counted as a failure. */
  getAccessToken: () => Promise<string | null>;
  /** `Store.loadCloudClientId()`, which is also what `SyncRequest.clientId` carries. */
  getClientId: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * When a batch goes out: the EARLIEST of these three, and every one of them is load-bearing.
 *
 * **`maxDelayMs` — 100ms.** The arithmetic, for the one case that matters: an agent writing
 * hard emits a `session:event` roughly every 30ms, ≈33 events/s. Posted one per request that
 * is ≈33 req/s; batched at 100ms it is at most 10 req/s (3.3 events land per window, nowhere
 * near `maxEvents`, so the timer is what binds) — a 3.3× cut, for 100ms of added latency
 * nobody can see in a scrolling transcript.
 *
 * Ten a second is still 36,000 requests per hour of a WATCHED agent actually talking. Azure
 * Container Apps' free grant is 2M requests per subscription per month
 * (`docs/plan/azure-realtime-cost-comparison.md`), so ≈55 such hours a month would spend it
 * on their own — against the ≈1.27M/month that document already budgets for five focused
 * Clients' polling. The request count is that document's variable term, and this is now the
 * second contributor to it. Which is why the listener gate above matters more than this
 * number does: an unwatched agent posts nothing. If the bill ever moves, `maxDelayMs` is the
 * first thing to raise — 250ms would take the same stream to 4 req/s.
 *
 * **`maxEvents` — 64.** For a burst rather than a stream: a run that dumps a queue of
 * buffered lines at once should not sit behind a timer, and 64 is comfortably inside the
 * server's 256 KB batch cap even at `MAX_EVENT_BYTES` apiece.
 *
 * **`maxBytes` — 32 KB.** The same number `@shared/ipcEventFanout` caps a single payload at,
 * used here as a batch trigger: one `Write` tool-use is allowed to be a whole batch. Because
 * the check runs after appending, a batch can reach ≈64 KB (just under the threshold, plus
 * one full-size event) — still far inside the server's 256 KB.
 */
export const EVENT_BATCH = {
  maxDelayMs: 100,
  maxEvents: 64,
  maxBytes: 32 * 1024,
} as const;

/**
 * How much may wait for the network before events start being shed.
 *
 * Two bounds because either can be reached first: `QUEUE_LIMIT` entries is the burst case
 * (many small `session:event`s during a stalled request) and `QUEUE_BYTES_LIMIT` the fat one
 * (a handful of 32 KB tool inputs). Four batches' worth and 2 MB respectively — enough to
 * ride out a slow request or a short outage, small enough that a browser tab left open on a
 * dead network can never grow the main process without limit.
 */
const QUEUE_LIMIT = 4 * EVENT_BATCH.maxEvents;
const QUEUE_BYTES_LIMIT = 2 * 1024 * 1024;

/**
 * The most one REQUEST may carry, as opposed to what the queue may hold — half the 256 KB
 * the route accepts, so a batch built from a backlog of full-size events cannot walk into a
 * 413 that only halving would get it out of. See {@link CloudEventForwarder.takeBatch}.
 */
const BATCH_BYTES_LIMIT = 128 * 1024;

/**
 * This module's own backoff, deliberately not `nextPollDelayMs`.
 *
 * `@protocol/cadence` answers "when should I poll next", folding in presence and a server
 * directive — neither of which means anything to a channel that only sends when there is
 * something to send. All this needs is "wait longer each time the network says no", so:
 * 1s, 2s, 4s … capped at 30s, reset by any success.
 */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** One queued event, plus the bookkeeping the queue needs and the wire does not. */
interface QueuedEvent {
  channel: string;
  payload: unknown;
  at: number;
  seq: number;
  /** Its `coalesceKey`, or null for a stream channel that must never collapse. */
  key: string | null;
  /** UTF-8 bytes of the enveloped JSON, measured once at enqueue. */
  bytes: number;
}

export class CloudEventForwarder {
  private deps: CloudEventForwarderDeps | null = null;
  private disposed = false;

  private queue: QueuedEvent[] = [];
  /** The newest queued entry per `coalesceKey` — how a replacement finds what it replaces. */
  private index = new Map<string, QueuedEvent>();
  private queuedBytes = 0;

  /**
   * The sender's monotonic counter (`EventEnvelope.seq`), incremented for every event this
   * forwarder ACCEPTS — including the ones it then coalesces away or sheds. That is the whole
   * point of it: a receiver seeing 41 then 45 knows three events existed that it never got,
   * which is the same fact {@link gap} carries as a number.
   */
  private seq = 0;
  /** Events accepted but never sent, since the last batch the server took. */
  private gap = 0;

  /**
   * How many browser sessions are watching, or null while nobody has said.
   *
   * Null and 0 both mean "do not queue"; only a positive count opens the gate. See the header
   * for why the unknown state is closed rather than optimistic.
   */
  private listeners: number | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  /** Halved on a 413 and reset by any success — the same self-correction `CloudPoller` does. */
  private batchLimit: number = EVENT_BATCH.maxEvents;

  /** Supply the dependencies. Until this is called, {@link publish} is a no-op. */
  configure(deps: CloudEventForwarderDeps): void {
    this.deps = deps;
  }

  /**
   * Tell the forwarder how many browsers are listening.
   *
   * Called from both places that learn it: `CloudPoller`'s `SyncResponse.eventListeners`, and
   * this class's own `EventBatchResponse.listeners`. Dropping to zero drops the queue — those
   * events have no audience, and holding them would deliver a stale burst to whoever connects
   * next, on top of the replay the server already gives them.
   */
  setListeners(count: number): void {
    if (this.disposed) return;
    const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const had = this.listeners !== null && this.listeners > 0;
    this.listeners = next;
    if (next === 0 && had) this.dropQueue();
  }

  /**
   * Hand one engine event to the cloud. **Total and non-blocking, by contract.**
   *
   * This runs inline on the engine's own event path — `send` in `ipc.ts`, which the scheduler,
   * every session and every handler push through. A throw here would surface as a broken
   * desktop UI in code that has nothing to do with the cloud, and an `await` here would put
   * network latency in front of a `webContents.send`. So: everything is inside one try/catch,
   * and the request is never awaited — the only synchronous work is capping the payload and
   * measuring it, on an object Electron is about to structured-clone to the renderer anyway.
   */
  publish<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
    try {
      if (this.disposed || !this.deps) return;
      // The cheap gate first: two comparisons, and it is false for every desktop that has no
      // browser attached — which is most of them, most of the time.
      if (this.listeners === null || this.listeners === 0) return;
      if (!isForwarded(channel)) return;
      this.enqueue(channel, payload);
      this.scheduleFlush();
    } catch (e) {
      // Never rethrown: see the contract above. A forwarder that cannot queue is a mirror
      // that lags, not an engine that breaks.
      logMain('cloud event forwarding failed', e);
    }
  }

  /**
   * Append one event, replacing whatever it supersedes.
   *
   * A coalescing event REPLACES its predecessor by removing it and pushing anew, rather than
   * overwriting in place. That keeps `queue` sorted by `seq`, so a batch is always ascending
   * and a receiver can read the jumps straight off it; overwriting in place would leave a
   * newer seq sitting in front of an older one in the same request. The cost is an `indexOf`
   * over a queue bounded at {@link QUEUE_LIMIT}, which is a few hundred entries at most.
   */
  private enqueue(channel: string, payload: unknown): void {
    const { payload: capped } = truncateEventPayload(payload);
    const key = coalesceKey(channel, capped);
    if (key !== null) {
      const previous = this.index.get(key);
      if (previous) this.remove(previous, true);
    }
    const at = (this.deps?.now ?? Date.now)();
    this.seq += 1;
    const entry: QueuedEvent = {
      channel,
      payload: capped,
      at,
      seq: this.seq,
      key,
      bytes: envelopeBytes(channel, capped),
    };
    this.queue.push(entry);
    if (key !== null) this.index.set(key, entry);
    this.queuedBytes += entry.bytes;
    this.shedIfOver();
  }

  /** Take one entry out of the queue, optionally counting it as lost to the receiver. */
  private remove(entry: QueuedEvent, counted: boolean): void {
    const at = this.queue.indexOf(entry);
    if (at < 0) return;
    this.queue.splice(at, 1);
    this.queuedBytes -= entry.bytes;
    if (entry.key !== null && this.index.get(entry.key) === entry) this.index.delete(entry.key);
    if (counted) this.gap += 1;
  }

  /**
   * Bring the queue back inside its bounds by dropping the OLDEST `session:event`s.
   *
   * Oldest first because a transcript's newest lines are the ones a human is watching, and
   * `session:event` specifically because it is the only channel that can run away: everything
   * else either coalesces (bounded by the number of cards, runs and projects) or is an edge a
   * human caused. Every run that lost lines gets a `session:gap` — which coalesces by runId,
   * so a long shed leaves one marker per run rather than one per line, and step 6's browser
   * answers it by re-reading `task:activity`, the transcript of record.
   *
   * The fallback exists so this function always terminates: if the bound is somehow reached
   * with no stream event left to drop, the oldest entry goes regardless.
   */
  private shedIfOver(): void {
    if (!this.isOver()) return;
    const shedRuns = new Set<string>();
    while (this.isOver() && this.queue.length > 0) {
      const victim = this.queue.find((entry) => entry.channel === 'session:event') ?? this.queue[0];
      const runId = (victim.payload as { runId?: unknown } | null)?.runId;
      if (victim.channel === 'session:event' && typeof runId === 'string') shedRuns.add(runId);
      this.remove(victim, true);
    }
    for (const runId of shedRuns) {
      // Straight in, without a shed check of its own: a gap event coalesces by runId, so this
      // loop adds at most one entry per run to a queue that just made room for far more.
      this.seq += 1;
      const at = (this.deps?.now ?? Date.now)();
      const payload = { runId };
      const key = coalesceKey('session:gap', payload);
      const previous = key === null ? undefined : this.index.get(key);
      if (previous) this.remove(previous, true);
      const entry: QueuedEvent = {
        channel: 'session:gap',
        payload,
        at,
        seq: this.seq,
        key,
        bytes: envelopeBytes('session:gap', payload),
      };
      this.queue.push(entry);
      if (key !== null) this.index.set(key, entry);
      this.queuedBytes += entry.bytes;
    }
  }

  private isOver(): boolean {
    return this.queue.length > QUEUE_LIMIT || this.queuedBytes > QUEUE_BYTES_LIMIT;
  }

  /** Arm the batch window, or fire now if a size trigger has already been reached. */
  private scheduleFlush(): void {
    if (this.disposed || this.queue.length === 0) return;
    if (this.sending) return; // one request in flight; the finally re-schedules
    const now = (this.deps?.now ?? Date.now)();
    const waitForBackoff = Math.max(0, this.backoffUntil - now);
    const full = this.queue.length >= this.batchLimit || this.queuedBytes >= EVENT_BATCH.maxBytes;
    const delay = waitForBackoff > 0 ? waitForBackoff : full ? 0 : EVENT_BATCH.maxDelayMs;
    if (this.timer && !full && waitForBackoff === 0) return; // window already running
    this.arm(delay);
  }

  private arm(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), delayMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Post one batch. Exposed for tests; the timer calls it.
   *
   * Never throws — it is only ever reached from a timer or from itself, and there is nobody
   * above either to catch it.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.sending || this.disposed || this.queue.length === 0) return;
    const deps = this.deps;
    if (!deps) return;

    let settings: CloudSettings;
    try {
      settings = deps.getSettings();
    } catch (e) {
      logMain('cloud event batch could not read settings', e);
      this.dropQueue();
      return;
    }
    if (!settings.enabled || !settings.baseUrl.trim()) {
      // The cloud was turned off under us. Stop queueing until a sync says otherwise — which
      // it cannot while it is off, so this is where forwarding ends.
      this.listeners = 0;
      this.dropQueue();
      return;
    }

    // Taken BEFORE the await, so events that arrive during the request queue behind this
    // batch rather than joining it — which is what keeps `gap` honest about what a failed
    // request actually lost.
    const taken = this.takeBatch();
    this.reindex();
    const gap = this.gap;
    this.gap = 0;

    this.sending = true;
    try {
      const listeners = await this.post(deps, settings, taken, gap);
      this.consecutiveFailures = 0;
      this.backoffUntil = 0;
      this.batchLimit = EVENT_BATCH.maxEvents;
      this.setListeners(listeners);
    } catch (e) {
      this.consecutiveFailures += 1;
      // The batch is NOT put back. These are moments: re-sending 100ms of transcript after a
      // 4s backoff delivers a stale burst, and a queue that grows by every failed batch is
      // the head-of-line stall the bounds above exist to prevent. What the receiver gets
      // instead is the truth — `gap` carries the count on the next batch that lands.
      this.gap += taken.length;
      this.backoffUntil =
        (deps.now ?? Date.now)() +
        Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1));
      logMain('cloud event batch failed', e);
    } finally {
      this.sending = false;
      this.scheduleFlush();
    }
  }

  /**
   * The front of the queue, bounded by BOTH the event count and the byte budget.
   *
   * The count alone is not enough. `maxEvents` fires the flush at 64 events, but a request
   * that stalls lets the queue reach {@link QUEUE_LIMIT} — and 64 events of full-size tool
   * input is megabytes, which the route would 413. Halving recovers from that, and this is
   * what keeps it from being the routine outcome of every slow request.
   *
   * Always takes at least one, exactly as `buildMirrorDeltaWithin` does for the mirror: a
   * single event over the budget goes out alone and oversized rather than blocking every
   * event behind it forever.
   */
  private takeBatch(): QueuedEvent[] {
    const limit = Math.max(1, this.batchLimit);
    const taken: QueuedEvent[] = [];
    let bytes = 0;
    while (this.queue.length > 0 && taken.length < limit) {
      const next = this.queue[0];
      if (taken.length > 0 && bytes + next.bytes > BATCH_BYTES_LIMIT) break;
      bytes += next.bytes;
      taken.push(next);
      this.queue.shift();
    }
    return taken;
  }

  /** The request itself. Resolves to the listener count; throws on anything but a 2xx. */
  private async post(
    deps: CloudEventForwarderDeps,
    settings: CloudSettings,
    taken: QueuedEvent[],
    gap: number,
  ): Promise<number> {
    const token = await deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const events: EventEnvelope[] = taken.map((entry) => ({
      channel: entry.channel,
      payload: entry.payload,
      at: entry.at,
      seq: entry.seq,
    }));
    const request: EventBatchRequest = {
      clientId: deps.getClientId(),
      ...(gap > 0 ? { gap } : {}),
      events,
    };

    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, '')}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      // The one failure the next request can do something about — the route caps a batch at
      // 256 KB, and halving is what turns a permanent wedge into a couple of wasted batches.
      if (res.status === 413) this.batchLimit = Math.max(1, Math.floor(this.batchLimit / 2));
      throw new Error(`cloud event batch failed (${res.status} ${res.statusText})`);
    }
    const body = (await res.json()) as EventBatchResponse;
    return typeof body?.listeners === 'number' ? body.listeners : 0;
  }

  /** Rebuild the coalescing index over what is left after a batch was taken. */
  private reindex(): void {
    this.index.clear();
    this.queuedBytes = 0;
    for (const entry of this.queue) {
      if (entry.key !== null) this.index.set(entry.key, entry);
      this.queuedBytes += entry.bytes;
    }
  }

  /**
   * Forget everything queued, INCLUDING the gap count.
   *
   * The gap goes too because it is only meaningful to a receiver who was already listening
   * when the hole appeared: every path here (nobody watching, cloud switched off, disposed)
   * has ended that relationship, and whoever connects next gets a fresh stream — the server
   * tells them so with `HelloFrame.resumed: false`.
   */
  private dropQueue(): void {
    this.queue = [];
    this.index.clear();
    this.queuedBytes = 0;
    this.gap = 0;
    this.clearTimer();
  }

  /** How many events are waiting. For tests and for a future status readout. */
  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.disposed = true;
    this.dropQueue();
    this.deps = null;
  }
}

/** UTF-8 bytes this event will occupy on the wire, envelope fields included. */
function envelopeBytes(channel: string, payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify({ channel, payload, at: 0, seq: 0 }) ?? '', 'utf8');
  } catch {
    // `truncateEventPayload` has already replaced anything JSON refuses, so this is
    // unreachable — but "unmeasurable" must count as large, never as free.
    return EVENT_BATCH.maxBytes;
  }
}
