/**
 * The windowing sums (F29.3): which rows mount, where a list starts inside its scroller, and
 * the rect a card that is not mounted would have.
 */
import { describe, expect, it } from 'vitest';
import type { AnchorRect } from '../board/chainArrows';
import { mergeAnchorRects } from '../board/useCardAnchors';
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

describe('mergeAnchorRects', () => {
  const rect = (left: number, top: number, width: number, height: number): AnchorRect => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  });
  // Two windowed columns side by side: To Do at x=10, In Progress at x=310, both 280 wide,
  // lists starting at y=60. Each card 100 tall, 12 apart, the list's 6px inset included.
  const items = (ids: string[]) => ids.map((id, i) => ({ id, start: 6 + i * 112, size: 100 }));
  const todo = { index: 0, box: { left: 10, top: 60, width: 280 }, items: items(['a', 'b', 'c']) };
  const doing = { index: 1, box: { left: 310, top: 60, width: 280 }, items: items(['d', 'e']) };

  it('gives an unmounted card a rect in its own column at its offset down the list', () => {
    const { rects, cardColumns } = mergeAnchorRects(new Map(), new Map(), [todo, doing]);
    expect(rects.get('c')).toEqual(rect(10, 60 + 6 + 224, 280, 100));
    expect(rects.get('e')).toEqual(rect(310, 60 + 6 + 112, 280, 100));
    expect(cardColumns.get('c')).toBe(0);
    expect(cardColumns.get('e')).toBe(1);
  });

  it("keeps a mounted card's DOM rect over its synthetic one", () => {
    const dom = new Map([['b', rect(12, 179, 276, 104)]]);
    const { rects } = mergeAnchorRects(dom, new Map(), [todo]);
    expect(rects.get('b')).toEqual(rect(12, 179, 276, 104));
    expect(rects.get('a')).toEqual(rect(10, 66, 280, 100));
  });

  it('takes the column from the provider, not from the DOM', () => {
    const dom = new Map([['d', rect(310, 66, 280, 100)]]);
    const { cardColumns } = mergeAnchorRects(dom, new Map([['d', 4]]), [doing]);
    expect(cardColumns.get('d')).toBe(1);
  });

  it('keeps the DOM column for a mounted card no column claims', () => {
    const dom = new Map([['z', rect(0, 0, 10, 10)]]);
    const { cardColumns } = mergeAnchorRects(dom, new Map([['z', 2]]), [todo]);
    expect(cardColumns.get('z')).toBe(2);
  });

  it('spans every card, mounted or not, for the overlay height and the bus floor', () => {
    const dom = new Map([['a', rect(10, 66, 280, 100)]]);
    const { lowest, highest } = mergeAnchorRects(dom, new Map(), [todo, doing]);
    expect(lowest).toBe(60 + 6 + 224 + 100);
    expect(highest).toBe(66);
  });

  it('has no floor with no cards at all', () => {
    const { highest, lowest } = mergeAnchorRects(new Map(), new Map(), []);
    expect(highest).toBe(Infinity);
    expect(lowest).toBe(0);
  });
});
