import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLongTaskObserver, setPerfScreen, type LongTaskEntry } from './perfObserver';

type Callback = (list: { getEntries: () => { duration: number; startTime: number }[] }) => void;

/** A stand-in `PerformanceObserver` that records what it was asked and lets a test emit. */
class FakeObserver {
  static supportedEntryTypes: string[] = ['longtask'];
  static instances: FakeObserver[] = [];
  observed: unknown = null;
  disconnected = false;
  constructor(private readonly callback: Callback) {
    FakeObserver.instances.push(this);
  }
  observe(options: unknown): void {
    this.observed = options;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  emit(...entries: { duration: number; startTime: number }[]): void {
    this.callback({ getEntries: () => entries });
  }
}

const original = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;

beforeEach(() => {
  FakeObserver.instances = [];
  FakeObserver.supportedEntryTypes = ['longtask'];
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = FakeObserver;
  setPerfScreen('boot');
});

afterEach(() => {
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = original;
});

describe('installLongTaskObserver', () => {
  it('sends each long task to the sink with the current screen', () => {
    const seen: LongTaskEntry[] = [];
    installLongTaskObserver({ enabled: true, sink: (e) => seen.push(e) });
    const [observer] = FakeObserver.instances;
    expect(observer.observed).toEqual({ type: 'longtask', buffered: true });

    setPerfScreen('mytasks');
    observer.emit({ duration: 80, startTime: 10 });
    setPerfScreen('mytasks/card');
    observer.emit({ duration: 120, startTime: 200 }, { duration: 55, startTime: 400 });

    expect(seen).toEqual([
      { screen: 'mytasks', ms: 80, at: 10 },
      { screen: 'mytasks/card', ms: 120, at: 200 },
      { screen: 'mytasks/card', ms: 55, at: 400 },
    ]);
  });

  it('is a no-op when disabled', () => {
    const sink = vi.fn();
    const dispose = installLongTaskObserver({ enabled: false, sink });
    expect(FakeObserver.instances).toHaveLength(0);
    expect(() => dispose()).not.toThrow();
  });

  it('is a no-op when longtask or PerformanceObserver is unsupported, or there is no sink', () => {
    FakeObserver.supportedEntryTypes = ['mark'];
    installLongTaskObserver({ enabled: true, sink: vi.fn() });
    installLongTaskObserver({ enabled: true, sink: undefined });
    delete (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    expect(() => installLongTaskObserver({ enabled: true, sink: vi.fn() })()).not.toThrow();
    expect(FakeObserver.instances).toHaveLength(0);
  });

  it('disconnects on dispose', () => {
    const dispose = installLongTaskObserver({ enabled: true, sink: vi.fn() });
    const [observer] = FakeObserver.instances;
    expect(observer.disconnected).toBe(false);
    dispose();
    expect(observer.disconnected).toBe(true);
  });

  it('survives a sink that throws', () => {
    installLongTaskObserver({
      enabled: true,
      sink: () => {
        throw new Error('ipc gone');
      },
    });
    expect(() => FakeObserver.instances[0].emit({ duration: 60, startTime: 0 })).not.toThrow();
  });
});
