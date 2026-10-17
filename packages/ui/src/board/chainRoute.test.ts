import { describe, expect, it } from 'vitest';
import type { TaskLink } from '@tm/shared/taskChain';
import {
  routeChainLinks,
  segmentsOf,
  type AnchorRect,
  type ColumnBand,
  type Point,
  type RouteCard,
  type RouteLayout,
  type RoutedLink,
} from './chainRoute';

const rect = (left: number, top: number, width: number, height: number): AnchorRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

const link = (id: string, from: string, to: string): TaskLink => ({
  id,
  fromTaskId: from,
  toTaskId: to,
  gate: 'after-merge',
  createdAt: 0,
});

/**
 * Five columns, 30px gutters, a bus band in the header strip above every card's top, 2–3
 * cards per column — enough shape to exercise every routing case the step describes.
 */
const COLUMN_WIDTH = 200;
const GUTTER = 30;
const CARD_INSET = 10;
const CARD_WIDTH = COLUMN_WIDTH - 2 * CARD_INSET;
const ROW_HEIGHT = 80;
const ROW_GAP = 10;

function columnLeft(i: number): number {
  return 20 + i * (COLUMN_WIDTH + GUTTER);
}

const COLUMNS: ColumnBand[] = Array.from({ length: 5 }, (_, i) => ({
  left: columnLeft(i),
  right: columnLeft(i) + COLUMN_WIDTH,
}));

const LAYOUT: RouteLayout = {
  columns: COLUMNS,
  busTop: 40,
  busBottom: 70,
  boardWidth: columnLeft(4) + COLUMN_WIDTH + 20,
};

function cardRect(column: number, row: number): AnchorRect {
  const top = 90 + row * (ROW_HEIGHT + ROW_GAP);
  return rect(COLUMNS[column].left + CARD_INSET, top, CARD_WIDTH, ROW_HEIGHT);
}

function card(taskId: string, column: number, row: number): RouteCard {
  return { taskId, column, rect: cardRect(column, row) };
}

// col0: b0, b1        col1: t0, t1        col2: p0, p1, p2
// col3: r0, r1        col4: d0, d1, d2
const CARDS: RouteCard[] = [
  card('b0', 0, 0),
  card('b1', 0, 1),
  card('t0', 1, 0),
  card('t1', 1, 1),
  card('p0', 2, 0),
  card('p1', 2, 1),
  card('p2', 2, 2),
  card('r0', 3, 0),
  card('r1', 3, 1),
  card('d0', 4, 0),
  card('d1', 4, 1),
  card('d2', 4, 2),
];

const LINKS = {
  adjFwd: link('adj-fwd', 't0', 'p0'), // col1 -> col2
  adjBwd: link('adj-bwd', 'p1', 't1'), // col2 -> col1, same boundary (1) as adjFwd
  sameMid: link('same-mid', 'p0', 'p2'), // col2 -> col2, not the last column
  sameLast: link('same-last', 'd0', 'd2'), // col4 -> col4, the last column
  distFwdA: link('dist-fwd-a', 'b0', 'p0'), // col0 -> col2, boundaries [0, 1]
  distFwdB: link('dist-fwd-b', 'p1', 'd1'), // col2 -> col4, boundaries [2, 3] — clear of A's span
  distOverlapC: link('dist-overlap-c', 'b1', 'r1'), // col0 -> col3, boundaries [0, 2] — overlaps A's span
  distBwd: link('dist-bwd', 'd0', 't0'), // col4 -> col1, backward, boundaries [3, 1]
} satisfies Record<string, TaskLink>;

const ALL_LINKS = Object.values(LINKS);

function routeAll(links: readonly TaskLink[] = ALL_LINKS): Map<string, RoutedLink> {
  return routeChainLinks(CARDS, links, LAYOUT);
}

/** Every segment, from every routed link, for a sweep that should hold across the board. */
function allSegments(routes: Map<string, RoutedLink>): Array<[Point, Point]> {
  return [...routes.values()].flatMap((route) => segmentsOf(route.points));
}

/** Whether an axis-aligned segment crosses a card's INTERIOR — never merely its edge. */
function crossesInterior(a: Point, b: Point, box: AnchorRect): boolean {
  const inset = 0.5;
  const left = box.left + inset;
  const right = box.right - inset;
  const top = box.top + inset;
  const bottom = box.bottom - inset;
  if (a.y === b.y) {
    if (a.y <= top || a.y >= bottom) return false;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return x1 > left && x0 < right;
  }
  if (a.x === b.x) {
    if (a.x <= left || a.x >= right) return false;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return y1 > top && y0 < bottom;
  }
  throw new Error('every segment the router draws is axis-aligned');
}

describe('routeChainLinks', () => {
  it('skips a link whose ends are not both on the board — stubs handle it instead', () => {
    const routes = routeAll([link('ghost', 'b0', 'missing'), LINKS.adjFwd]);
    expect(routes.has('ghost')).toBe(false);
    expect(routes.has('adj-fwd')).toBe(true);
  });

  it('never routes a segment through the interior of any card on the board', () => {
    const routes = routeAll();
    const segments = allSegments(routes);
    for (const box of CARDS.map((c) => c.rect)) {
      for (const [a, b] of segments) {
        expect(crossesInterior(a, b, box)).toBe(false);
      }
    }
  });

  it('every bend is axis-aligned, and the path carries one Q per bend', () => {
    const routes = routeAll();
    for (const route of routes.values()) {
      for (const [a, b] of segmentsOf(route.points)) {
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
      const bends = route.points.length - 2;
      const qCount = (route.d.match(/Q/g) ?? []).length;
      expect(qCount).toBe(bends);
    }
  });

  it('reports the same start and end the card edges actually sit on', () => {
    const routes = routeAll();
    const adjFwd = routes.get('adj-fwd')!;
    expect(adjFwd.start.x).toBe(cardRect(1, 0).right); // t0's right edge
    expect(adjFwd.end.x).toBe(cardRect(2, 0).left); // p0's left edge
  });

  it('routes an adjacent link straight through the gutter between the two columns', () => {
    const route = routeAll().get('adj-fwd')!;
    const gutter = { left: COLUMNS[1].right, right: COLUMNS[2].left };
    for (const p of route.points.slice(1, -1)) {
      expect(p.x).toBeGreaterThan(gutter.left);
      expect(p.x).toBeLessThan(gutter.right);
    }
  });

  it('loops a same-column link into its right gutter, except in the last column', () => {
    const mid = routeAll().get('same-mid')!;
    const rightGutter = { left: COLUMNS[2].right, right: COLUMNS[3].left };
    expect(mid.start.x).toBe(cardRect(2, 0).right);
    expect(mid.end.x).toBe(cardRect(2, 2).right);
    for (const p of mid.points.slice(1, -1)) {
      expect(p.x).toBeGreaterThan(rightGutter.left);
      expect(p.x).toBeLessThan(rightGutter.right);
    }

    const last = routeAll().get('same-last')!;
    const leftGutter = { left: COLUMNS[3].right, right: COLUMNS[4].left };
    expect(last.start.x).toBe(cardRect(4, 0).left);
    expect(last.end.x).toBe(cardRect(4, 2).left);
    for (const p of last.points.slice(1, -1)) {
      expect(p.x).toBeGreaterThan(leftGutter.left);
      expect(p.x).toBeLessThan(leftGutter.right);
    }
  });

  it('sends a distant link up to the bus band and back down, forward and backward', () => {
    const routes = routeAll();
    for (const id of ['dist-fwd-a', 'dist-fwd-b', 'dist-overlap-c', 'dist-bwd']) {
      const route = routes.get(id)!;
      expect(route.points).toHaveLength(6);
      const busPoints = route.points.slice(2, 4);
      for (const p of busPoints) {
        expect(p.y).toBeGreaterThanOrEqual(LAYOUT.busTop);
        expect(p.y).toBeLessThanOrEqual(LAYOUT.busBottom);
      }
      // The bus crossing sits above every card's top — the one fact that guarantees it
      // cannot cross a card no matter how far across the board it reaches.
      const topMostCard = Math.min(...CARDS.map((c) => c.rect.top));
      expect(Math.max(...busPoints.map((p) => p.y))).toBeLessThan(topMostCard);
    }
  });

  it('gives two links through the same gutter distinct lanes, at least 7px apart', () => {
    const routes = routeAll();
    const a = routes.get('adj-fwd')!; // t0 -> p0, boundary 1
    const b = routes.get('adj-bwd')!; // p1 -> t1, boundary 1 too
    const xOfA = a.points[1].x;
    const xOfB = b.points[1].x;
    expect(xOfA).not.toBeCloseTo(xOfB, 1);
    expect(Math.abs(xOfA - xOfB)).toBeGreaterThanOrEqual(7 - 1e-6);
  });

  it('keeps two overlapping bus spans on distinct lanes, and lets disjoint ones share', () => {
    const routes = routeAll();
    const busYOf = (id: string): number => routes.get(id)!.points[2].y;

    // dist-fwd-a crosses boundaries [0,1]; dist-overlap-c crosses [0,2] — they overlap.
    expect(busYOf('dist-fwd-a')).not.toBeCloseTo(busYOf('dist-overlap-c'), 1);

    // dist-fwd-a crosses [0,1]; dist-fwd-b crosses [2,3] — clear of each other, so with
    // nothing else contending for the lane they share it.
    const onlyDisjoint = routeChainLinks(CARDS, [LINKS.distFwdA, LINKS.distFwdB], LAYOUT);
    expect(onlyDisjoint.get('dist-fwd-a')!.points[2].y).toBe(
      onlyDisjoint.get('dist-fwd-b')!.points[2].y,
    );
  });

  it('spreads two links on the same card edge apart rather than letting them merge', () => {
    const routes = routeAll();
    // t0's right side carries both adj-fwd (as its source) and dist-bwd (as its target).
    const fromAdjFwd = routes.get('adj-fwd')!.start.y;
    const fromDistBwd = routes.get('dist-bwd')!.end.y;
    expect(fromAdjFwd).not.toBe(fromDistBwd);
    expect(Math.abs(fromAdjFwd - fromDistBwd)).toBeGreaterThanOrEqual(5.9);
    // Both stay inside t0's own card.
    const t0 = cardRect(1, 0);
    expect(fromAdjFwd).toBeGreaterThan(t0.top);
    expect(fromAdjFwd).toBeLessThan(t0.bottom);
    expect(fromDistBwd).toBeGreaterThan(t0.top);
    expect(fromDistBwd).toBeLessThan(t0.bottom);
  });

  it('anchors the popover halfway along the polyline, not halfway along its chord', () => {
    const route = routeAll().get('dist-fwd-a')!;
    const segments = segmentsOf(route.points);
    const lengths = segments.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
    const total = lengths.reduce((s, l) => s + l, 0);

    let walked = 0;
    let expected: Point = route.points[0];
    for (let i = 0; i < segments.length; i++) {
      if (walked + lengths[i] >= total / 2) {
        const [a, b] = segments[i];
        const t = lengths[i] === 0 ? 0 : (total / 2 - walked) / lengths[i];
        expected = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        break;
      }
      walked += lengths[i];
    }
    expect(route.mid.x).toBeCloseTo(expected.x, 0);
    expect(route.mid.y).toBeCloseTo(expected.y, 0);
  });

  it('routes the same links to the same geometry regardless of array order', () => {
    const forward = routeAll(ALL_LINKS);
    const shuffled = routeAll([...ALL_LINKS].reverse());
    for (const [id, route] of forward) {
      expect(shuffled.get(id)).toEqual(route);
    }
  });
});
