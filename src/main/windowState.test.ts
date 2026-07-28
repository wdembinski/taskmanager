import { describe, expect, it } from 'vitest';
import { sanitizeWindowState } from './windowState';

const DEFAULTS = { minWidth: 940, minHeight: 600 };
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
/** A second monitor to the left, as an unplugged-display fixture. */
const SECONDARY = { x: -1920, y: 0, width: 1920, height: 1040 };

describe('sanitizeWindowState', () => {
  it('restores a window that is entirely on a display it still has', () => {
    const saved = { bounds: { x: 100, y: 80, width: 1400, height: 900 }, maximized: false };
    expect(sanitizeWindowState(saved, [PRIMARY], DEFAULTS)).toEqual({
      bounds: { x: 100, y: 80, width: 1400, height: 900 },
      size: { width: 1400, height: 900 },
      maximized: false,
    });
  });

  it('keeps the size but drops the position when the display it was on is gone', () => {
    const saved = { bounds: { x: -1500, y: 100, width: 1400, height: 900 }, maximized: false };
    const onBoth = sanitizeWindowState(saved, [PRIMARY, SECONDARY], DEFAULTS);
    expect(onBoth.bounds).toEqual({ x: -1500, y: 100, width: 1400, height: 900 });

    // Unplug the left-hand monitor: nothing of the window is on the remaining screen.
    const unplugged = sanitizeWindowState(saved, [PRIMARY], DEFAULTS);
    expect(unplugged.bounds).toBeNull();
    expect(unplugged.size).toEqual({ width: 1400, height: 900 });
  });

  it('pulls a window that hangs off an edge back inside the work area', () => {
    const saved = { bounds: { x: 1700, y: 900, width: 1000, height: 700 }, maximized: false };
    const { bounds } = sanitizeWindowState(saved, [PRIMARY], DEFAULTS);
    expect(bounds).toEqual({ x: 920, y: 340, width: 1000, height: 700 });
  });

  it('rejects a position with only a sliver on screen', () => {
    // 20px of the window pokes onto the primary display — not enough to grab.
    const saved = { bounds: { x: -1380, y: 100, width: 1400, height: 900 }, maximized: false };
    expect(sanitizeWindowState(saved, [PRIMARY], DEFAULTS).bounds).toBeNull();
  });

  it('grows a below-minimum size back up to the window minimums', () => {
    const saved = { bounds: { x: 10, y: 10, width: 300, height: 200 }, maximized: false };
    const { bounds } = sanitizeWindowState(saved, [PRIMARY], DEFAULTS);
    expect(bounds).toMatchObject({ width: 940, height: 600 });
  });

  it('shrinks a size larger than any available work area', () => {
    const saved = { bounds: { x: 0, y: 0, width: 3840, height: 2160 }, maximized: false };
    const { bounds } = sanitizeWindowState(saved, [PRIMARY], DEFAULTS);
    expect(bounds).toMatchObject({ width: 1920, height: 1040 });
  });

  it('carries the maximized flag through, including when the position is rejected', () => {
    const good = { bounds: { x: 0, y: 0, width: 1400, height: 900 }, maximized: true };
    expect(sanitizeWindowState(good, [PRIMARY], DEFAULTS).maximized).toBe(true);
    const gone = { bounds: { x: -5000, y: 0, width: 1400, height: 900 }, maximized: true };
    const restored = sanitizeWindowState(gone, [PRIMARY], DEFAULTS);
    expect(restored).toMatchObject({ bounds: null, maximized: true });
  });

  it('treats absent, corrupt and NaN values as "no saved state"', () => {
    for (const value of [
      undefined,
      null,
      'nope',
      42,
      {},
      { bounds: 'x' },
      { bounds: { x: Number.NaN, y: 0, width: 1000, height: 700 } },
      { bounds: { x: 0, y: 0, width: 0, height: 700 } },
      { bounds: { x: 0, y: 0, width: 1000 } },
    ]) {
      expect(sanitizeWindowState(value, [PRIMARY], DEFAULTS)).toMatchObject({
        bounds: null,
        size: null,
      });
    }
  });

  it('keeps the size when the display list is empty (headless / mid-reconfigure)', () => {
    const saved = { bounds: { x: 100, y: 100, width: 1400, height: 900 }, maximized: false };
    expect(sanitizeWindowState(saved, [], DEFAULTS)).toEqual({
      bounds: null,
      size: { width: 1400, height: 900 },
      maximized: false,
    });
  });
});
