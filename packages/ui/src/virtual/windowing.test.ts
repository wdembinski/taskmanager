/**
 * The windowing sums (F29.3): which rows mount, where a list starts inside its scroller, and
 * the rect a card that is not mounted would have.
 */
import { describe, expect, it } from 'vitest';
import { mergePinned, offsetWithin, syntheticRect, type WindowRange } from './windowing';

function range(startIndex: number, endIndex: number, overscan: number, count: number): WindowRange {
  return { startIndex, endIndex, overscan, count };
}

describe('mergePinned', () => {
  it('mounts the visible range widened by its overscan', () => {
    expect(mergePinned(range(10, 12, 2, 100), [])).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('clamps the overscan to the ends of the list', () => {
    expect(mergePinned(range(0, 2, 3, 4), [])).toEqual([0, 1, 2, 3]);
  });

  it('adds a pinned row outside the range, in order', () => {
    expect(mergePinned(range(10, 11, 0, 100), [90, 2])).toEqual([2, 10, 11, 90]);
  });

  it('does not repeat a pinned row already in the range, or one pinned twice', () => {
    expect(mergePinned(range(10, 12, 0, 100), [11, 50, 50])).toEqual([10, 11, 12, 50]);
  });

  it('drops a pinned index the list does not have', () => {
    expect(mergePinned(range(0, 1, 0, 5), [-1, 5, 7, 2.5, 4])).toEqual([0, 1, 4]);
  });

  it('mounts nothing for an empty list', () => {
    expect(mergePinned(range(0, 0, 6, 0), [0])).toEqual([]);
  });
});

describe('offsetWithin', () => {
  const box = (top: number) => ({ getBoundingClientRect: () => ({ top }) });

  it('is the list top minus the scroller top at rest', () => {
    expect(offsetWithin(box(140), { ...box(100), scrollTop: 0 })).toBe(40);
  });

  it('stays the same however far the scroller has scrolled', () => {
    // Scrolled 300px: the list's box has moved up by exactly that much.
    expect(offsetWithin(box(140 - 300), { ...box(100), scrollTop: 300 })).toBe(40);
  });

  it("measures from inside the scroller's top border", () => {
    expect(offsetWithin(box(140), { ...box(100), scrollTop: 0, clientTop: 1 })).toBe(39);
  });
});

describe('syntheticRect', () => {
  it("takes the list's left and width and the row's own offset and height", () => {
    expect(syntheticRect({ left: 20, top: 50, width: 280 }, { start: 400, size: 96 })).toEqual({
      left: 20,
      top: 450,
      right: 300,
      bottom: 546,
      width: 280,
      height: 96,
    });
  });

  it('puts the first row at the top of the list', () => {
    const r = syntheticRect({ left: 0, top: 30, width: 100 }, { start: 0, size: 10 });
    expect(r.top).toBe(30);
    expect(r.bottom).toBe(40);
  });
});
