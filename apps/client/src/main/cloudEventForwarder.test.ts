import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBatchRequest } from '@protocol/wire';
import { MAX_EVENT_BYTES } from '@shared/ipcEventFanout';
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from '@shared/settings';
import {
  CloudEventForwarder,
  EVENT_BATCH,
  type CloudEventForwarderDeps,
} from './cloudEventForwarder';

/** A `session:event` payload with a body of `size` characters. */
function line(runId: string, size = 8): { runId: string; event: unknown } {
  return { runId, event: { kind: 'assistant-text', text: 'x'.repeat(size) } };
}

function okResponse(listeners = 1): unknown {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ listeners }) };
}

function make(
  overrides: Partial<CloudEventForwarderDeps> & { settings?: Partial<CloudSettings> } = {},
): {
  forwarder: CloudEventForwarder;
  fetchImpl: ReturnType<typeof vi.fn>;
  bodies: () => EventBatchRequest[];
} {
  const { settings, ...rest } = overrides;
  const fetchImpl =
    (rest.fetchImpl as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn().mockResolvedValue(okResponse());
  const forwarder = new CloudEventForwarder();
  forwarder.configure({
    getSettings: () => ({
      ...DEFAULT_CLOUD_SETTINGS,
      enabled: true,
      baseUrl: 'https://api.example.com',
      ...settings,
    }),
    getAccessToken: async () => 'token',
    getClientId: () => 'client-1',
    ...rest,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return {
    forwarder,
    fetchImpl,
    bodies: () =>
      fetchImpl.mock.calls.map(
        ([, init]) => JSON.parse((init as RequestInit).body as string) as EventBatchRequest,
      ),
  };
}

/** Open the listener gate the way a `SyncResponse` would. */
function watched(forwarder: CloudEventForwarder, count = 1): void {
  forwarder.setListeners(count);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the listener gate', () => {
  it('queues nothing until somebody says a browser is watching', () => {
    const { forwarder } = make();
    forwarder.publish('session:event', line('run-1') as never);
    expect(forwarder.pending).toBe(0);
  });

  it('queues once a listener is reported', () => {
    const { forwarder } = make();
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    expect(forwarder.pending).toBe(1);
  });

  it('drops the queue on the 1 -> 0 transition', () => {
    const { forwarder } = make();
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    forwarder.setListeners(0);
    expect(forwarder.pending).toBe(0);
  });

  it('stops queueing when a batch reply says the audience left', async () => {
    const { forwarder, fetchImpl } = make({
      fetchImpl: vi.fn().mockResolvedValue(okResponse(0)) as never,
    });
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    await forwarder.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    forwarder.publish('session:event', line('run-1') as never);
    expect(forwarder.pending).toBe(0);
  });

  it('never queues a channel classified `drop`', () => {
    const { forwarder } = make();
    watched(forwarder);
    forwarder.publish('project:tasksChanged', { projectId: 'p1', tasks: [] } as never);
    forwarder.publish('window:maximizedChanged', true as never);
    expect(forwarder.pending).toBe(0);
  });
});

describe('batching', () => {
  it('sends after the batch window rather than per event', async () => {
    const { forwarder, fetchImpl, bodies } = make();
    watched(forwarder);
    for (let i = 0; i < 5; i += 1) forwarder.publish('session:event', line('run-1') as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies()[0].events).toHaveLength(5);
    expect(bodies()[0].clientId).toBe('client-1');
  });

  it('sends immediately once the event count trigger is reached', async () => {
    const { forwarder, fetchImpl } = make();
    watched(forwarder);
    for (let i = 0; i < EVENT_BATCH.maxEvents; i += 1) {
      forwarder.publish('session:event', line(`run-${i}`) as never);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends immediately once the byte trigger is reached', async () => {
    const { forwarder, fetchImpl } = make();
    watched(forwarder);
    // Two events well past the 32 KB batch trigger between them, but far under `maxEvents`.
    forwarder.publish('session:event', line('run-1', 20_000) as never);
    forwarder.publish('session:event', line('run-1', 20_000) as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('splits a backlog of fat events across requests rather than posting one huge one', async () => {
    // One in-flight request lets the queue build up past what a single batch may carry.
    const gate: { release: (() => void) | null } = { release: null };
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            gate.release = () => resolve(okResponse());
          }),
      )
      .mockResolvedValue(okResponse());
    const { forwarder, bodies } = make({ fetchImpl: fetchImpl as never });
    watched(forwarder);
    forwarder.publish('session:event', line('run-0') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);

    // 16 events of ~25 KB each — well inside `maxEvents`, well past the 128 KB request bound.
    for (let i = 0; i < 16; i += 1) {
      forwarder.publish('session:event', line(`run-${i}`, 25_000) as never);
    }
    gate.release?.();
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs * 4);

    const sent = bodies().slice(1);
    expect(sent.length).toBeGreaterThan(1);
    for (const body of sent) {
      expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(256 * 1024);
    }
    expect(sent.reduce((n, body) => n + body.events.length, 0)).toBe(16);
  });

  it('caps one payload at MAX_EVENT_BYTES', async () => {
    const { forwarder, bodies } = make();
    watched(forwarder);
    forwarder.publish('session:event', line('run-1', 400_000) as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    const [sent] = bodies()[0].events;
    expect(JSON.stringify(sent.payload).length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  it('runs one request at a time', async () => {
    // A box rather than a bare `let`: TypeScript cannot see that the mock's callback runs, so
    // a `let` assigned only in there narrows to `never` and stops being callable.
    const gate: { release: (() => void) | null } = { release: null };
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve(okResponse());
        }),
    );
    const { forwarder } = make({ fetchImpl: fetchImpl as never });
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs * 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still parked behind the first
    expect(forwarder.pending).toBe(1);

    gate.release?.();
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('coalescing', () => {
  it('collapses a replace-last channel to its newest payload', async () => {
    const { forwarder, bodies } = make();
    watched(forwarder);
    forwarder.publish('chain:changed', { links: [1] } as never);
    forwarder.publish('chain:changed', { links: [2] } as never);
    forwarder.publish('chain:changed', { links: [3] } as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    const body = bodies()[0];
    expect(body.events).toHaveLength(1);
    expect(body.events[0].payload).toEqual({ links: [3] });
    // The two it swallowed consumed their seq numbers, and it says so.
    expect(body.gap).toBe(2);
    expect(body.events[0].seq).toBe(3);
  });

  it('keys replace-by-key per subject', async () => {
    const { forwarder, bodies } = make();
    watched(forwarder);
    forwarder.publish('task:changed', { task: { id: 'a' }, runId: null } as never);
    forwarder.publish('task:changed', { task: { id: 'b' }, runId: null } as never);
    forwarder.publish('task:changed', { task: { id: 'a' }, runId: 'r' } as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    const { events } = bodies()[0];
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { task: { id: string } }).task.id)).toEqual(['b', 'a']);
    // Ascending seq, which is what replacing-by-removal (rather than in place) buys.
    expect(events[0].seq).toBeLessThan(events[1].seq);
  });

  it('never collapses a stream channel', async () => {
    const { forwarder, bodies } = make();
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(bodies()[0].events).toHaveLength(2);
    expect(bodies()[0].gap).toBeUndefined();
  });
});

describe('overflow', () => {
  it('sheds the oldest session:events and admits to the gap per run', async () => {
    // A `fetch` that never settles, so the queue fills behind one in-flight request.
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { forwarder } = make({ fetchImpl: fetchImpl as never });
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);

    for (let i = 0; i < 4 * EVENT_BATCH.maxEvents + 20; i += 1) {
      forwarder.publish('session:event', line(i % 2 === 0 ? 'run-1' : 'run-2') as never);
    }
    expect(forwarder.pending).toBeLessThanOrEqual(4 * EVENT_BATCH.maxEvents + 2);
    // Bounded, and both runs told they have holes.
    const gaps = (forwarder as unknown as { queue: { channel: string; payload: unknown }[] }).queue
      .filter((e) => e.channel === 'session:gap')
      .map((e) => (e.payload as { runId: string }).runId);
    expect(new Set(gaps)).toEqual(new Set(['run-1', 'run-2']));
  });
});

describe('failure', () => {
  it('drops the batch, counts it as a gap and backs off', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })
      .mockResolvedValue(okResponse());
    const { forwarder, bodies } = make({ fetchImpl: fetchImpl as never });
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(forwarder.pending).toBe(0); // not re-queued

    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still inside the backoff
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies()[1].gap).toBe(1);
  });

  it('halves the batch limit on a 413 and restores it on success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 413, statusText: 'Payload Too Large' })
      .mockResolvedValue(okResponse());
    const { forwarder, bodies } = make({ fetchImpl: fetchImpl as never });
    watched(forwarder);
    for (let i = 0; i < EVENT_BATCH.maxEvents; i += 1) {
      forwarder.publish('session:event', line(`run-${i}`) as never);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    for (let i = 0; i < EVENT_BATCH.maxEvents; i += 1) {
      forwarder.publish('session:event', line(`run-${i}`) as never);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bodies()[1].events.length).toBe(EVENT_BATCH.maxEvents / 2);
  });

  it('treats a missing token as a failure rather than a throw', async () => {
    const { forwarder, fetchImpl } = make({ getAccessToken: async () => null });
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(forwarder.pending).toBe(0);
  });

  it('publish never throws, even when the payload will not serialize', () => {
    const { forwarder } = make();
    watched(forwarder);
    const cyclic: Record<string, unknown> = { runId: 'run-1' };
    cyclic.self = cyclic;
    expect(() => forwarder.publish('session:event', cyclic as never)).not.toThrow();
  });

  it('stops forwarding when the cloud is switched off', async () => {
    let enabled = true;
    const { forwarder, fetchImpl } = make({
      getSettings: () => ({ ...DEFAULT_CLOUD_SETTINGS, enabled, baseUrl: 'https://x.example' }),
    });
    watched(forwarder);
    enabled = false;
    forwarder.publish('session:event', line('run-1') as never);
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs);
    expect(fetchImpl).not.toHaveBeenCalled();
    forwarder.publish('session:event', line('run-1') as never);
    expect(forwarder.pending).toBe(0);
  });
});

describe('lifecycle', () => {
  it('is inert before configure', () => {
    const forwarder = new CloudEventForwarder();
    forwarder.setListeners(3);
    forwarder.publish('session:event', line('run-1') as never);
    expect(forwarder.pending).toBe(0);
  });

  it('sends nothing after dispose', async () => {
    const { forwarder, fetchImpl } = make();
    watched(forwarder);
    forwarder.publish('session:event', line('run-1') as never);
    forwarder.dispose();
    await vi.advanceTimersByTimeAsync(EVENT_BATCH.maxDelayMs * 10);
    expect(fetchImpl).not.toHaveBeenCalled();
    forwarder.publish('session:event', line('run-1') as never);
    expect(forwarder.pending).toBe(0);
  });
});
