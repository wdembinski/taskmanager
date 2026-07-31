/**
 * Turning the chain's EDGES into the shapes that get drawn over the board.
 *
 * Split out of `ChainOverlay` and kept free of React, Fluent and the DOM so the two
 * things most likely to be wrong here — the routing maths and the "which arrow is lit"
 * reachability — can be tested without a browser. The component's only job is to map the
 * states this module returns onto strokes; it decides no geometry and no meaning.
 *
 * Coordinates are the board's **content space**: the scroll container's padding box plus
 * its scroll offset (see `useCardAnchors`). That is the space an absolutely-positioned
 * child of the scroll container lives in, which is why the overlay can be laid out once
 * and then simply scroll with the cards.
 */
import { isRunStatus } from '@shared/board';
import type { Task } from '@shared/model';
import { LINK_GATE_LABEL, linkSatisfied, type LinkGate, type TaskLink } from '@shared/taskChain';

/**
 * Where one card is, in board content space.
 *
 * A plain record rather than the `DOMRect` it is measured from: these are derived values
 * (the rect minus the container's own origin, plus the scroll offset), they have to be
 * compared field by field to decide whether anything actually moved, and a test wants to
 * write one down in four numbers.
 */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** One drawn arrow: where it goes, and everything the stroke has to say about it. */
export interface ChainArrow {
  /** The link's id — what Phase 3's click handler will address. */
  linkId: string;
  fromTaskId: string;
  toTaskId: string;
  gate: LinkGate;
  /** The `d` of the cubic Bézier — see {@link arrowPath}. */
  d: string;
  /** On the route through a selected or hovered card — drawn heavier, in the accent. */
  lit: boolean;
  /** The target is still waiting on this predecessor — drawn dashed. */
  blocked: boolean;
  /** ...and the predecessor is running right now, so the dash travels toward the target. */
  releasing: boolean;
  /** The whole sentence, for the path's `<title>`. */
  title: string;
}

/**
 * An endpoint that is **not on the board** — the DONE column is hidden, the sprint switch
 * filtered it out, or a retained card was dropped.
 *
 * Drawn as a stub into the card's edge with a count beside it rather than as a line to
 * nowhere: a line whose far end is off-screen reads as an arrow to whatever card happens
 * to be over there, which is worse than saying nothing. One stub per card per direction,
 * however many links are hidden behind it.
 */
export interface ChainStub {
  key: string;
  /** The end that IS on the board. */
  taskId: string;
  /** `in` — hidden predecessors, arriving; `out` — hidden successors, leaving. */
  side: 'in' | 'out';
  d: string;
  count: number;
  /** Chip centre, or null when the card sits too close to the board's edge to fit one. */
  chip: { cx: number; cy: number } | null;
  lit: boolean;
  title: string;
}

export interface ChainDrawing {
  arrows: ChainArrow[];
  stubs: ChainStub[];
}

/**
 * How far the control points are pushed sideways, at least. Below about this the curve
 * leaves the card at a visible angle instead of straight out of its edge, and a fan of
 * arrows off one card stops reading as a fan.
 */
const MIN_BOW = 20;
/** ...and at most, so a link right across a wide board does not balloon into a semicircle. */
const MAX_BOW = 240;
/**
 * The same, for the loop a link inside one column makes out into the gutter beside it.
 *
 * Deliberately narrow — a gutter is about 20px wide, and a loop that bowed proportionally
 * to its drop simply swapped which cards it crossed, sailing out over the NEXT column
 * instead of down through its own. Kept to the gutter, the loop reads as a bracket beside
 * the column, which is also exactly what a link to the next column over looks like.
 */
const LOOP_BOW = { min: 14, max: 24 } as const;

/** The stub's length, and the count chip's box. */
const STUB_LENGTH = 26;
const CHIP_W = 20;
const CHIP_H = 14;
/** How close to the board's edge any of it may come. */
const EDGE = 3;

/** One decimal is well under a pixel and keeps the `d` attributes short. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A cubic with both control points level with their own end — horizontal at both ends. */
function curve(x1: number, y1: number, c1: number, c2: number, x2: number, y2: number): string {
  return `M ${r(x1)} ${r(y1)} C ${r(c1)} ${r(y1)}, ${r(c2)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The route from one card to another — a cubic Bézier that leaves and enters horizontally,
 * at the middle of whichever edges FACE each other.
 *
 * Horizontal at both ends because that is what makes a chain readable as a chain: an arrow
 * always grows straight out of one card and lands square on another, so a route can be
 * followed at a glance instead of picked out of a thicket of diagonals.
 *
 * The edges are chosen by where the target actually sits, which is the whole trick and the
 * one thing worth reading twice. A board's chains mostly run BACKWARDS — the card doing the
 * work is in In Progress and the card waiting on it is still in To Do, to its left — so
 * always leaving a right edge for a left edge would drag the commonest arrow on the board
 * straight across the target card to reach its far side. Facing edges keep every curve in
 * the gutter BETWEEN the two cards, where it crosses nothing:
 *
 *   - target to the right — leave the right edge, enter the left;
 *   - target to the left — leave the left edge, enter the right;
 *   - **columns overlapping** (a link inside one column, where neither is clear of the
 *     other) — leave the right edge and enter the target's right edge too, so the whole
 *     curve loops out into the gutter beside the column rather than cutting down through
 *     the cards stacked between them. `orient="auto"` turns the arrowhead to match.
 *
 * That last loop goes out on the LEFT instead when there is no room on the right, which is
 * the rightmost column — where the board's own edge clips it. Both gutters cannot be
 * missing at once: a column with neither is a board one column wide.
 *
 * The bow scales with the gap so a link between distant columns eases across instead of
 * jinking, and is floored so even two cards a hair apart get a visible curve rather than a
 * kink.
 *
 * @param boardWidth the overlay's width, for the loop's choice of side. Left off, the loop
 *   always takes the right — which is what a test measuring the shape wants.
 */
export function arrowPath(from: AnchorRect, to: AnchorRect, boardWidth = Infinity): string {
  const y1 = from.top + from.height / 2;
  const y2 = to.top + to.height / 2;

  if (to.left >= from.right) {
    const b = clamp((to.left - from.right) * 0.5, MIN_BOW, MAX_BOW);
    return curve(from.right, y1, from.right + b, to.left - b, to.left, y2);
  }
  if (to.right <= from.left) {
    const b = clamp((from.left - to.right) * 0.5, MIN_BOW, MAX_BOW);
    return curve(from.left, y1, from.left - b, to.right + b, to.right, y2);
  }
  const b = clamp(Math.abs(y2 - y1) * 0.3, LOOP_BOW.min, LOOP_BOW.max);
  if (Math.max(from.right, to.right) + b <= boardWidth - EDGE) {
    return curve(from.right, y1, from.right + b, to.right + b, to.right, y2);
  }
  return curve(from.left, y1, from.left - b, to.left - b, to.left, y2);
}

/** Walk the links from every seed, forwards or backwards, and return everything reached. */
function reachable(
  links: readonly TaskLink[],
  seeds: ReadonlySet<string>,
  direction: 'up' | 'down',
): Set<string> {
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const at = queue.pop() as string;
    for (const l of links) {
      const next =
        direction === 'up'
          ? l.toTaskId === at
            ? l.fromTaskId
            : null
          : l.fromTaskId === at
            ? l.toTaskId
            : null;
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * The links to light up for a set of cards — the whole ROUTE through each of them, both
 * upstream and downstream, not merely the arrows touching them.
 *
 * You point at a card to ask "what does this depend on, and what is waiting on it"; the two
 * arrows attached to it answer neither question past one hop. Lighting the route answers
 * both at a glance, and it stops short of the whole connected component on purpose: a
 * sibling that branches off a shared ancestor is neither before nor after this card, and
 * lighting it too would make every chain look like one undifferentiated tangle.
 *
 * An edge `u → v` is upstream when `v` is the card or one of its ancestors (then `u` is an
 * ancestor by construction), and downstream when `u` is the card or one of its descendants.
 */
export function litLinkIds(
  links: readonly TaskLink[],
  litTaskIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (litTaskIds.size === 0) return out;
  const up = reachable(links, litTaskIds, 'up');
  const down = reachable(links, litTaskIds, 'down');
  for (const l of links) {
    if (up.has(l.toTaskId) || down.has(l.fromTaskId)) out.add(l.id);
  }
  return out;
}

/** A card's title for a tooltip, or a stand-in when it is not on this board. */
function nameOf(task: Task | undefined): string {
  return task?.title ?? 'a card that is not on this board';
}

/** The stub's line and its chip, clamped so neither leaves the board sideways. */
function stubShape(
  rect: AnchorRect,
  side: 'in' | 'out',
  boardWidth: number,
): Pick<ChainStub, 'd' | 'chip'> {
  const y = r(rect.top + rect.height / 2);
  if (side === 'in') {
    const tip = rect.left;
    const tail = Math.max(EDGE, tip - STUB_LENGTH);
    const cx = tail - CHIP_W / 2 - 2;
    return {
      d: `M ${r(tail)} ${y} L ${r(tip)} ${y}`,
      // Dropped rather than squeezed against the frame when the card sits in the
      // leftmost column with nothing to its left — the count is still in the `<title>`,
      // and a chip half off the board would be worse than no chip.
      chip: cx - CHIP_W / 2 >= EDGE ? { cx: r(cx), cy: Number(y) } : null,
    };
  }
  const tail = rect.right;
  const tip = Math.min(boardWidth - EDGE, tail + STUB_LENGTH);
  const cx = tip + CHIP_W / 2 + 2;
  return {
    d: `M ${r(tail)} ${y} L ${r(tip)} ${y}`,
    chip: cx + CHIP_W / 2 <= boardWidth - EDGE ? { cx: r(cx), cy: Number(y) } : null,
  };
}

/** The chip's box, so the component and the geometry agree on one size. */
export const CHIP_SIZE = { width: CHIP_W, height: CHIP_H } as const;

export interface ChainDrawingInput {
  links: readonly TaskLink[];
  /** Where each card currently is. A card absent from this map is not on the board. */
  anchors: ReadonlyMap<string, AnchorRect>;
  /** Every task, including ones the board is not showing — the gates read their state. */
  tasksById: ReadonlyMap<string, Task>;
  /** The ids the engine has a live run for, so an arrow can say "releasing" a beat early. */
  runningTaskIds?: ReadonlySet<string>;
  /** Selected and/or hovered — the cards whose route is lit. */
  litTaskIds: ReadonlySet<string>;
  /** The overlay's width, for clamping the stubs. */
  boardWidth: number;
}

/**
 * Every shape the overlay draws, in one pass.
 *
 * Links whose BOTH ends are off the board are dropped entirely: two hidden cards are not
 * this board's business, and a stub for them would have nothing to attach to.
 */
export function buildChainDrawing(input: ChainDrawingInput): ChainDrawing {
  const { links, anchors, tasksById, litTaskIds, boardWidth } = input;
  const running = input.runningTaskIds ?? new Set<string>();
  const lit = litLinkIds(links, litTaskIds);

  const arrows: ChainArrow[] = [];
  /** (taskId, side) → the hidden links behind one stub. */
  const dangling = new Map<string, { taskId: string; side: 'in' | 'out'; count: number }>();

  for (const link of links) {
    const from = anchors.get(link.fromTaskId);
    const to = anchors.get(link.toTaskId);
    const fromTask = tasksById.get(link.fromTaskId);
    const toTask = tasksById.get(link.toTaskId);

    if (!from || !to) {
      const taskId = from ? link.fromTaskId : to ? link.toTaskId : null;
      if (taskId === null) continue; // neither end is here — nothing to hang a stub off
      const side = from ? 'out' : 'in';
      const key = `${taskId}:${side}`;
      const at = dangling.get(key);
      if (at) at.count += 1;
      else dangling.set(key, { taskId, side, count: 1 });
      continue;
    }

    // Waiting is asked of the SHARED gate logic, never re-derived here: the board and the
    // engine that releases the card must agree about what "after" means for this pair.
    const blocked = !linkSatisfied(link, fromTask);
    const sourceRunning = Boolean(
      fromTask && (isRunStatus(fromTask.status) || running.has(fromTask.id)),
    );
    const releasing = blocked && sourceRunning;
    const gateWords = LINK_GATE_LABEL[link.gate];
    arrows.push({
      linkId: link.id,
      fromTaskId: link.fromTaskId,
      toTaskId: link.toTaskId,
      gate: link.gate,
      d: arrowPath(from, to, boardWidth),
      lit: lit.has(link.id),
      blocked,
      releasing,
      title:
        `${nameOf(toTask)} runs ${gateWords} of ${nameOf(fromTask)}` +
        (releasing ? ' — running now' : blocked ? ' — still waiting' : ' — released'),
    });
  }

  const stubs: ChainStub[] = [];
  for (const [key, d] of dangling) {
    const rect = anchors.get(d.taskId);
    if (!rect) continue; // impossible: it is what put the stub in the map
    const noun = d.count === 1 ? 'card' : 'cards';
    stubs.push({
      key,
      taskId: d.taskId,
      side: d.side,
      count: d.count,
      lit: litTaskIds.has(d.taskId),
      ...stubShape(rect, d.side, boardWidth),
      title:
        d.side === 'in'
          ? `Waits on ${d.count} ${noun} the board is not showing — try Show Done, or the sprint filter`
          : `${d.count} ${noun} wait on this one and are not shown — try Show Done, or the sprint filter`,
    });
  }

  return { arrows, stubs };
}
