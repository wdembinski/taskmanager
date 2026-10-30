/**
 * One windowed list (F29.3) — the board's columns, the issue list and the sidebar tree all
 * draw only the rows in view through this, so the house rules live in one place:
 *
 * - **Pinned rows** stay mounted wherever they are: the caller's own (`pinned` — the
 *   selection, the card being dragged) plus the row holding DOM focus, which this hook
 *   tracks itself with `focusin`/`focusout` on the list. A row that unmounts takes keyboard
 *   focus and a native drag with it.
 * - **`scrollMargin` kept fresh**: a list windows against a scroller it does not own (the
 *   board's ONE scroller holds every column), so where the list starts inside it is read with
 *   {@link offsetWithin} and re-read whenever the list or the scroller changes size.
 * - **`enabled: false` renders everything**: `windowed` comes back false and the caller
 *   draws its rows in normal flow, exactly as before — the phone's single column does.
 *
 * Rows are placed by the caller: a `position: relative; height: totalSize` list, each row at
 * `translateY(start)`, carrying `data-index={index}` and `ref={measureElement}` so a row of
 * any height is measured once it is drawn. `start` is relative to the list, not the scroller.
 *
 * The library is `@tanstack/react-virtual`; the sums it does not do live in `windowing.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer, type Range } from '@tanstack/react-virtual';
import { mergePinned, offsetWithin } from './windowing';

export interface UseWindowedListOptions {
  /** How many rows the list holds. */
  count: number;
  /** Each row's stable identity — a task id, a group key. */
  keyOf: (index: number) => string;
  /** The scroller the list windows against. Null (or absent) renders every row. */
  getScrollElement: () => HTMLElement | null;
  /** A row's expected height, gap included — replaced by its measured height once drawn. */
  estimateSize: (index: number) => number;
  /** Rows mounted beyond each edge of the view. */
  overscan: number;
  /** Rows that must stay mounted even off screen. Indices; out-of-range ones are ignored. */
  pinned?: readonly number[];
  /** Space between rows, in px — part of the total height, never of a row's own size. */
  gap?: number;
  /** False draws every row in normal flow; see `windowed` on the result. Default true. */
  enabled?: boolean;
}

/** A row to draw: where it sits down the list and how tall it is (measured or estimated). */
export interface WindowedRow {
  index: number;
  key: string;
  /** Offset from the top of the LIST, for `translateY`. */
  start: number;
  size: number;
}

export interface WindowedList {
  /** False: draw every row in normal flow, ignoring `rows`' `start`. */
  windowed: boolean;
  /** The rows to mount, in order — every row when not windowed. */
  rows: WindowedRow[];
  /** The list's full height, so the scroll extent stays what it would be with every row. */
  totalSize: number;
  /** Set on the list element: what `scrollMargin` is measured from and focus is tracked on. */
  listRef: (el: HTMLElement | null) => void;
  /** Set on each row (with `data-index`), so its real height replaces the estimate. */
  measureElement: (el: Element | null) => void;
  /** Every row's offset and size, mounted or not — what the chain overlay builds rects from. */
  layout: () => WindowedRow[];
  /** Scrolls the scroller until row `index` is in view (`'auto'`: only as far as needed) — a
   *  no-op when not windowed, where every row is already drawn. */
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void;
}

/** Which row the focused element sits in — the `data-index` the caller put on each row. */
function rowIndexOf(target: EventTarget | null, list: HTMLElement): number | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest('[data-index]');
  if (!row || !list.contains(row)) return null;
  const index = Number(row.getAttribute('data-index'));
  return Number.isInteger(index) ? index : null;
}

export function useWindowedList(options: UseWindowedListOptions): WindowedList {
  const { count, keyOf, getScrollElement, estimateSize, overscan, gap = 0 } = options;
  // Read during render, so a caller must hold its scroller in state (a callback ref that
  // re-renders) — a scroller that turns up later then switches windowing on.
  const scroller = (options.enabled ?? true) ? getScrollElement() : null;
  const enabled = scroller !== null;

  const [listEl, setListEl] = useState<HTMLElement | null>(null);
  const listRef = useCallback((el: HTMLElement | null) => setListEl(el), []);

  // Held by KEY, not index: a delta that re-sorts the list moves the focused row, and the
  // index it was focused at would then pin a stranger.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  useEffect(() => {
    if (!listEl) return;
    const onIn = (e: FocusEvent): void => {
      const index = rowIndexOf(e.target, listEl);
      setFocusedKey(index === null ? null : keyOfRef.current(index));
    };
    const onOut = (e: FocusEvent): void => {
      // Focus moving to another row arrives as its own `focusin`; only leaving the list clears.
      if (!(e.relatedTarget instanceof Node) || !listEl.contains(e.relatedTarget)) {
        setFocusedKey(null);
      }
    };
    listEl.addEventListener('focusin', onIn);
    listEl.addEventListener('focusout', onOut);
    return () => {
      listEl.removeEventListener('focusin', onIn);
      listEl.removeEventListener('focusout', onOut);
    };
  }, [listEl]);

  const pinned = useMemo(() => {
    const all = [...(options.pinned ?? [])];
    if (focusedKey !== null) {
      for (let i = 0; i < count; i++) {
        if (keyOf(i) === focusedKey) {
          all.push(i);
          break;
        }
      }
    }
    return all;
    // `keyOf` is often inline; the pins only move when what they name does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.pinned?.join(','), focusedKey, count]);

  // A new extractor whenever the pins change is what makes the virtualizer recompute its
  // range — it memoises the range on the extractor's identity.
  const pinnedKey = pinned.join(',');
  const rangeExtractor = useCallback(
    (range: Range) => mergePinned(range, pinned),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinnedKey],
  );

  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (!listEl || !scroller) return;
    const read = (): void => {
      const next = offsetWithin(listEl, scroller);
      setScrollMargin((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(listEl);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [listEl, scroller, count]);

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count,
    getScrollElement,
    estimateSize,
    overscan,
    gap,
    rangeExtractor,
    scrollMargin,
    getItemKey: (index) => keyOf(index),
    enabled,
  });

  const measureElement = useCallback(
    (el: Element | null) => {
      if (el) virtualizer.measureElement(el);
    },
    [virtualizer],
  );

  // Read off the cache the last render's `getVirtualItems` filled — a lazy view, so it is
  // walked by index rather than spread.
  const layout = useCallback((): WindowedRow[] => {
    const cache = virtualizer.measurementsCache;
    const out: WindowedRow[] = [];
    for (let i = 0; i < cache.length; i++) {
      const m = cache[i];
      if (m)
        out.push({
          index: m.index,
          key: String(m.key),
          start: m.start - scrollMargin,
          size: m.size,
        });
    }
    return out;
  }, [virtualizer, scrollMargin]);

  const scrollToIndex = useCallback(
    (index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }) => {
      if (enabled && index >= 0 && index < count) virtualizer.scrollToIndex(index, opts);
    },
    [virtualizer, enabled, count],
  );

  if (!enabled) {
    const rows: WindowedRow[] = [];
    for (let i = 0; i < count; i++) rows.push({ index: i, key: keyOf(i), start: 0, size: 0 });
    return {
      windowed: false,
      rows,
      totalSize: 0,
      listRef,
      measureElement,
      layout,
      scrollToIndex,
    };
  }

  const rows = virtualizer.getVirtualItems().map((item) => ({
    index: item.index,
    key: String(item.key),
    start: item.start - scrollMargin,
    size: item.size,
  }));
  return {
    windowed: true,
    rows,
    // Already measured from the list's own top: the library takes `scrollMargin` off it.
    totalSize: virtualizer.getTotalSize(),
    listRef,
    measureElement,
    layout,
    scrollToIndex,
  };
}
