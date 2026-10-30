/**
 * The pure half of windowing (F29.3) — the sums `useWindowedList` and the chain overlay's
 * `useCardAnchors` lean on, kept free of React and the DOM so they are tested here rather
 * than through a browser.
 *
 * Three answers live here:
 * - which rows to mount: the visible range plus its overscan, plus the rows that must stay
 *   mounted wherever they are ({@link mergePinned});
 * - where a list starts inside the scroller it windows against ({@link offsetWithin}) — the
 *   virtualizer's `scrollMargin`;
 * - the rect a card WOULD have if it were mounted ({@link syntheticRect}), so an arrow can
 *   still reach a card the window left out.
 */
import type { AnchorRect } from '../board/chainArrows';

/**
 * The visible span of a windowed list — the same shape `@tanstack/react-virtual` hands its
 * `rangeExtractor`, so a range can be passed straight through.
 */
export interface WindowRange {
  /** The first row on screen. */
  startIndex: number;
  /** The last row on screen. */
  endIndex: number;
  /** How many rows to mount beyond each edge. */
  overscan: number;
  /** How many rows the list holds. */
  count: number;
}

/**
 * The rows to mount: the visible range widened by its overscan, plus every pinned row —
 * the selected card, the row holding focus, the card being dragged — however far off screen
 * it is. Sorted, without duplicates, and never an index the list does not have.
 */
export function mergePinned(range: WindowRange, pinned: Iterable<number>): number[] {
  const out = new Set<number>();
  if (range.count <= 0) return [];
  const from = Math.max(0, range.startIndex - range.overscan);
  const to = Math.min(range.count - 1, range.endIndex + range.overscan);
  for (let i = from; i <= to; i++) out.add(i);
  for (const i of pinned) {
    if (Number.isInteger(i) && i >= 0 && i < range.count) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** The slice of an element `offsetWithin` reads — narrow, so a test can hand it a stub. */
export interface BoxLike {
  getBoundingClientRect(): { top: number };
}

/** The scroller's slice: its box, how far it has scrolled, and its top border. */
export interface ScrollerLike extends BoxLike {
  scrollTop: number;
  /** The top border's width; absent counts as none. */
  clientTop?: number;
}

/**
 * How far below the top of its scroller's CONTENT a list starts — the virtualizer's
 * `scrollMargin`. Constant while the scroller scrolls (the list's box and the scroll offset
 * move together), so it only changes when something above the list changes size.
 */
export function offsetWithin(list: BoxLike, scroller: ScrollerLike): number {
  const listTop = list.getBoundingClientRect().top;
  const scrollerTop = scroller.getBoundingClientRect().top + (scroller.clientTop ?? 0);
  return listTop - scrollerTop + scroller.scrollTop;
}

/** A windowed list's own box, in the same space the rects are wanted in. */
export interface ListBox {
  left: number;
  top: number;
  width: number;
}

/** One row of a windowed list: its offset from the top of the list, and its height. */
export interface WindowItem {
  start: number;
  size: number;
}

/**
 * The rect a row would have if it were mounted: the list's left edge and width, its own
 * offset down the list, and its height — measured if it was ever mounted, estimated if not.
 */
export function syntheticRect(listBox: ListBox, item: WindowItem): AnchorRect {
  const top = listBox.top + item.start;
  return {
    left: listBox.left,
    top,
    right: listBox.left + listBox.width,
    bottom: top + item.size,
    width: listBox.width,
    height: item.size,
  };
}
