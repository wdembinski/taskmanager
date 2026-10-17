import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { buildChainDrawing, litLinkIds, rubberBandPath, type AnchorRect } from './chainArrows';
import type { RouteLayout } from './chainRoute';

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
  // 'a' and 'b' sit one column apart — enough for `routeChainLinks` to draw an adjacent
  // link through the gutter between them. The bus band sits above both cards' top (0).
  const cardColumns = new Map([
    ['a', 0],
    ['b', 1],
  ]);
  const layout: RouteLayout = {
    columns: [
      { left: 0, right: 240 },
      { left: 400, right: 640 },
    ],
    busTop: -40,
    busBottom: -10,
    boardWidth: 800,
  };

  it('dashes an arrow whose target is still waiting, and animates it while the source runs', () => {
    const links = [link('l1', 'a', 'b')];
    const waiting = buildChainDrawing({
      links,
      anchors,
      cardColumns,
      tasksById: new Map([
        ['a', task('a')],
        ['b', task('b')],
      ]),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
    });
    expect(waiting.arrows[0]).toMatchObject({ blocked: true, releasing: false });

    const running = buildChainDrawing({
      links,
      anchors,
      cardColumns,
      tasksById: new Map([
        ['a', task('a', { status: 'running' })],
        ['b', task('b')],
      ]),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
    });
    expect(running.arrows[0]).toMatchObject({ blocked: true, releasing: true });
  });

  it('stops dashing once the gate is satisfied', () => {
    const drawing = buildChainDrawing({
      links: [link('l1', 'a', 'b')],
      anchors,
      cardColumns,
      tasksById: new Map([
        ['a', task('a', { landedAt: 1 })],
        ['b', task('b')],
      ]),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
    });
    expect(drawing.arrows[0]).toMatchObject({ blocked: false, releasing: false });
  });

  it('gives an endpoint that is not on the board a counted stub, never a line to nowhere', () => {
    const drawing = buildChainDrawing({
      links: [link('l1', 'a', 'gone'), link('l2', 'a', 'alsoGone'), link('l3', 'missing', 'a')],
      anchors: new Map([['a', rect(300, 0)]]),
      cardColumns: new Map([['a', 0]]),
      tasksById: new Map([['a', task('a')]]),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
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
      cardColumns,
      tasksById: new Map(),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
    });
    expect(drawing).toEqual({ arrows: [], stubs: [] });
  });

  it('keeps the count chip off the board edge rather than letting it hang over', () => {
    // A card hard against the left frame: there is no room for a chip beside its stub.
    const tight = buildChainDrawing({
      links: [link('l1', 'missing', 'a')],
      anchors: new Map([['a', rect(4, 0)]]),
      cardColumns: new Map([['a', 0]]),
      tasksById: new Map([['a', task('a')]]),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
    });
    expect(tight.stubs[0].chip).toBeNull();
    expect(tight.stubs[0].title).toContain('1 card');

    const roomy = buildChainDrawing({
      links: [link('l1', 'missing', 'a')],
      anchors: new Map([['a', rect(300, 0)]]),
      cardColumns: new Map([['a', 0]]),
      tasksById: new Map([['a', task('a')]]),
      litTaskIds: new Set(),
      boardWidth: 800,
      layout,
    });
    expect(roomy.stubs[0].chip).not.toBeNull();
  });
});
