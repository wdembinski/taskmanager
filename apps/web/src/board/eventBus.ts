/**
 * `Transport.on()` for apps/web — the pushed stream when there is one, the polled
 * reconstruction when there is not, and never both at once.
 *
 * `HttpTransport` builds this instead of a bare `PolledEventBus`. Everything that subscribes
 * carries on doing exactly what it did: `useBoardExtras`'s seven subscriptions, `TaskDetail`'s
 * `session:event` and `task:changed`, `Attention.tsx`, `UsageQuotaBars.tsx`. They simply start
 * being pushed instead of polled — and start receiving the three channels a poll could never
 * reproduce (`session:event`, `board:notice`, `usage:sample`) at all.
 *
 * NEVER BOTH AT ONCE
 * ------------------
 * The two sources carry the SAME events. With the poll timer running while the stream is live,
 * every whole-list event arrives twice and `task:changed` double-fires — which for
 * `TaskDetail` means two reloads of a transcript per settled run, and for the board means a
 * re-render per tick forever. So the fallback is PAUSED (not unsubscribed) while the stream is
 * connected, and resumed when it is not.
 *
 * Paused rather than unsubscribed, because `PolledEventBus` forgets a channel's baseline when
 * its last listener goes — and the baseline is the entire value of falling back. The first
 * poll after a resume diffs against what the board looked like when the stream took over, so
 * whatever changed while the push channel was quietly broken is announced. Clear it and that
 * first poll silently re-baselines instead, which is the failure mode of a fallback that
 * hides the very thing it exists to catch.
 *
 * THE GRACE
 * ---------
 * The server closes every connection after five minutes on purpose, so `disconnected` is a
 * routine event a dozen times an hour on every open tab. Starting a poll loop on each one
 * would mean the fallback runs constantly and the reconnect is never given the second it
 * needs. Hence {@link PUSH_FALLBACK_GRACE_MS}: a disconnect has to LAST before it counts.
 *
 * A tab coming back to the foreground reconnects immediately rather than waiting out a
 * throttled backoff — see `SseEventStream.reconnectNow`.
 */
import type { EventEnvelope, GapFrame } from '@tm/protocol/wire';
import type { IpcEvents } from '@tm/shared/ipc';
import { isDroppedPayload } from '@tm/shared/ipcEventFanout';
import type { FocusSignal } from './BoardPoller';
import type { PolledEventBus } from './polledEvents';
import type { SseConnectionState, SseEventStreamHandlers } from './sseEvents';

/**
 * How long a disconnected stream has to stay disconnected before polling takes over.
 *
 * Comfortably longer than the reconnect the server itself forces (its `retry:` is a second),
 * and short enough that a real outage is covered before a human notices the board has stopped
 * moving.
 */
export const PUSH_FALLBACK_GRACE_MS = 3_000;

/** The slice of {@link SseEventStream} this bus drives — structural, so a test can fake it. */
export interface PushStream {
  start(): void;
  stop(): void;
  reconnectNow(): void;
  dispose(): void;
}

export interface CloudEventBusDeps {
  /** The fallback. Built by the caller, because it needs the transport's own `invoke`. */
  polled: PolledEventBus;
  /** Builds the push stream around the callbacks this bus needs to hear about. */
  createStream: (handlers: SseEventStreamHandlers) => PushStream;
  /** The tab's visibility, if the host has one — reconnects on the way back to foreground. */
  focus?: FocusSignal;
  graceMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

type Listener = (payload: never) => void;

export class CloudEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** One fallback subscription per channel someone is watching, so its baseline exists. */
  private readonly offPolled = new Map<string, () => void>();
  private readonly stream: PushStream;
  private readonly offFocus: (() => void) | undefined;
  private pushLive = false;
  private started = false;
  private disposed = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CloudEventBusDeps) {
    // Before anything can subscribe: `PolledEventBus.on` starts its own timer, and the
    // fallback must not poll until this bus says it may.
    deps.polled.pause();
    this.stream = deps.createStream({
      onEnvelope: (envelope) => this.deliver(envelope),
      onGap: (gap) => this.catchUp(gap),
      onState: (state) => this.onStreamState(state),
    });
    this.offFocus = deps.focus?.onChange((focused) => {
      if (focused) this.stream.reconnectNow();
    });
  }

  /** Subscribe, exactly as `Transport.on` promises. Returns the unsubscribe. */
  on<K extends keyof IpcEvents>(channel: K, callback: (payload: IpcEvents[K]) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set<Listener>();
    set.add(callback as Listener);
    this.listeners.set(channel, set);

    // The fallback subscribes for this channel too, at once and regardless of which source is
    // live: that is what makes it hold a baseline to diff against when it is resumed. It is
    // paused while the stream is connected, so subscribing costs no requests.
    if (!this.offPolled.has(channel)) {
      this.offPolled.set(
        channel,
        this.deps.polled.on(channel, (payload) => this.fan(channel, payload)),
      );
    }
    this.start();

    return () => {
      const live = this.listeners.get(channel);
      if (!live) return;
      live.delete(callback as Listener);
      if (live.size > 0) return;
      this.listeners.delete(channel);
      // Nobody is watching this channel any more, so its baseline is worth nothing — and
      // `PolledEventBus` drops it here for exactly the reason this bus keeps the others.
      this.offPolled.get(channel)?.();
      this.offPolled.delete(channel);
      if (this.listeners.size === 0) this.stop();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.offFocus?.();
    this.stream.dispose();
    this.clearFallback();
    for (const off of this.offPolled.values()) off();
    this.offPolled.clear();
    this.listeners.clear();
    this.deps.polled.dispose();
  }

  /** Whether events are arriving pushed rather than polled — read by tests, and honest. */
  get isPushing(): boolean {
    return this.pushLive;
  }

  private start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.stream.start();
    // Armed from the outset, not only after a disconnect: a stream that never opens at all
    // (an old server with no `/v1/events`, a proxy that eats it) has to end up polling too.
    this.armFallback();
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stream.stop();
    this.clearFallback();
    this.pushLive = false;
  }

  private onStreamState(state: SseConnectionState): void {
    if (state === 'connected') {
      this.pushLive = true;
      this.clearFallback();
      this.deps.polled.pause();
      return;
    }
    this.pushLive = false;
    this.armFallback();
  }

  private armFallback(): void {
    if (this.fallbackTimer || this.pushLive || this.disposed || !this.started) return;
    const set = this.deps.setTimeoutImpl ?? setTimeout;
    this.fallbackTimer = set(() => {
      this.fallbackTimer = null;
      if (this.pushLive || !this.started) return;
      this.deps.polled.resume();
    }, this.deps.graceMs ?? PUSH_FALLBACK_GRACE_MS);
  }

  private clearFallback(): void {
    if (!this.fallbackTimer) return;
    const clear = this.deps.clearTimeoutImpl ?? clearTimeout;
    clear(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private deliver(envelope: EventEnvelope): void {
    // Nothing survived the 32 KB cap (`@tm/shared/ipcEventFanout`), so there is no payload to
    // hand a subscriber typed for one. Dropped rather than passed on as a shape that would
    // read as an event with every field missing.
    if (isDroppedPayload(envelope.payload)) return;
    this.fan(envelope.channel, envelope.payload);
  }

  /**
   * The stream says it lost events — so run the fallback once, right now.
   *
   * This is the payoff for never clearing the baselines: one pass diffs the whole-list reads
   * and the board against what they were before the hole, and whatever actually changed
   * arrives as an ordinary event on its own channel. The poll timer stays off — the stream is
   * still the live source, this is one catch-up read, not a fallback.
   *
   * The transcript is the one thing this cannot recover, and does not try to: a `GapFrame`
   * does not say which run lost lines. The desktop's forwarder emits `session:gap` per
   * affected run for that (`@tm/shared/ipcEventFanout`), and `TaskDetail` re-reads on it.
   */
  private catchUp(_gap: GapFrame): void {
    void this.deps.polled.poll();
  }

  private fan(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      (listener as (p: unknown) => void)(payload);
    }
  }
}
