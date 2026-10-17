/**
 * Routing a chain link through the board's GUTTERS rather than over its cards.
 *
 * `chainArrows` draws a link as a bow between two cards and accepts that the bow may pass
 * over whatever sits between them — tolerable while a link only ever joined neighbours, but
 * not once a link can span the whole board. This module instead treats each gutter — the
 * strip between two columns, and the bus band above the cards — as wiring space, and never
 * lets a routed segment cross a card's interior.
 *
 * Kept free of React, Fluent and the DOM, like `chainArrows.ts`: the routing maths is the
 * thing most likely to be wrong here, and it is pure geometry in and pure geometry out.
 * Coordinates are the board's content space, same as `chainArrows` and `useCardAnchors`.
 */
import type { TaskLink } from '@tm/shared/taskChain';
import type { AnchorRect, Point } from './chainArrows';

export type { AnchorRect, Point };

/** One column's content extent, in board order, in content-space x. */
export interface ColumnBand {
  left: number;
  right: number;
}

/**
 * The board's wiring space: where every column sits, and the band above the cards that
 * distant links cross through (the "bus").
 */
export interface RouteLayout {
  columns: ColumnBand[];
  busTop: number;
  busBottom: number;
  boardWidth: number;
}

/** One card the router needs to know about: which column it's in, and where it is. */
export interface RouteCard {
  taskId: string;
  column: number;
  rect: AnchorRect;
}

/**
 * One routed link — the polyline it follows, plus the three points a consumer hangs
 * anything on. Same `start`/`end`/`mid` contract `chainArrows`' `ChainArrow` now extends this
 * with, so `ChainOverlay` and `ChainLinkPopover` do not have to change shape to draw through here.
 */
export interface RoutedLink {
  linkId: string;
  /** The polyline's own bends, in order — what a test walks to check nothing crosses a card. */
  points: Point[];
  d: string;
  start: Point;
  end: Point;
  mid: Point;
}

/** How far apart two links sharing one card edge are spread, centred on the card. */
const PORT_GAP = 6;
/** Kept clear of the card's own corners so a port never lands on the radius. */
const PORT_MARGIN = 4;
/** How far apart two lanes through the same gutter or bus band sit, at most. */
const LANE_GAP = 7;
/** The gutter's own margin, taken off both edges before lanes are allowed to compress into it. */
const GUTTER_MARGIN = 4;
/** The bus band's margin, taken off `busTop` and `busBottom`. */
const BUS_MARGIN = 3;
/** The rounded corner's radius, at most — never more than half of either adjacent segment. */
const CORNER_R = 5;

/** One decimal, same budget `chainArrows.r` keeps the `d` attribute to. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundPoint(p: Point): Point {
  return { x: r(p.x), y: r(p.y) };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function centerY(rect: AnchorRect): number {
  return rect.top + rect.height / 2;
}

type Side = 'left' | 'right';

function sideX(rect: AnchorRect, side: Side): number {
  return side === 'right' ? rect.right : rect.left;
}

/** The gutter's edges — the facing sides of the two columns either side of the boundary. */
function gutterSpan(layout: RouteLayout, boundary: number): ColumnBand {
  return { left: layout.columns[boundary].right, right: layout.columns[boundary + 1].left };
}

function gutterCenter(layout: RouteLayout, boundary: number): number {
  const g = gutterSpan(layout, boundary);
  return (g.left + g.right) / 2;
}

/**
 * How one link crosses the board, worked out from its two columns alone — before anything
 * about lanes or ports, which depend on every OTHER link sharing the same wiring.
 */
interface LinkPlan {
  link: TaskLink;
  source: RouteCard;
  target: RouteCard;
  kind: 'adjacent' | 'same' | 'distant';
  sourceSide: Side;
  targetSide: Side;
  /** The gutter the route leaves the source through. Equal to `targetBoundary` unless distant. */
  sourceBoundary: number;
  /** The gutter the route arrives at the target through. */
  targetBoundary: number;
  /** The link's own vertical reach — the sort key lane and port allocation agree on. */
  ySpan: number;
}

function planLink(
  link: TaskLink,
  source: RouteCard,
  target: RouteCard,
  lastColumn: number,
): LinkPlan {
  const i = source.column;
  const j = target.column;
  const ySpan = Math.abs(centerY(source.rect) - centerY(target.rect));

  if (i === j) {
    // The rightmost column has no gutter to its right — loop out through its left instead,
    // same as the single-column loop `chainArrows.arrowRoute` draws.
    const useLeft = i === lastColumn;
    const side: Side = useLeft ? 'left' : 'right';
    const boundary = useLeft ? i - 1 : i;
    return {
      link,
      source,
      target,
      kind: 'same',
      sourceSide: side,
      targetSide: side,
      sourceBoundary: boundary,
      targetBoundary: boundary,
      ySpan,
    };
  }

  const forward = j > i;
  if (Math.abs(i - j) === 1) {
    const boundary = Math.min(i, j);
    return {
      link,
      source,
      target,
      kind: 'adjacent',
      sourceSide: forward ? 'right' : 'left',
      targetSide: forward ? 'left' : 'right',
      sourceBoundary: boundary,
      targetBoundary: boundary,
      ySpan,
    };
  }

  return {
    link,
    source,
    target,
    kind: 'distant',
    sourceSide: forward ? 'right' : 'left',
    targetSide: forward ? 'left' : 'right',
    // The source's OWN gutter, on the side facing the target...
    sourceBoundary: forward ? i : i - 1,
    // ...and the target's own gutter, on the side facing the source.
    targetBoundary: forward ? j - 1 : j,
    ySpan,
  };
}

/**
 * Lanes through one gutter or the bus band, spread symmetrically about its centre and
 * compressed only once they would not otherwise fit.
 *
 * Shared by the gutters (vertical lanes, spread sideways) and the bus band (horizontal
 * lanes, spread in y) — both are "N things that must not sit on top of each other, centred
 * on a strip of known width, 7px apart unless that is more than the strip can hold".
 */
function laneOffsets(count: number, available: number, gap: number = LANE_GAP): number[] {
  if (count <= 0) return [];
  const spacing = count > 1 ? Math.min(gap, available / (count - 1)) : 0;
  const offsets: number[] = [];
  for (let k = 0; k < count; k++) offsets.push((k - (count - 1) / 2) * spacing);
  return offsets;
}

/** One link's passage through a single gutter boundary, keyed so a distant link's two
 * crossings (one by its source, one by its target) are never confused with each other. */
interface GutterPassage {
  key: string;
  boundary: number;
  ySpan: number;
  linkId: string;
}

/** Every gutter crossing's x, keyed the same way `GutterPassage.key` is. */
function assignGutterLanes(plans: readonly LinkPlan[], layout: RouteLayout): Map<string, number> {
  const passages: GutterPassage[] = [];
  for (const p of plans) {
    if (p.kind === 'distant') {
      passages.push({
        key: `${p.link.id}:src`,
        boundary: p.sourceBoundary,
        ySpan: p.ySpan,
        linkId: p.link.id,
      });
      passages.push({
        key: `${p.link.id}:tgt`,
        boundary: p.targetBoundary,
        ySpan: p.ySpan,
        linkId: p.link.id,
      });
    } else {
      passages.push({
        key: p.link.id,
        boundary: p.sourceBoundary,
        ySpan: p.ySpan,
        linkId: p.link.id,
      });
    }
  }

  const byBoundary = new Map<number, GutterPassage[]>();
  for (const passage of passages) {
    const list = byBoundary.get(passage.boundary) ?? [];
    list.push(passage);
    byBoundary.set(passage.boundary, list);
  }

  const out = new Map<string, number>();
  for (const [boundary, list] of byBoundary) {
    list.sort((a, b) => a.ySpan - b.ySpan || a.key.localeCompare(b.key));
    const g = gutterSpan(layout, boundary);
    const center = (g.left + g.right) / 2;
    const offsets = laneOffsets(list.length, g.right - g.left - GUTTER_MARGIN);
    list.forEach((passage, i) => out.set(passage.key, center + offsets[i]));
  }
  return out;
}

/** One endpoint's claim on its card's edge — paired with the OTHER end's y, which is what
 * orders the ports so two crossing links do not also cross each other right at the card. */
interface PortClaim {
  key: string;
  cardId: string;
  side: Side;
  counterpartY: number;
}

function assignPorts(plans: readonly LinkPlan[]): Map<string, number> {
  const claims: PortClaim[] = [];
  for (const p of plans) {
    const sy = centerY(p.source.rect);
    const ty = centerY(p.target.rect);
    claims.push({
      key: `${p.link.id}:s`,
      cardId: p.source.taskId,
      side: p.sourceSide,
      counterpartY: ty,
    });
    claims.push({
      key: `${p.link.id}:t`,
      cardId: p.target.taskId,
      side: p.targetSide,
      counterpartY: sy,
    });
  }

  const byCardSide = new Map<string, PortClaim[]>();
  const cardRects = new Map<string, AnchorRect>();
  for (const p of plans) {
    cardRects.set(p.source.taskId, p.source.rect);
    cardRects.set(p.target.taskId, p.target.rect);
  }
  for (const claim of claims) {
    const groupKey = `${claim.cardId}:${claim.side}`;
    const list = byCardSide.get(groupKey) ?? [];
    list.push(claim);
    byCardSide.set(groupKey, list);
  }

  const out = new Map<string, number>();
  for (const [groupKey, list] of byCardSide) {
    list.sort((a, b) => a.counterpartY - b.counterpartY || a.key.localeCompare(b.key));
    const cardId = groupKey.slice(0, groupKey.lastIndexOf(':'));
    const rect = cardRects.get(cardId);
    if (!rect) continue; // impossible: every claim came from a plan built off this rect
    const offsets = laneOffsets(list.length, rect.height - 2 * PORT_MARGIN, PORT_GAP);
    const base = centerY(rect);
    list.forEach((claim, i) => {
      out.set(
        claim.key,
        clamp(base + offsets[i], rect.top + PORT_MARGIN, rect.bottom - PORT_MARGIN),
      );
    });
  }
  return out;
}

/** Two x-spans overlap when neither sits entirely to one side of the other. */
function spansOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
}

/**
 * The bus band's y for every distant link — the lowest lane whose x-span so far does not
 * overlap this one's, interval-graph style, so two links that never cross in x can share a
 * row and two that do are kept visibly apart.
 */
function assignBusLanes(plans: readonly LinkPlan[], layout: RouteLayout): Map<string, number> {
  const distant = plans.filter((p): p is LinkPlan & { kind: 'distant' } => p.kind === 'distant');
  if (distant.length === 0) return new Map();

  const ordered = [...distant].sort(
    (a, b) => a.ySpan - b.ySpan || a.link.id.localeCompare(b.link.id),
  );
  const lanes: Array<Array<[number, number]>> = [];
  const laneOf = new Map<string, number>();

  for (const p of ordered) {
    const cx1 = gutterCenter(layout, p.sourceBoundary);
    const cx2 = gutterCenter(layout, p.targetBoundary);
    const span: [number, number] = [Math.min(cx1, cx2), Math.max(cx1, cx2)];

    let lane = lanes.findIndex((spans) => !spans.some((s) => spansOverlap(s, span)));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push(span);
    laneOf.set(p.link.id, lane);
  }

  const available = Math.max(0, layout.busBottom - layout.busTop - 2 * BUS_MARGIN);
  const spacing = lanes.length > 1 ? Math.min(LANE_GAP, available / (lanes.length - 1)) : 0;

  const out = new Map<string, number>();
  for (const [linkId, lane] of laneOf) out.set(linkId, layout.busTop + BUS_MARGIN + lane * spacing);
  return out;
}

/** Move from `from` toward `to` by `dist`, staying on whichever axis the segment runs along. */
function towards(from: Point, to: Point, dist: number): Point {
  if (from.x === to.x) return { x: from.x, y: from.y + Math.sign(to.y - from.y) * dist };
  return { x: from.x + Math.sign(to.x - from.x) * dist, y: from.y };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The polyline's `d`, with a rounded corner at every interior point — `Q` at each bend,
 * radius capped to half of whichever adjacent segment is shorter so a tight dogleg never
 * overshoots into the segment next to it.
 */
function roundedPathD(points: readonly Point[]): string {
  const p0 = points[0];
  let d = `M ${r(p0.x)} ${r(p0.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const radius = Math.min(CORNER_R, dist(prev, here) / 2, dist(here, next) / 2);
    const before = towards(here, prev, radius);
    const after = towards(here, next, radius);
    d += ` L ${r(before.x)} ${r(before.y)} Q ${r(here.x)} ${r(here.y)}, ${r(after.x)} ${r(after.y)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${r(last.x)} ${r(last.y)}`;
  return d;
}

/** The point halfway along the polyline's own length — not its chord — for the popover. */
function pointAtHalfLength(points: readonly Point[]): Point {
  const segments: Array<[Point, Point]> = segmentsOf(points as Point[]);
  const lengths = segments.map(([a, b]) => dist(a, b));
  const total = lengths.reduce((sum, l) => sum + l, 0);
  if (total === 0) return roundPoint(points[0]);

  let remaining = total / 2;
  for (let i = 0; i < segments.length; i++) {
    const len = lengths[i];
    if (len >= remaining || i === segments.length - 1) {
      const [a, b] = segments[i];
      const t = len === 0 ? 0 : remaining / len;
      return roundPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    remaining -= len;
  }
  return roundPoint(points[points.length - 1]);
}

/** Consecutive pairs of a polyline — exported so a test can walk the same segments the
 * router itself reasons about, rather than re-deriving them from the `d` string. */
export function segmentsOf(points: readonly Point[]): Array<[Point, Point]> {
  const segs: Array<[Point, Point]> = [];
  for (let i = 0; i < points.length - 1; i++) segs.push([points[i], points[i + 1]]);
  return segs;
}

function buildPoints(
  plan: LinkPlan,
  gutterX: ReadonlyMap<string, number>,
  portY: ReadonlyMap<string, number>,
  busY: ReadonlyMap<string, number>,
): Point[] {
  const sourceX = sideX(plan.source.rect, plan.sourceSide);
  const targetX = sideX(plan.target.rect, plan.targetSide);
  const sourceY = portY.get(`${plan.link.id}:s`) ?? centerY(plan.source.rect);
  const targetY = portY.get(`${plan.link.id}:t`) ?? centerY(plan.target.rect);
  const start: Point = { x: sourceX, y: sourceY };
  const end: Point = { x: targetX, y: targetY };

  if (plan.kind !== 'distant') {
    const gx = gutterX.get(plan.link.id) ?? sourceX;
    return [start, { x: gx, y: sourceY }, { x: gx, y: targetY }, end];
  }

  const srcGx = gutterX.get(`${plan.link.id}:src`) ?? sourceX;
  const tgtGx = gutterX.get(`${plan.link.id}:tgt`) ?? targetX;
  const bus = busY.get(plan.link.id) ?? (sourceY + targetY) / 2;
  return [
    start,
    { x: srcGx, y: sourceY },
    { x: srcGx, y: bus },
    { x: tgtGx, y: bus },
    { x: tgtGx, y: targetY },
    end,
  ];
}

/**
 * Every link's route through the board's gutters and bus band, in one pass.
 *
 * A link whose ends are not BOTH on the board is skipped entirely — `chainArrows`' stubs
 * handle a hidden end, and a route to nowhere has nothing to land on.
 */
export function routeChainLinks(
  cards: readonly RouteCard[],
  links: readonly TaskLink[],
  layout: RouteLayout,
): Map<string, RoutedLink> {
  const byId = new Map(cards.map((c) => [c.taskId, c] as const));
  const lastColumn = layout.columns.length - 1;

  const plans: LinkPlan[] = [];
  for (const link of links) {
    const source = byId.get(link.fromTaskId);
    const target = byId.get(link.toTaskId);
    if (!source || !target) continue;
    plans.push(planLink(link, source, target, lastColumn));
  }

  const busY = assignBusLanes(plans, layout);
  const gutterX = assignGutterLanes(plans, layout);
  const portY = assignPorts(plans);

  const out = new Map<string, RoutedLink>();
  for (const plan of plans) {
    const points = buildPoints(plan, gutterX, portY, busY);
    out.set(plan.link.id, {
      linkId: plan.link.id,
      points: points.map(roundPoint),
      d: roundedPathD(points),
      start: roundPoint(points[0]),
      end: roundPoint(points[points.length - 1]),
      mid: pointAtHalfLength(points),
    });
  }
  return out;
}
