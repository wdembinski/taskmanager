import { describe, expect, it, vi } from 'vitest';
import { PolledEventBus, REPRODUCIBLE_EVENTS, UNREPRODUCIBLE_EVENTS } from './polledEvents';
import type { IpcApi } from '@tm/shared/ipc';

/**
 * A fake engine: each channel returns whatever the test last put in the map, and every call
 * is counted so "only the reads someone is subscribed to" can be asserted rather than
 * assumed.
 */
function fakeEngine(seed: Partial<Record<string, unknown>> = {}) {
  const answers = new Map<string, unknown>(Object.entries(seed));
  const calls: string[] = [];
  const invoke = (async (channel: string) => {
    calls.push(channel);
    if (!answers.has(channel)) throw new Error(`no fake answer for ${channel}`);
    return answers.get(channel);
  }) as PolledEventBusDepsInvoke;
  return {
    invoke,
    calls,
    set: (channel: string, value: unknown) => answers.set(channel, value),
  };
}

type PolledEventBusDepsInvoke = <K extends keyof IpcApi>(
  channel: K,
  ...args: Parameters<IpcApi[K]>
) => Promise<Awaited<ReturnType<IpcApi[K]>>>;

/** A bus with no timer of its own — the tests drive `poll()` by hand. */
function makeBus(engine: ReturnType<typeof fakeEngine>) {
  return new PolledEventBus({
    invoke: engine.invoke,
    setIntervalImpl: (() => 0) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  });
}

describe('PolledEventBus: reproducing a whole-list event', () => {
  it('does not emit on the first read — that is the mount value, not a change', async () => {
    const engine = fakeEngine({ 'chain:links': [{ id: 'l1' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('chain:changed', seen);

    await bus.poll();
    expect(seen).not.toHaveBeenCalled();
  });

  it('emits the new list once it differs', async () => {
    const engine = fakeEngine({ 'chain:links': [{ id: 'l1' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('chain:changed', seen);

    await bus.poll();
    engine.set('chain:links', [{ id: 'l1' }, { id: 'l2' }]);
    await bus.poll();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([{ id: 'l1' }, { id: 'l2' }]);
  });

  it('stays quiet while the list is unchanged', async () => {
    const engine = fakeEngine({ 'chain:links': [{ id: 'l1' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('chain:changed', seen);

    await bus.poll();
    await bus.poll();
    await bus.poll();
    expect(seen).not.toHaveBeenCalled();
  });

  it('reads only what someone is subscribed to', async () => {
    const engine = fakeEngine({ 'chain:links': [], 'attachment:list': [] });
    const bus = makeBus(engine);
    bus.on('chain:changed', vi.fn());

    await bus.poll();
    expect(engine.calls).toEqual(['chain:links']);
  });

  it('stops reading once the last subscriber leaves', async () => {
    const engine = fakeEngine({ 'chain:links': [] });
    const bus = makeBus(engine);
    const off = bus.on('chain:changed', vi.fn());

    await bus.poll();
    off();
    await bus.poll();
    expect(engine.calls).toEqual(['chain:links']);
  });

  it('re-baselines for a fresh subscriber rather than announcing history at it', async () => {
    const engine = fakeEngine({ 'chain:links': [{ id: 'l1' }] });
    const bus = makeBus(engine);
    const off = bus.on('chain:changed', vi.fn());
    await bus.poll();
    off();

    engine.set('chain:links', [{ id: 'l9' }]);
    const later = vi.fn();
    bus.on('chain:changed', later);
    await bus.poll();
    expect(later).not.toHaveBeenCalled();
  });

  it('survives a read that rejects, and reports it', async () => {
    const onError = vi.fn();
    const bus = new PolledEventBus({
      invoke: (async () => {
        throw new Error('the desktop is asleep');
      }) as PolledEventBusDepsInvoke,
      setIntervalImpl: (() => 0) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
      onError,
    });
    const seen = vi.fn();
    bus.on('chain:changed', seen);

    await expect(bus.poll()).resolves.toBeUndefined();
    expect(seen).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('chain:links', expect.any(Error));
  });
});

describe('PolledEventBus: task:changed from a board diff', () => {
  it('emits one event per changed card, not one for the board', async () => {
    const engine = fakeEngine({
      'board:tasks': [
        { id: 't1', status: 'pending' },
        { id: 't2', status: 'pending' },
      ],
    });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('task:changed', seen);

    await bus.poll();
    engine.set('board:tasks', [
      { id: 't1', status: 'done' },
      { id: 't2', status: 'pending' },
    ]);
    await bus.poll();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ task: { id: 't1', status: 'done' }, runId: null });
  });

  it('emits for a card that has just appeared', async () => {
    const engine = fakeEngine({ 'board:tasks': [{ id: 't1' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('task:changed', seen);

    await bus.poll();
    engine.set('board:tasks', [{ id: 't1' }, { id: 't2' }]);
    await bus.poll();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ task: { id: 't2' }, runId: null });
  });

  it('says nothing about a card that has gone — that is a deletion, not a change', async () => {
    // The mirror's own `deletedTaskIds` is what reports a removal; a fabricated
    // `task:changed` for a card that no longer exists would put it back on screen.
    const engine = fakeEngine({ 'board:tasks': [{ id: 't1' }, { id: 't2' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('task:changed', seen);

    await bus.poll();
    engine.set('board:tasks', [{ id: 't1' }]);
    await bus.poll();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('PolledEventBus: the inbox’s two edges from one list', () => {
  it('reads attention:list once for both events', async () => {
    const engine = fakeEngine({ 'attention:list': [] });
    const bus = makeBus(engine);
    bus.on('attention:new', vi.fn());
    bus.on('attention:resolved', vi.fn());

    await bus.poll();
    expect(engine.calls).toEqual(['attention:list']);
  });

  it('announces an item that appeared and one that went', async () => {
    const engine = fakeEngine({ 'attention:list': [{ id: 'a1', kind: 'question' }] });
    const bus = makeBus(engine);
    const arrived = vi.fn();
    const resolved = vi.fn();
    bus.on('attention:new', arrived);
    bus.on('attention:resolved', resolved);

    await bus.poll();
    engine.set('attention:list', [{ id: 'a2', kind: 'permission' }]);
    await bus.poll();

    expect(arrived).toHaveBeenCalledWith({ id: 'a2', kind: 'permission' });
    expect(resolved).toHaveBeenCalledWith({ id: 'a1' });
  });
});

describe('PolledEventBus: pausing for the pushed stream', () => {
  it('keeps its baselines while paused, so the resume announces what changed meanwhile', async () => {
    const engine = fakeEngine({ 'chain:links': [{ id: 'l1' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('chain:changed', seen);

    await bus.poll(); // baseline
    bus.pause();
    engine.set('chain:links', [{ id: 'l1' }, { id: 'l2' }]);
    bus.resume();
    await bus.poll();

    // Against a CLEARED baseline this would have been the mount value and emitted nothing —
    // which is the failure `eventBus.ts` pauses (rather than unsubscribes) to avoid.
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([{ id: 'l1' }, { id: 'l2' }]);
  });

  it('runs no timer while paused, and one again after a resume', () => {
    const engine = fakeEngine({ 'chain:links': [] });
    const timers: Array<number | null> = [];
    const bus = new PolledEventBus({
      invoke: engine.invoke,
      setIntervalImpl: (() => {
        timers.push(timers.length + 1);
        return timers.length;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: ((id: number) =>
        timers.splice(timers.indexOf(id), 1)) as unknown as typeof clearInterval,
    });

    bus.on('chain:changed', vi.fn());
    expect(timers).toHaveLength(1);
    bus.pause();
    expect(timers).toHaveLength(0);
    bus.resume();
    expect(timers).toHaveLength(1);
    bus.dispose();
  });

  it('still answers an explicit poll while paused — that is the catch-up read', async () => {
    const engine = fakeEngine({ 'chain:links': [{ id: 'l1' }] });
    const bus = makeBus(engine);
    const seen = vi.fn();
    bus.on('chain:changed', seen);

    await bus.poll();
    bus.pause();
    engine.set('chain:links', []);
    await bus.poll();

    expect(seen).toHaveBeenCalledWith([]);
  });
});

describe('what this bus does and does not claim', () => {
  it('lists the events it can reproduce', () => {
    expect(REPRODUCIBLE_EVENTS).toContain('chain:changed');
    expect(REPRODUCIBLE_EVENTS).toContain('task:changed');
    expect(REPRODUCIBLE_EVENTS).toContain('attention:new');
    expect(REPRODUCIBLE_EVENTS).not.toContain('board:notice');
  });

  it('gives a reason for each one it cannot, rather than being silently short', () => {
    for (const [event, reason] of Object.entries(UNREPRODUCIBLE_EVENTS)) {
      expect(reason.length, `${event} has no reason`).toBeGreaterThan(10);
    }
    expect(Object.keys(UNREPRODUCIBLE_EVENTS)).toContain('window:maximizedChanged');
    expect(Object.keys(UNREPRODUCIBLE_EVENTS)).toContain('board:notice');
  });

  it('accepts a subscription to an unreproducible event without throwing', async () => {
    // The caller is shared UI that also runs on the desktop, where the event is real. Making
    // it branch on the host is exactly what `Transport` exists to avoid.
    const engine = fakeEngine({});
    const bus = makeBus(engine);
    const seen = vi.fn();
    expect(() => bus.on('board:notice', seen)).not.toThrow();
    await bus.poll();
    expect(seen).not.toHaveBeenCalled();
    expect(engine.calls).toEqual([]);
  });

  it('drops everything on dispose', async () => {
    const engine = fakeEngine({ 'chain:links': [] });
    const bus = makeBus(engine);
    bus.on('chain:changed', vi.fn());
    await bus.poll();
    const before = engine.calls.length;

    bus.dispose();
    await bus.poll();
    expect(engine.calls.length).toBe(before);
  });
});
