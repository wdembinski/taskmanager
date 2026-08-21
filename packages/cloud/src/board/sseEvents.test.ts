import { describe, expect, it, vi } from 'vitest';
import { EVENT_STREAM_FRAMES, type EventEnvelope, type GapFrame } from '@tm/protocol/wire';
import {
  SSE_RETRY_MIN_MS,
  SseEventStream,
  SseFrameParser,
  type SseConnectionState,
} from './sseEvents';

/**
 * A stream the test writes into by hand, so a frame can be split across chunks and a
 * connection can be ended at a chosen moment rather than whenever a fixture runs out.
 */
function makeSocket() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

interface Recorded {
  envelopes: EventEnvelope[];
  gaps: GapFrame[];
  states: SseConnectionState[];
  errors: unknown[];
}

function makeStream(
  fetchImpl: typeof fetch,
  extra: { getAccessToken?: () => Promise<string | null> } = {},
) {
  const seen: Recorded = { envelopes: [], gaps: [], states: [], errors: [] };
  const stream = new SseEventStream({
    apiBase: 'https://api.example.com',
    getAccessToken: extra.getAccessToken ?? (async () => 'token-1'),
    fetchImpl,
    onEnvelope: (envelope) => seen.envelopes.push(envelope),
    onGap: (gap) => seen.gaps.push(gap),
    onState: (state) => seen.states.push(state),
    onError: (error) => seen.errors.push(error),
    // Every wait resolves on a microtask, so a reconnect happens as fast as the test awaits.
    setTimeoutImpl: ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
  });
  return { stream, seen };
}

/** Let every pending microtask (and the reader's own `read()`) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('SseFrameParser', () => {
  it('parses a frame with an id, a name and data', () => {
    const parser = new SseFrameParser();
    expect(parser.push('id: 7\nevent: engine\ndata: {"a":1}\n\n')).toEqual([
      { event: 'engine', data: '{"a":1}', id: '7', retry: null, hasData: true },
    ]);
  });

  it('holds a frame split across chunks until the boundary arrives', () => {
    const parser = new SseFrameParser();
    expect(parser.push('event: eng')).toEqual([]);
    expect(parser.push('ine\ndata: {"a":')).toEqual([]);
    const frames = parser.push('1}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('{"a":1}');
  });

  it('skips comment heartbeats and joins multi-line data', () => {
    const parser = new SseFrameParser();
    const frames = parser.push(': beat\n\nevent: engine\ndata: one\ndata: two\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('one\ntwo');
  });

  it('reads a bare retry directive as a directive, not an event', () => {
    const parser = new SseFrameParser();
    const [frame] = new SseFrameParser().push('retry: 1000\n\n');
    expect(frame).toEqual({ event: '', data: '', id: null, retry: 1000, hasData: false });
    expect(parser.push('\n\n')).toEqual([]); // an empty block is nothing at all
  });

  it('does not split on a CR that turns out to be half a CRLF', () => {
    const parser = new SseFrameParser();
    expect(parser.push('event: engine\r\ndata: x\r')).toEqual([]);
    const frames = parser.push('\n\r\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe('x');
  });
});

describe('SseEventStream', () => {
  it('opens with a bearer token and fans out the frames it reads', async () => {
    const socket = makeSocket();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: socket.body,
    })) as unknown as typeof fetch;
    const { stream, seen } = makeStream(fetchImpl);

    stream.start();
    await settle();

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('https://api.example.com/v1/events');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
    expect((init.headers as Record<string, string>)['last-event-id']).toBeUndefined();

    socket.write(`retry: ${SSE_RETRY_MIN_MS}\n\n`);
    socket.write(
      `event: ${EVENT_STREAM_FRAMES.hello}\ndata: {"resumed":false,"lastEventId":null}\n\n`,
    );
    socket.write(
      `id: 4\nevent: ${EVENT_STREAM_FRAMES.event}\ndata: {"channel":"task:changed","payload":{"task":{"id":"t1"},"runId":"r1"},"at":1,"seq":1}\n\n`,
    );
    socket.write(`event: ${EVENT_STREAM_FRAMES.gap}\ndata: {"reason":"shed","count":3}\n\n`);
    await settle();

    expect(seen.states).toEqual(['connected']);
    expect(seen.envelopes).toHaveLength(1);
    expect(seen.envelopes[0]!.channel).toBe('task:changed');
    expect(seen.gaps).toEqual([{ reason: 'shed', count: 3 }]);
    stream.dispose();
  });

  it('resumes from the last id it saw when the server hangs up', async () => {
    const sockets = [makeSocket(), makeSocket()];
    let opened = 0;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: sockets[opened++]!.body,
    })) as unknown as typeof fetch;
    const { stream, seen } = makeStream(fetchImpl);

    stream.start();
    await settle();
    sockets[0]!.write(
      `event: ${EVENT_STREAM_FRAMES.hello}\ndata: {"resumed":false,"lastEventId":null}\n\n`,
    );
    sockets[0]!.write(`id: 12\nevent: ${EVENT_STREAM_FRAMES.event}\ndata: {"channel":"x"}\n\n`);
    sockets[0]!.write(`event: ${EVENT_STREAM_FRAMES.bye}\ndata: {"reason":"lifetime"}\n\n`);
    await settle();
    sockets[0]!.end();
    await settle();

    expect(opened).toBe(2);
    const second = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[1]!;
    expect((second[1].headers as Record<string, string>)['last-event-id']).toBe('12');
    // A deliberate close is announced, so the composite bus can start its grace timer.
    expect(seen.states).toEqual(['connected', 'disconnected']);
    stream.dispose();
  });

  it('reports a refusal and keeps retrying rather than giving up', async () => {
    let attempts = 0;
    const socket = makeSocket();
    const fetchImpl = vi.fn(async () => {
      attempts++;
      if (attempts < 3) return { ok: false, status: 503, statusText: 'Unavailable', body: null };
      return { ok: true, status: 200, statusText: 'OK', body: socket.body };
    }) as unknown as typeof fetch;
    const { stream, seen } = makeStream(fetchImpl);

    stream.start();
    await settle();
    socket.write(`event: ${EVENT_STREAM_FRAMES.hello}\ndata: {"resumed":true,"lastEventId":3}\n\n`);
    await settle();

    expect(attempts).toBe(3);
    expect(seen.errors).toHaveLength(2);
    expect(String(seen.errors[0])).toContain('503');
    expect(seen.states).toEqual(['connected']); // never claimed connected while refused
    stream.dispose();
  });

  it('asks for a token on every attempt, so an expired one is refreshed', async () => {
    const tokens = ['stale', 'fresh'];
    let attempts = 0;
    const socket = makeSocket();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      attempts++;
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === 'Bearer stale') {
        return { ok: false, status: 401, statusText: 'Unauthorized', body: null };
      }
      return { ok: true, status: 200, statusText: 'OK', body: socket.body };
    }) as unknown as typeof fetch;
    const { stream } = makeStream(fetchImpl, {
      getAccessToken: async () => tokens[Math.min(attempts, tokens.length - 1)]!,
    });

    stream.start();
    await settle();

    expect(attempts).toBe(2);
    stream.dispose();
  });

  it('stops for good once disposed', async () => {
    const socket = makeSocket();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: socket.body,
    })) as unknown as typeof fetch;
    const { stream, seen } = makeStream(fetchImpl);

    stream.start();
    await settle();
    socket.write(
      `event: ${EVENT_STREAM_FRAMES.hello}\ndata: {"resumed":false,"lastEventId":null}\n\n`,
    );
    await settle();
    stream.dispose();
    socket.end();
    await settle();

    expect(seen.states).toEqual(['connected', 'disconnected']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen.errors).toEqual([]); // the abort is our own doing, not a failure
  });
});
