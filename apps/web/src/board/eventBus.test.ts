import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@tm/protocol/wire';
import { DROPPED_PAYLOAD_MARKER } from '@tm/shared/ipcEventFanout';
import type { FocusSignal } from './BoardPoller';
import { CloudEventBus, type PushStream } from './eventBus';
import { PolledEventBus } from './polledEvents';
import type { SseEventStreamHandlers } from './sseEvents';

/** A push stream the test drives by hand — the bus never sees a socket. */
function makeFakeStream() {
  let handlers: SseEventStreamHandlers | null = null;
  const calls = { start: 0, stop: 0, reconnectNow: 0, dispose: 0 };
  const stream: PushStream = {
    start: () => void calls.start++,
    stop: () => void calls.stop++,
    reconnectNow: () => void calls.reconnectNow++,
    dispose: () => void calls.dispose++,
  };
  return {
    calls,
    create: (h: SseEventStreamHandlers): PushStream => {
      handlers = h;
      return stream;
    },
    connect: () => handlers!.onState('connected'),
    drop: () => handlers!.onState('disconnected'),
    push: (envelope: EventEnvelope) => handlers!.onEnvelope(envelope),
    gap: () => handlers!.onGap({ reason: 'shed', count: 2 }),
  };
}

function envelope(channel: string, payload: unknown): EventEnvelope {
  return { channel, payload, at: 1, seq: 1 };
}

/** Timers the test fires by hand, so a three-second grace costs nothing to wait out. */
function makeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    set: ((fn: () => void) => {
      pending.set(next, fn);
      return next++;
    }) as unknown as typeof setTimeout,
    clear: ((id: number) => void pending.delete(id)) as unknown as typeof clearTimeout,
    get armed(): number {
      return pending.size;
    },
    fire(): void {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

function makeBus(extra: { focus?: FocusSignal } = {}) {
  const stream = makeFakeStream();
  const grace = makeTimers();
  // The poll TIMER, separately — so "is the fallback running?" is a fact the test can read
  // rather than something it infers from request counts.
  const polls = makeTimers();
  const board: Record<string, unknown> = {
    'board:tasks': [{ id: 't1', status: 'TODO' }],
    'chain:links': [],
  };
  const invoke = vi.fn(async (channel: string) => board[channel] ?? null);
  const polled = new PolledEventBus({
    invoke: invoke as never,
    setIntervalImpl: polls.set as unknown as typeof setInterval,
    clearIntervalImpl: polls.clear as unknown as typeof clearInterval,
  });
  const bus = new CloudEventBus({
    polled,
    createStream: stream.create,
    focus: extra.focus,
    graceMs: 3_000,
    setTimeoutImpl: grace.set,
    clearTimeoutImpl: grace.clear,
  });
  return { bus, stream, grace, polls, polled, board, invoke };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('CloudEventBus', () => {
  it('starts the stream on the first subscription and delivers what it pushes', () => {
    const { bus, stream, polls, invoke } = makeBus();
    const seen: unknown[] = [];
    bus.on('task:changed', (change) => seen.push(change));

    expect(stream.calls.start).toBe(1);
    // Nothing is polled while the push channel is being given its chance.
    expect(polls.armed).toBe(0);
    expect(invoke).not.toHaveBeenCalled();

    stream.connect();
    expect(bus.isPushing).toBe(true);
    stream.push(envelope('task:changed', { task: { id: 't1' }, runId: 'r1' }));
    expect(seen).toEqual([{ task: { id: 't1' }, runId: 'r1' }]);
    bus.dispose();
  });

  it('never runs both sources at once — a change is announced exactly once', async () => {
    const { bus, stream, grace, polls, board } = makeBus();
    const seen: unknown[] = [];
    bus.on('task:changed', (change) => seen.push(change));

    // Fall back first, so the poll loop is genuinely running and holds a baseline.
    grace.fire();
    await settle();
    expect(polls.armed).toBe(1);
    expect(seen).toEqual([]); // the first read is the mount value, not a change

    // The stream comes back and the poll timer stops dead. A board change now is announced
    // by the push and cannot be announced a second time by a tick.
    stream.connect();
    expect(polls.armed).toBe(0);
    board['board:tasks'] = [{ id: 't1', status: 'DOING' }];
    stream.push(envelope('task:changed', { task: { id: 't1', status: 'DOING' }, runId: null }));
    polls.fire(); // there is nothing to fire, and that is the assertion
    await settle();

    expect(seen).toHaveLength(1);
    bus.dispose();
  });

  it('waits out the grace, so the routine five-minute reconnect does not start polling', async () => {
    const { bus, stream, grace, polls } = makeBus();
    bus.on('chain:changed', () => undefined);

    stream.connect();
    expect(grace.armed).toBe(0); // connected: nothing pending

    stream.drop();
    expect(grace.armed).toBe(1);
    stream.connect(); // back inside the grace, as the deliberate close always is
    expect(grace.armed).toBe(0);

    grace.fire();
    await settle();
    expect(bus.isPushing).toBe(true);
    expect(polls.armed).toBe(0);
    bus.dispose();
  });

  it('polls once the grace really does elapse', async () => {
    const { bus, stream, grace, polls, invoke } = makeBus();
    bus.on('chain:changed', () => undefined);
    stream.connect();
    stream.drop();
    grace.fire();
    await settle();

    expect(polls.armed).toBe(1);
    expect(invoke).toHaveBeenCalledWith('chain:links');
    bus.dispose();
  });

  it('keeps the poller baselines across a reconnect, so a change in the gap is announced', async () => {
    const { bus, stream, grace, board } = makeBus();
    const seen: unknown[] = [];
    bus.on('task:changed', (change) => seen.push(change));

    // First fallback: baseline recorded, nothing announced.
    grace.fire();
    await settle();
    expect(seen).toEqual([]);

    // The stream takes over, and then quietly fails to deliver a move before dropping.
    stream.connect();
    board['board:tasks'] = [{ id: 't1', status: 'DONE' }];
    stream.drop();
    grace.fire();
    await settle();

    // The RETAINED baseline is what makes this a change rather than a fresh baseline.
    expect(seen).toEqual([{ task: { id: 't1', status: 'DONE' }, runId: null }]);
    bus.dispose();
  });

  it('catches up with one poll when the stream admits to a hole, without starting the timer', async () => {
    const { bus, stream, grace, polls, board } = makeBus();
    const seen: unknown[] = [];
    bus.on('task:changed', (change) => seen.push(change));

    grace.fire();
    await settle();
    stream.connect();
    expect(polls.armed).toBe(0);

    board['board:tasks'] = [{ id: 't1', status: 'IN REVIEW' }];
    stream.gap();
    await settle();

    expect(seen).toEqual([{ task: { id: 't1', status: 'IN REVIEW' }, runId: null }]);
    expect(polls.armed).toBe(0); // one catch-up read, not a fallback
    bus.dispose();
  });

  it('reconnects the moment the tab comes back to the foreground', () => {
    let onFocus: ((focused: boolean) => void) | null = null;
    const focus: FocusSignal = {
      isFocused: () => true,
      onChange: (cb) => {
        onFocus = cb;
        return () => undefined;
      },
    };
    const { bus, stream } = makeBus({ focus });
    bus.on('chain:changed', () => undefined);

    onFocus!(false);
    expect(stream.calls.reconnectNow).toBe(0);
    onFocus!(true);
    expect(stream.calls.reconnectNow).toBe(1);
    bus.dispose();
  });

  it('drops a payload nothing survived the cap of, rather than fanning out a husk', () => {
    const { bus, stream } = makeBus();
    const seen: unknown[] = [];
    bus.on('session:event', (event) => seen.push(event));
    stream.connect();

    stream.push(envelope('session:event', { [DROPPED_PAYLOAD_MARKER]: true, bytes: 900_000 }));
    expect(seen).toEqual([]);
    bus.dispose();
  });

  it('carries the channels a poll never could', () => {
    const { bus, stream } = makeBus();
    const seen: string[] = [];
    bus.on('session:event', () => seen.push('session:event'));
    bus.on('board:notice', () => seen.push('board:notice'));
    bus.on('session:gap', () => seen.push('session:gap'));
    stream.connect();

    stream.push(envelope('session:event', { runId: 'r1', event: { kind: 'text' } }));
    stream.push(envelope('board:notice', { message: 'synced' }));
    stream.push(envelope('session:gap', { runId: 'r1' }));

    expect(seen).toEqual(['session:event', 'board:notice', 'session:gap']);
    bus.dispose();
  });

  it('stops everything when the last listener goes, and starts again for the next', () => {
    const { bus, stream } = makeBus();
    const off = bus.on('chain:changed', () => undefined);
    expect(stream.calls.start).toBe(1);

    off();
    expect(stream.calls.stop).toBe(1);

    bus.on('chain:changed', () => undefined);
    expect(stream.calls.start).toBe(2);
    bus.dispose();
    expect(stream.calls.dispose).toBe(1);
  });
});
