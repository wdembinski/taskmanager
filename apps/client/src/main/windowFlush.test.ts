import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowStateFlusher, type WindowStateFlusherDeps } from './windowFlush';
import type { SavedWindowState } from './windowState';

function state(x: number): SavedWindowState {
  return { bounds: { x, y: 0, width: 800, height: 600 }, maximized: false };
}

/**
 * A window + store stand-in the test drives by hand: `at` is the geometry `read()` would
 * see now, and `open`/`alive` are the two halves of `canWrite()`.
 */
function harness(overrides: Partial<WindowStateFlusherDeps> = {}) {
  const writes: SavedWindowState[] = [];
  const box = { at: 0, open: true, alive: true };
  const read = vi.fn(() => state(box.at));
  const write = vi.fn((s: SavedWindowState) => {
    // The real store throws here once the handle is gone — the whole point of `canWrite`.
    if (!box.open) throw new TypeError('The database connection is not open');
    writes.push(s);
  });
  const flusher = createWindowStateFlusher({
    read,
    write,
    canWrite: () => box.alive && box.open,
    ...overrides,
  });
  return { flusher, writes, box, read, write };
}

describe('createWindowStateFlusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a burst of schedules into one write carrying the latest geometry', () => {
    const { flusher, writes, box } = harness();

    box.at = 10;
    flusher.schedule();
    vi.advanceTimersByTime(150);
    box.at = 20;
    flusher.schedule();
    vi.advanceTimersByTime(150);
    box.at = 30;
    flusher.schedule();
    expect(writes).toHaveLength(0);

    vi.advanceTimersByTime(400);
    expect(writes).toEqual([state(30)]);
  });

  it('flushes the pending save immediately on dispose, and cancels the timer', () => {
    const { flusher, writes, box } = harness();

    box.at = 42;
    flusher.schedule();
    flusher.dispose();
    expect(writes).toEqual([state(42)]);

    // The cancelled timer must not fire a second write behind it.
    vi.advanceTimersByTime(1000);
    expect(writes).toEqual([state(42)]);
  });

  // The regression this module exists for: on quit the window's `close` handler disposes,
  // then the engine's teardown closes the store and disposes again. The second dispose
  // used to reach `store.saveWindowState`, which threw `TypeError: The database connection
  // is not open` from an event handler — straight into the "Unexpected error" dialog.
  // The disposed flag and the `canWrite` guard each stop it on their own, so this one goes
  // red only when both are gone; the two tests below pin them down one at a time.
  it('does not write, or throw, when disposed again after the store has closed', () => {
    const { flusher, writes, box } = harness();

    box.at = 7;
    flusher.schedule();
    flusher.dispose();
    expect(writes).toEqual([state(7)]);

    box.open = false;
    expect(() => flusher.dispose()).not.toThrow();
    expect(writes).toEqual([state(7)]);
  });

  // The half of that the store-closed test cannot isolate: the two guards overlap there,
  // so each one alone keeps it green. This one is red the moment the flag goes.
  it('writes once however many times it is disposed', () => {
    const { flusher, writes, box } = harness();

    box.at = 1;
    flusher.dispose();
    box.at = 2;
    flusher.dispose();
    flusher.dispose();
    expect(writes).toEqual([state(1)]);
  });

  it('ignores a schedule that arrives after dispose', () => {
    const { flusher, writes, box } = harness();

    flusher.dispose();
    writes.length = 0;
    box.at = 99;
    flusher.schedule();
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(0);
  });

  it('never reads the geometry when a write would not be safe', () => {
    const { flusher, writes, read, box } = harness();

    // A destroyed window: `getNormalBounds()` throws in its own right, so the guard has to
    // come before the snapshot, not between the snapshot and the write.
    box.alive = false;
    flusher.schedule();
    flusher.dispose();

    expect(writes).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });
});
