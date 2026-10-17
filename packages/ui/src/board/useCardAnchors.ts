/**
 * Where every card on the board currently is — the measurement the chain overlay draws from.
 *
 * The arrows are one `<svg>` laid over the WHOLE board rather than a line per pair of cards,
 * which is only possible because `MyTasks.columns` is the single scrolling element: one
 * absolutely-positioned layer inside it shares the cards' coordinate space and scrolls with
 * them, so scrolling costs nothing and no arrow can ever lag its cards by a frame.
 *
 * The coordinates are that container's **content space** — client rect minus the container's
 * own origin, plus its scroll offset — which is exactly the space an absolutely-positioned
 * child of it is laid out in. Measured with `getBoundingClientRect` on both ends rather than
 * `offsetTop`, because the cards are several boxes deep inside the columns and `offsetParent`
 * would be whichever of them happens to be positioned.
 *
 * Re-measured when anything can have moved: the container or any card resizing (one
 * `ResizeObserver` over both), a scroll, a card mounting or unmounting, and whenever the
 * caller says the card list changed — which is the case the observers cannot see, since
 * re-sorting a column moves cards without resizing anything.
 *
 * It also owns which card the pointer is over. Not a separate concern bolted on: this hook is
 * already the one thing holding every card's DOM node, so it is the cheapest place in the app
 * to know, and the alternative was threading two more callbacks through `KanbanColumn` into
 * `TaskCard` for a fact only the overlay wants.
 *
 * The same measure pass also reads the board's wiring space for `chainRoute`'s router: every
 * `[data-board-column]` element's content-space extent (`KanbanColumn`'s own root) and every
 * `[data-board-column-header]`'s bottom edge (the sticky header). A card's column is read off
 * its nearest `[data-board-column]` ancestor rather than passed in, since the column already
 * has to carry that marker for its own extent to be measured — asking the DOM once is cheaper
 * than threading a second index through `KanbanColumn`/`TaskCard` alongside `anchorRef`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnchorRect } from './chainArrows';
import type { ColumnBand, RouteLayout } from './chainRoute';

/** The overlay's own box: the board's visible width, and everything down to the last card. */
export interface AnchorBounds {
  width: number;
  height: number;
}

export interface CardAnchors {
  /** Put this on the scrolling column container. */
  containerRef: (el: HTMLDivElement | null) => void;
  /**
   * The ref for one card's root element. Stable per task id, so a re-render does not
   * detach and re-attach every card's ref — React calls a ref callback with `null` and
   * then the element again whenever its identity changes.
   */
  anchorRef: (taskId: string) => (el: HTMLDivElement | null) => void;
  rects: ReadonlyMap<string, AnchorRect>;
  bounds: AnchorBounds;
  /** Every card's column index, for `chainRoute`'s `RouteCard.column`. Absent for a card
   *  whose nearest `[data-board-column]` ancestor was not found — the compact board's single
   *  column still carries the marker, so this is populated there too. */
  cardColumns: ReadonlyMap<string, number>;
  /** The board's wiring space — where the columns and the bus band sit — for `routeChainLinks`. */
  layout: RouteLayout;
  hoveredTaskId: string | null;
  /**
   * A pointer's VIEWPORT coordinates (a drag event's `clientX`/`clientY`) turned into the
   * same board content space the rects are in — what the rubber band's loose end needs.
   *
   * Here rather than in the component because this hook already owns the container element
   * and the one formula that maps into its content space; a second copy of "minus the
   * origin, plus the scroll" elsewhere is a second thing to get wrong when either changes.
   * Null before the container mounts.
   */
  toContentPoint: (clientX: number, clientY: number) => { x: number; y: number } | null;
}

/** Whether two measurements say the same thing, so an idle re-measure re-renders nothing. */
function sameRects(
  a: ReadonlyMap<string, AnchorRect>,
  b: ReadonlyMap<string, AnchorRect>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (!rb) return false;
    if (
      ra.left !== rb.left ||
      ra.top !== rb.top ||
      ra.width !== rb.width ||
      ra.height !== rb.height
    )
      return false;
  }
  return true;
}

/** Whether two card→column maps agree, so an idle re-measure re-renders nothing. */
function sameColumns(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ca] of a) {
    if (b.get(id) !== ca) return false;
  }
  return true;
}

/** Whether two layouts agree, field by field — `columns` included, since a column resizing
 *  is exactly the case a `ResizeObserver` on the cards alone would miss. */
function sameLayout(a: RouteLayout, b: RouteLayout): boolean {
  if (a.busTop !== b.busTop || a.busBottom !== b.busBottom || a.boardWidth !== b.boardWidth) {
    return false;
  }
  if (a.columns.length !== b.columns.length) return false;
  for (let i = 0; i < a.columns.length; i++) {
    if (a.columns[i].left !== b.columns[i].left || a.columns[i].right !== b.columns[i].right) {
      return false;
    }
  }
  return true;
}

const EMPTY_LAYOUT: RouteLayout = { columns: [], busTop: 0, busBottom: 0, boardWidth: 0 };

/**
 * @param revision anything whose identity changes when the set or order of the cards does
 *   — `MyTasks` passes its `cardsByColumn` memo. Re-sorting a column is invisible to a
 *   `ResizeObserver` (nothing changes size) but moves every card below the change.
 */
export function useCardAnchors(revision?: unknown): CardAnchors {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<ReadonlyMap<string, AnchorRect>>(() => new Map());
  const [bounds, setBounds] = useState<AnchorBounds>({ width: 0, height: 0 });
  const [cardColumns, setCardColumns] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [layout, setLayout] = useState<RouteLayout>(EMPTY_LAYOUT);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  /** One memoised callback per task id — see `anchorRef` above for why it must be stable. */
  const refs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  /** The pending rAF, so a burst of observer callbacks measures once. */
  const frame = useRef<number | null>(null);
  const containerEl = useRef<HTMLDivElement | null>(null);
  containerEl.current = container;

  const measure = useCallback(() => {
    const root = containerEl.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const sx = root.scrollLeft;
    const sy = root.scrollTop;
    const next = new Map<string, AnchorRect>();
    let lowest = 0;
    for (const [id, el] of elements.current) {
      // A card React has already detached still sits in the map until its ref fires.
      if (!el.isConnected) continue;
      const b = el.getBoundingClientRect();
      const left = b.left - base.left + sx;
      const top = b.top - base.top + sy;
      next.set(id, {
        left,
        top,
        right: left + b.width,
        bottom: top + b.height,
        width: b.width,
        height: b.height,
      });
      lowest = Math.max(lowest, top + b.height);
    }
    setRects((prev) => (sameRects(prev, next) ? prev : next));
    setBounds((prev) => {
      // Height comes from the CARDS, never from `scrollHeight`: the overlay is a child of
      // the scroll container, so sizing it from the extent it is itself part of would let
      // it hold the board's scroll height up and never shrink back.
      const width = root.clientWidth;
      const height = Math.max(root.clientHeight, Math.ceil(lowest) + 8);
      return prev.width === width && prev.height === height ? prev : { width, height };
    });

    // The columns' own extent, in the same content space — left to right in document order,
    // which is also the board's left-to-right order (`gridAutoFlow: 'column'` never reorders).
    const columnEls = Array.from(root.querySelectorAll<HTMLElement>('[data-board-column]'));
    const columnIndexOf = new Map<Element, number>(columnEls.map((el, i) => [el, i]));
    const columns: ColumnBand[] = columnEls.map((el) => {
      const b = el.getBoundingClientRect();
      const left = b.left - base.left + sx;
      return { left, right: left + b.width };
    });

    // The bus band: below every column header, above every column's topmost card.
    let busTop = 0;
    for (const el of root.querySelectorAll<HTMLElement>('[data-board-column-header]')) {
      const b = el.getBoundingClientRect();
      busTop = Math.max(busTop, b.bottom - base.top + sy);
    }

    const nextColumns = new Map<string, number>();
    let busBottom = Infinity;
    for (const [id, el] of elements.current) {
      if (!el.isConnected) continue;
      const columnEl = el.closest('[data-board-column]');
      const index = columnEl ? columnIndexOf.get(columnEl) : undefined;
      if (index !== undefined) nextColumns.set(id, index);
      const top = next.get(id)?.top;
      if (top !== undefined) busBottom = Math.min(busBottom, top);
    }
    if (!Number.isFinite(busBottom)) busBottom = busTop;

    setCardColumns((prev) => (sameColumns(prev, nextColumns) ? prev : nextColumns));
    setLayout((prev) => {
      const next: RouteLayout = { columns, busTop, busBottom, boardWidth: root.clientWidth };
      return sameLayout(prev, next) ? prev : next;
    });
  }, []);

  const toContentPoint = useCallback((clientX: number, clientY: number) => {
    const root = containerEl.current;
    if (!root) return null;
    const base = root.getBoundingClientRect();
    return { x: clientX - base.left + root.scrollLeft, y: clientY - base.top + root.scrollTop };
  }, []);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);

  const anchorRef = useCallback(
    (taskId: string) => {
      const cached = refs.current.get(taskId);
      if (cached) return cached;
      const onEnter = (): void => setHoveredTaskId(taskId);
      const onLeave = (): void => setHoveredTaskId((at) => (at === taskId ? null : at));
      const attach = (el: HTMLDivElement | null): void => {
        const prev = elements.current.get(taskId);
        if (prev) {
          observer.current?.unobserve(prev);
          prev.removeEventListener('mouseenter', onEnter);
          prev.removeEventListener('mouseleave', onLeave);
        }
        if (el) {
          elements.current.set(taskId, el);
          observer.current?.observe(el);
          el.addEventListener('mouseenter', onEnter);
          el.addEventListener('mouseleave', onLeave);
        } else {
          elements.current.delete(taskId);
          refs.current.delete(taskId);
          onLeave();
        }
        schedule();
      };
      refs.current.set(taskId, attach);
      return attach;
    },
    [schedule],
  );

  // One observer for the container AND every card. The container alone would not do: a card
  // growing a Steps section changes nothing about the container's own border box, and that
  // is precisely the moment every card below it moves.
  useEffect(() => {
    if (!container) return;
    const ro = new ResizeObserver(schedule);
    observer.current = ro;
    ro.observe(container);
    for (const el of elements.current.values()) ro.observe(el);
    const onScroll = (): void => schedule();
    container.addEventListener('scroll', onScroll, { passive: true });
    schedule();
    return () => {
      container.removeEventListener('scroll', onScroll);
      ro.disconnect();
      observer.current = null;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [container, schedule]);

  // The cards changed, or were re-ordered — see `revision`.
  useEffect(schedule, [schedule, revision]);

  return {
    containerRef: setContainer,
    anchorRef,
    rects,
    bounds,
    cardColumns,
    layout,
    hoveredTaskId,
    toContentPoint,
  };
}
