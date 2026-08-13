import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@tm/protocol/wire';
import { EventBus, LISTENER_GRACE_MS, REPLAY_WINDOW_MS, SUBSCRIBER_QUEUE_LIMIT } from './eventBus';

function envelope(channel = 'session:event', seq = 1): EventEnvelope {
  return { channel, payload: { line: `line ${seq}` }, at: seq, seq };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    bus = new EventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fans one batch out to every subscriber on that account, and to nobody else', () => {
    const first = bus.subscribe('account-a', null);
    const second = bus.subscribe('account-a', null);
    const other = bus.subscribe('account-b', null);

    bus.publish('account-a', [envelope('session:event', 1)]);

    expect(first.drain().events.map((e) => e.envelope.seq)).toEqual([1]);
    expect(second.drain().events.map((e) => e.envelope.seq)).toEqual([1]);
    expect(other.drain().events).toEqual([]);
  });

  it('numbers events per account, not per sending client', () => {
    const subscription = bus.subscribe('account-a', null);
    // Two desktop Clients, each with its own `seq` starting at 1.
    bus.publish('account-a', [envelope('session:event', 1)]);
    bus.publish('account-a', [envelope('board:notice', 1)]);

    expect(subscription.drain().events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('refuses a channel the fanout table drops, however it was forwarded', () => {
    const subscription = bus.subscribe('account-a', null);

    bus.publish('account-a', [
      envelope('project:tasksChanged', 1),
      envelope('window:maximizedChanged', 2),
      envelope('task:changed', 3),
      envelope('not-a-channel-at-all', 4),
    ]);

    expect(subscription.drain().events.map((e) => e.envelope.channel)).toEqual(['task:changed']);
  });

  it('replays what a resume missed and says it resumed', () => {
    bus.publish('account-a', [envelope('session:event', 1), envelope('session:event', 2)]);

    const subscription = bus.subscribe('account-a', 1);

    expect(subscription.resumed).toBe(true);
    const { events, gap } = subscription.drain();
    expect(events.map((e) => e.id)).toEqual([2]);
    expect(gap).toBeNull();
  });

  it('resumes with nothing to say when the id is the newest one', () => {
    bus.publish('account-a', [envelope('session:event', 1)]);

    const subscription = bus.subscribe('account-a', 1);

    expect(subscription.resumed).toBe(true);
    expect(subscription.drain()).toEqual({ events: [], gap: null });
  });

  it('counts the hole exactly when a resume arrives after the ring aged out', () => {
    bus.publish('account-a', [
      envelope('session:event', 1),
      envelope('session:event', 2),
      envelope('session:event', 3),
    ]);
    vi.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
    bus.publish('account-a', [envelope('session:event', 4)]);

    const subscription = bus.subscribe('account-a', 1);

    expect(subscription.resumed).toBe(false);
    const { events, gap } = subscription.drain();
    // Ids 2 and 3 aged out; 4 is still there.
    expect(gap).toEqual({ reason: 'expired', count: 2 });
    expect(events.map((e) => e.id)).toEqual([4]);
  });

  it('admits it cannot size a hole when the id is ahead of anything it ever issued', () => {
    const subscription = bus.subscribe('account-a', 42);

    expect(subscription.resumed).toBe(false);
    expect(subscription.drain().gap).toEqual({ reason: 'reset' });
  });

  it('sheds the oldest events for a subscriber that stopped draining, and admits how many', () => {
    const subscription = bus.subscribe('account-a', null);
    const overflow = 10;
    const batch = Array.from({ length: SUBSCRIBER_QUEUE_LIMIT + overflow }, (_, i) =>
      envelope('session:event', i + 1),
    );

    bus.publish('account-a', batch);

    const { events, gap } = subscription.drain();
    expect(events.length).toBe(SUBSCRIBER_QUEUE_LIMIT);
    // The NEWEST survive — a transcript's last lines are the ones somebody is watching.
    expect(events[events.length - 1]!.envelope.seq).toBe(SUBSCRIBER_QUEUE_LIMIT + overflow);
    expect(gap).toEqual({ reason: 'shed', count: overflow });
  });

  it("relays the sender's own admitted gap, ahead of the batch it precedes", () => {
    const subscription = bus.subscribe('account-a', null);

    bus.publish('account-a', [envelope('session:event', 9)], 4);

    const { events, gap } = subscription.drain();
    expect(gap).toEqual({ reason: 'sender', count: 4 });
    expect(events.map((e) => e.envelope.seq)).toEqual([9]);
  });

  it('merges two holes into one frame, keeping the first reason and losing an unknown count', () => {
    const subscription = bus.subscribe('account-a', null);

    subscription.noteGap('sender', 3);
    subscription.noteGap('shed', 2);
    expect(subscription.drain().gap).toEqual({ reason: 'sender', count: 5 });

    subscription.noteGap('sender', 3);
    subscription.noteGap('reset');
    expect(subscription.drain().gap).toEqual({ reason: 'sender' });
  });

  it('wakes the stream as soon as something is queued, and again for a backlog', () => {
    const subscription = bus.subscribe('account-a', null);
    let wakes = 0;
    subscription.onWake(() => {
      wakes += 1;
    });
    expect(wakes).toBe(0);

    bus.publish('account-a', [envelope('session:event', 1)]);
    expect(wakes).toBe(1);

    // A resumed subscription is born holding events, so registering the pump has to fire it.
    const resumed = bus.subscribe('account-a', 0);
    let resumedWakes = 0;
    resumed.onWake(() => {
      resumedWakes += 1;
    });
    expect(resumedWakes).toBe(1);
  });

  describe('listeners', () => {
    it('is zero for an account nobody has ever watched', () => {
      expect(bus.listeners('account-a')).toBe(0);
    });

    it('counts the open subscriptions', () => {
      bus.subscribe('account-a', null);
      bus.subscribe('account-a', null);

      expect(bus.listeners('account-a')).toBe(2);
    });

    it('still answers one through the reconnect grace, then zero', () => {
      const subscription = bus.subscribe('account-a', null);
      subscription.close();

      expect(bus.listeners('account-a')).toBe(1);

      vi.advanceTimersByTime(LISTENER_GRACE_MS + 1);
      expect(bus.listeners('account-a')).toBe(0);
    });
  });

  it('forgets an account once its ring has aged out and nobody is watching', () => {
    bus.subscribe('account-a', null).close();
    bus.publish('account-a', [envelope('session:event', 1)]);

    vi.advanceTimersByTime(REPLAY_WINDOW_MS + LISTENER_GRACE_MS + 1);
    // Any publish prunes every account, not just the one being published to.
    bus.publish('account-b', []);

    // Forgotten, which is what a later `reset` gap is admitting to.
    expect(bus.subscribe('account-a', 1).drain().gap).toEqual({ reason: 'reset' });
  });

  it('delivers nothing to a closed subscription', () => {
    const subscription = bus.subscribe('account-a', null);
    subscription.close();

    bus.publish('account-a', [envelope('session:event', 1)]);

    expect(subscription.drain().events).toEqual([]);
    expect(subscription.isClosed).toBe(true);
  });
});
