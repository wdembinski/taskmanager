import type { ByeFrame, HelloFrame } from '@tm/protocol/wire';
import { EVENT_STREAM_FRAMES } from '@tm/protocol/wire';
import type { EventBus, EventSubscription } from './eventBus';

/**
 * The server-sent-events half of `GET /v1/events`: framing, heartbeat, backpressure and the
 * lifetime after which the server hangs up on purpose.
 *
 * WHY NOT `@Sse()`
 * ----------------
 * NestJS ships an `@Sse()` decorator that turns an `Observable` into a stream, and it cannot
 * express any of the four things this endpoint is made of:
 *
 *  - **comment heartbeats** (`:` lines) — the keep-alive that stops a proxy, or a laptop's
 *    network stack, from silently holding a connection nobody has written to for minutes;
 *  - **a `retry:` directive** — how fast the browser should come back, which matters because
 *    this server closes the connection itself every five minutes;
 *  - **`Last-Event-ID` resume** — `@Sse()` has no notion of a position to resume from, and the
 *    ids it does emit are whatever the observable put there;
 *  - **a max lifetime** — an observable ends when it ends.
 *
 * So the controller takes a raw `@Res()` express response and this module owns it. The cost is
 * that Nest's response pipeline is bypassed for this one route; the benefit is that everything
 * above is a few lines rather than impossible.
 *
 * THE FIVE-MINUTE CLOSE
 * ---------------------
 * A stream that lives forever is a stream whose reconnect path runs only during an outage —
 * i.e. the one time you would like it to be well-tested. Closing every five minutes makes
 * reconnect-and-resume the NORMAL case: it runs a dozen times an hour on every open tab, over
 * the replay ring in `eventBus.ts`, and a bug in it shows up in ordinary use instead of at 3am.
 * It also bounds what one leaked connection can cost.
 */

/** How often a `:` comment goes out on an otherwise silent stream. */
export const SSE_HEARTBEAT_MS = 15_000;

/** How long one connection lives before the server closes it and expects a reconnect. */
export const SSE_MAX_LIFETIME_MS = 5 * 60_000;

/**
 * The `retry:` the browser is told to use.
 *
 * Fast, because the reconnect is normally OUR doing: for however long a tab is away, the
 * account's listener count is only non-zero thanks to `LISTENER_GRACE_MS`, and the events that
 * arrive meanwhile only survive in the replay ring. A second is plenty for both.
 */
export const SSE_RETRY_MS = 1_000;

/**
 * `no-transform` and `X-Accel-Buffering: no` are not decoration: a proxy that gzips or buffers
 * this response holds every frame until its buffer fills, which turns a live stream into a
 * batch delivered minutes late — the failure looks exactly like "the server never sent
 * anything".
 */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * The slice of an express `Response` this module uses — declared structurally so the tests can
 * hand it a recording socket, and so nothing here can reach for the rest of the response API
 * behind Nest's back.
 */
export interface SseSocket {
  writeHead(status: number, headers: Record<string, string>): void;
  /** `false` means the kernel/stream buffer is full — see {@link SseStream.writeChunk}. */
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): void;
  end(): void;
}

/** A `:` comment line. Ignored by every SSE parser, which is exactly what a heartbeat wants. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

/** The reconnection delay hint, sent once at the top of the stream. */
export function sseRetry(ms: number): string {
  return `retry: ${Math.round(ms)}\n\n`;
}

/**
 * One frame: optional `id:`, an `event:` name and a single `data:` line.
 *
 * A single line is safe because the data is always `JSON.stringify` output, and JSON escapes
 * every newline it contains — a raw `\n` inside `data:` would end the field and split one
 * frame into two.
 */
export function sseFrame(event: string, data: unknown, id?: number): string {
  const head = id === undefined ? '' : `id: ${id}\n`;
  return `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Timings, overridable so a test does not have to wait five minutes to see the close. */
export interface SseTimings {
  heartbeatMs?: number;
  maxLifetimeMs?: number;
  retryMs?: number;
}

export interface OpenEventStreamOptions extends SseTimings {
  socket: SseSocket;
  bus: EventBus;
  accountId: string;
  /** From `Last-Event-ID` or `?lastEventId=`; `null` for a fresh connection. */
  lastEventId: number | null;
}

/**
 * Subscribes and starts writing, in that order — the subscription has to exist before the
 * `hello` frame can say whether it resumed.
 */
export function openEventStream(options: OpenEventStreamOptions): SseStream {
  const subscription = options.bus.subscribe(options.accountId, options.lastEventId);
  return new SseStream(options.socket, subscription, options);
}

export class SseStream {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lifetime: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private closed = false;

  constructor(
    private readonly socket: SseSocket,
    private readonly subscription: EventSubscription,
    timings: SseTimings = {},
  ) {
    const heartbeatMs = timings.heartbeatMs ?? SSE_HEARTBEAT_MS;
    const maxLifetimeMs = timings.maxLifetimeMs ?? SSE_MAX_LIFETIME_MS;

    this.socket.writeHead(200, SSE_HEADERS);
    this.writeChunk(sseRetry(timings.retryMs ?? SSE_RETRY_MS));

    const hello: HelloFrame = {
      resumed: subscription.resumed,
      lastEventId: subscription.lastEventId,
    };
    this.writeChunk(sseFrame(EVENT_STREAM_FRAMES.hello, hello));

    this.heartbeat = setInterval(() => this.writeChunk(sseComment('beat')), heartbeatMs);
    this.lifetime = setTimeout(() => this.close('lifetime'), maxLifetimeMs);

    // Last, and it fires synchronously if this subscription was born with a backlog — so the
    // replayed events land after `hello`, which is the order a reader has to be able to assume.
    this.subscription.onWake(() => this.pump());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Writes everything the subscription is holding: the gap first, then the events it precedes.
   *
   * A whole drain goes out even if the socket says stop halfway — those events have already
   * left the bounded queue, so re-queueing them would be the one way to exceed the bound. What
   * the refusal buys is that the NEXT drain waits for `drain`, which is where the queue (and
   * its shedding) does its job.
   */
  private pump(): void {
    if (this.closed || this.paused) return;
    const { events, gap } = this.subscription.drain();
    if (gap) this.writeChunk(sseFrame(EVENT_STREAM_FRAMES.gap, gap));
    for (const event of events) {
      this.writeChunk(sseFrame(EVENT_STREAM_FRAMES.event, event.envelope, event.id));
    }
  }

  private writeChunk(chunk: string): void {
    if (this.closed) return;
    const ready = this.socket.write(chunk);
    if (ready || this.paused) return;
    this.paused = true;
    this.socket.once('drain', () => {
      this.paused = false;
      this.pump();
    });
  }

  /** The server hanging up: say why, then go. Idempotent. */
  close(reason: ByeFrame['reason']): void {
    if (this.closed) return;
    this.writeChunk(sseFrame(EVENT_STREAM_FRAMES.bye, { reason } satisfies ByeFrame));
    this.teardown();
    this.socket.end();
  }

  /**
   * The peer hung up on US — release everything and write nothing. Writing to a closed socket
   * is how a stream that nobody is reading keeps its timers alive until the process notices.
   */
  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.lifetime) clearTimeout(this.lifetime);
    this.heartbeat = null;
    this.lifetime = null;
    this.subscription.close();
  }
}
