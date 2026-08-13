import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@tm/protocol/wire';
import { EVENT_STREAM_FRAMES } from '@tm/protocol/wire';
import { EventBus } from './eventBus';
import {
  openEventStream,
  sseComment,
  sseFrame,
  sseRetry,
  SSE_HEADERS,
  SSE_HEARTBEAT_MS,
  SSE_MAX_LIFETIME_MS,
  type SseSocket,
} from './sseStream';

/** An {@link SseSocket} that records instead of writing, and can refuse on demand. */
class RecordingSocket implements SseSocket {
  status: number | null = null;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  /** Flip to false to make every `write` report a full buffer, as a real socket does. */
  ready = true;
  private drains: (() => void)[] = [];

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.ready;
  }

  once(_event: 'drain', listener: () => void): void {
    this.drains.push(listener);
  }

  end(): void {
    this.ended = true;
  }

  /** The socket catching up: everything queued went out. */
  flushDrain(): void {
    this.ready = true;
    for (const listener of this.drains.splice(0)) listener();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

function envelope(seq: number): EventEnvelope {
  return { channel: 'session:event', payload: { line: `line ${seq}` }, at: seq, seq };
}

describe('SSE framing', () => {
  it('writes a comment nothing parses as a frame', () => {
    expect(sseComment('beat')).toBe(': beat\n\n');
  });

  it('writes the reconnection hint as whole milliseconds', () => {
    expect(sseRetry(1_000)).toBe('retry: 1000\n\n');
  });

  it('writes an id, a name and one data line', () => {
    expect(sseFrame('engine', { a: 1 }, 7)).toBe('id: 7\nevent: engine\ndata: {"a":1}\n\n');
    expect(sseFrame('bye', { reason: 'lifetime' })).toBe(
      'event: bye\ndata: {"reason":"lifetime"}\n\n',
    );
  });

  it('keeps a payload with newlines on a single data line', () => {
    const frame = sseFrame('engine', { text: 'first\nsecond' });

    // One blank line in the whole frame — the terminator, and nothing else.
    expect(frame.split('\n\n')).toHaveLength(2);
    expect(frame).toContain('first\\nsecond');
  });
});

describe('SseStream', () => {
  let bus: EventBus;
  let socket: RecordingSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    bus = new EventBus();
    socket = new RecordingSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function open(lastEventId: number | null = null) {
    return openEventStream({ socket, bus, accountId: 'account-a', lastEventId });
  }

  it('opens with the streaming headers, a retry directive and a hello', () => {
    open();

    expect(socket.status).toBe(200);
    expect(socket.headers).toEqual(SSE_HEADERS);
    expect(socket.chunks[0]).toBe(sseRetry(1_000));
    expect(socket.chunks[1]).toBe(
      sseFrame(EVENT_STREAM_FRAMES.hello, { resumed: false, lastEventId: null }),
    );
  });

  it('says so in the hello when a resume was honoured, and replays after it', () => {
    bus.publish('account-a', [envelope(1), envelope(2)]);

    open(1);

    expect(socket.chunks[1]).toBe(
      sseFrame(EVENT_STREAM_FRAMES.hello, { resumed: true, lastEventId: 1 }),
    );
    expect(socket.chunks[2]).toBe(sseFrame(EVENT_STREAM_FRAMES.event, envelope(2), 2));
  });

  it('writes the gap before the events it precedes', () => {
    open(9);

    expect(socket.chunks[2]).toBe(sseFrame(EVENT_STREAM_FRAMES.gap, { reason: 'reset' }));
  });

  it('writes each published event with its own id', () => {
    open();
    socket.chunks.length = 0;

    bus.publish('account-a', [envelope(1), envelope(2)]);

    expect(socket.chunks).toEqual([
      sseFrame(EVENT_STREAM_FRAMES.event, envelope(1), 1),
      sseFrame(EVENT_STREAM_FRAMES.event, envelope(2), 2),
    ]);
  });

  it('heartbeats on a silent stream', () => {
    open();
    socket.chunks.length = 0;

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 2);

    expect(socket.chunks).toEqual([sseComment('beat'), sseComment('beat')]);
  });

  it('closes itself after the max lifetime, saying why, and lets go of the subscription', () => {
    const stream = open();

    vi.advanceTimersByTime(SSE_MAX_LIFETIME_MS);

    expect(socket.text).toContain(sseFrame(EVENT_STREAM_FRAMES.bye, { reason: 'lifetime' }));
    expect(socket.ended).toBe(true);
    expect(stream.isClosed).toBe(true);
    // And the heartbeat went with it.
    socket.chunks.length = 0;
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
    expect(socket.chunks).toEqual([]);
  });

  it('stops everything without writing when the peer hangs up', () => {
    const stream = open();
    socket.chunks.length = 0;

    stream.dispose();
    expect(bus.listeners('account-a')).toBe(1); // still inside the reconnect grace

    vi.advanceTimersByTime(SSE_MAX_LIFETIME_MS + SSE_HEARTBEAT_MS);
    bus.publish('account-a', [envelope(1)]);

    expect(socket.chunks).toEqual([]);
    expect(socket.ended).toBe(false);
  });

  it('waits for drain before writing again once the socket refuses', () => {
    open();
    socket.chunks.length = 0;

    socket.ready = false;
    bus.publish('account-a', [envelope(1)]);
    expect(socket.chunks).toHaveLength(1); // the refused write still went out

    bus.publish('account-a', [envelope(2)]);
    expect(socket.chunks).toHaveLength(1); // and nothing after it did

    socket.flushDrain();
    expect(socket.chunks).toHaveLength(2);
    expect(socket.chunks[1]).toBe(sseFrame(EVENT_STREAM_FRAMES.event, envelope(2), 2));
  });

  it('counts as a listener for as long as it is open', () => {
    const stream = open();
    expect(bus.listeners('account-a')).toBe(1);

    stream.close('shutdown');
    vi.advanceTimersByTime(60_000);
    expect(bus.listeners('account-a')).toBe(0);
  });
});
