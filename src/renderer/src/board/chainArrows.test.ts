import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/model';
import type { TaskLink } from '@shared/taskChain';
import {
  arrowPath,
  arrowRoute,
  buildChainDrawing,
  litLinkIds,
  rubberBandPath,
  type AnchorRect,
} from './chainArrows';

const rect = (left: number, top: number, width = 240, height = 80): AnchorRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: 'personal',
  phase: '',
  title: id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const link = (id: string, from: string, to: string, over: Partial<TaskLink> = {}): TaskLink => ({
  id,
  fromTaskId: from,
  toTaskId: to,
  gate: 'after-merge',
  createdAt: 0,
  ...over,
});

/** Pull the four x/y pairs out of a `M x y C x y, x y, x y` path. */
function points(d: string): number[] {
  return d.match(/-?\d+(\.\d+)?/g)!.map(Number);
}

describe('arrowPath', () => {
  it('leaves the right edge for a target to the right, and enters its left', () => {
    const [x1, y1, , , , , x2, y2] = points(arrowPath(rect(0, 0), rect(400, 200)));
    expect([x1, y1]).toEqual([240, 40]);
    expect([x2, y2]).toEqual([400, 240]);
  });

  it('leaves and enters horizontally, so every arrow on the board reads the same way', () => {
    const [, y1, , c1y, , c2y, , y2] = points(arrowPath(rect(0, 0), rect(400, 200)));
    expect(c1y).toBe(y1);
    expect(c2y).toBe(y2);
  });

  it('turns round for a target to the LEFT rather than crossing it to reach its far side', () => {
    // The commonest link on a board: the card doing the work is further right than the one
    // waiting on it. Facing edges — source's left, target's right — keep the curve between
    // them, where the old right-to-left routing dragged it straight over the target card.
    const [x1, , c1x, , c2x, , x2] = points(arrowPath(rect(400, 0), rect(0, 200)));
    expect(x1).toBe(400); // the source's LEFT edge
    expect(x2).toBe(240); // the target's RIGHT edge
    expect(c1x).toBeLessThan(x1); // both control points in the gutter between them
    expect(c2x).toBeGreaterThan(x2);
  });

  it('loops a link inside one column out into the gutter, clear of the cards between', () => {
    const [x1, , c1x, , c2x, , x2] = points(arrowPath(rect(0, 0), rect(0, 400)));
    // Both ends on the right edge, and the whole curve lives to the right of it.
    expect(x1).toBe(240);
    expect(x2).toBe(240);
    expect(c1x).toBeGreaterThan(240);
    expect(c2x).toBeGreaterThan(240);
  });

  it('loops on the LEFT in the rightmost column, where the board edge would clip it', () => {
    const [x1, , c1x, , c2x, , x2] = points(arrowPath(rect(560, 0), rect(560, 400), 810));
    expect(x1).toBe(560); // the left edge, both ends
    expect(x2).toBe(560);
    expect(c1x).toBeLessThan(560);
    expect(c2x).toBeLessThan(560);
  });
});

describe('litLinkIds', () => {
  // a → b → c, with d branching off b, and e feeding a.
  const links = [
    link('l1', 'e', 'a'),
    link('l2', 'a', 'b'),
    link('l3', 'b', 'c'),
    link('l4', 'b', 'd'),
    link('l5', 'x', 'y'),
  ];

  it('lights the whole route upstream and downstream of the card', () => {
    expect([...litLinkIds(links, new Set(['b']))].sort()).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('leaves a sibling branch dark — it is neither before nor after the card', () => {
    // From c: upstream is b, a, e. d hangs off b but is not on the way to c.
    expect([...litLinkIds(links, new Set(['c']))].sort()).toEqual(['l1', 'l2', 'l3']);
  });

  it('lights nothing when nothing is selected or hovered', () => {
    expect(litLinkIds(links, new Set()).size).toBe(0);
  });

  // What focus mode relies on: the board is filtered to one whole component and every card
  // in it is passed as a seed, so the sibling branch that stays dark for ONE card lights up
  // — the noise the hairline was quiet for is no longer on the board.
  it('lights every arrow within a whole component seeded at once', () => {
    const focused = new Set(['a', 'b', 'c', 'd', 'e']);
    expect([...litLinkIds(links, focused)].sort()).toEqual(['l1', 'l2', 'l3', 'l4']);
  });
});

describe('arrowRoute', () => {
  it('reports the ends the selected arrow puts its dots on', () => {
    const { start, end } = arrowRoute(rect(0, 0), rect(400, 200));
    expect(start).toEqual({ x: 240, y: 40 });
    expect(end).toEqual({ x: 400, y: 240 });
  });

  it('anchors the popover on the curve at t = ½', () => {
    // Both control points sit level with their own end, so y is the mean of the two ends.
    const { mid } = arrowRoute(rect(0, 0), rect(400, 200));
    expect(mid).toEqual({ x: 320, y: 140 });
  });

  it('follows the bow rather than the chord when the curve loops out', () => {
    // Two cards in one column: the arrow loops into the gutter to the right, so its middle
    // is well clear of the straight line between them — which is where the panel belongs.
    const { mid } = arrowRoute(rect(0, 0), rect(0, 400));
    expect(mid.x).toBeGreaterThan(240);
  });
});

describe('rubberBandPath', () => {
  it('leaves the handle — the card’s right edge, level with where arrows leave', () => {
    const [x1, y1] = points(rubberBandPath(rect(0, 0), { x: 600, y: 300 }));
    expect([x1, y1]).toEqual([240, 40]);
  });

  it('lands exactly on the pointer', () => {
    const p = points(rubberBandPath(rect(0, 0), { x: 600, y: 300 }));
    expect([p[6], p[7]]).toEqual([600, 300]);
  });

  it('still leaves the handle when the pointer is to the LEFT, and loops back', () => {
    const [x1, , c1x, , c2x, , x2] = points(rubberBandPath(rect(400, 0), { x: 40, y: 300 }));
    expect(x1).toBe(640); // the right edge, where your finger closed on the dot
    expect(c1x).toBeGreaterThan(x1); // out to the right first…
    expect(c2x).toBeGreaterThan(x2); // …then back in to the pointer from its right
  });
});

describe('buildChainDrawing', () => {
  const anchors = new Map([
    ['a', rect(0, 0)],
    ['b', rect(400, 0)],
  ]);

  it('dashes an arrow whose target is still waiting, and animates it while the source runs', () => {
    const links = [link('l1', 'a', 'b')];
    const waiting = buildChainDrawing({
      links,
      anchors,
      tasksById: new Map([
        ['a', task('a')],
        ['b', task('b')],
      ]),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(waiting.arrows[0]).toMatchObject({ blocked: true, releasing: false });

    const running = buildChainDrawing({
      links,
      anchors,
      tasksById: new Map([
        ['a', task('a', { status: 'running' })],
        ['b', task('b')],
      ]),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(running.arrows[0]).toMatchObject({ blocked: true, releasing: true });
  });

  it('stops dashing once the gate is satisfied', () => {
    const drawing = buildChainDrawing({
      links: [link('l1', 'a', 'b')],
      anchors,
      tasksById: new Map([
        ['a', task('a', { landedAt: 1 })],
        ['b', task('b')],
      ]),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(drawing.arrows[0]).toMatchObject({ blocked: false, releasing: false });
  });

  it('gives an endpoint that is not on the board a counted stub, never a line to nowhere', () => {
    const drawing = buildChainDrawing({
      links: [link('l1', 'a', 'gone'), link('l2', 'a', 'alsoGone'), link('l3', 'missing', 'a')],
      anchors: new Map([['a', rect(300, 0)]]),
      tasksById: new Map([['a', task('a')]]),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(drawing.arrows).toHaveLength(0);
    expect(drawing.stubs).toHaveLength(2);
    expect(drawing.stubs.find((s) => s.side === 'out')?.count).toBe(2);
    expect(drawing.stubs.find((s) => s.side === 'in')?.count).toBe(1);
  });

  it('drops a link with neither end on the board', () => {
    const drawing = buildChainDrawing({
      links: [link('l1', 'x', 'y')],
      anchors,
      tasksById: new Map(),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(drawing).toEqual({ arrows: [], stubs: [] });
  });

  it('keeps the count chip off the board edge rather than letting it hang over', () => {
    // A card hard against the left frame: there is no room for a chip beside its stub.
    const tight = buildChainDrawing({
      links: [link('l1', 'missing', 'a')],
      anchors: new Map([['a', rect(4, 0)]]),
      tasksById: new Map([['a', task('a')]]),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(tight.stubs[0].chip).toBeNull();
    expect(tight.stubs[0].title).toContain('1 card');

    const roomy = buildChainDrawing({
      links: [link('l1', 'missing', 'a')],
      anchors: new Map([['a', rect(300, 0)]]),
      tasksById: new Map([['a', task('a')]]),
      litTaskIds: new Set(),
      boardWidth: 800,
    });
    expect(roomy.stubs[0].chip).not.toBeNull();
  });
});
