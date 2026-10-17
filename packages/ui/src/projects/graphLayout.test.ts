import { describe, expect, it } from 'vitest';
import type { Task, TicketLink } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { archiveIndexOf, visibleTickets } from '@tm/shared/trackerArchive';
import { FLUO_VAR } from '../tokens';
import { archivedStubs, chainEdges, dependencyEdges, layoutNodes } from './GraphPane';

let seq = 0;
/** A minimal native-ticket fixture — only the fields this module reads are worth naming. */
function ticket(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    projectId: 'proj',
    phase: '',
    title: 'Untitled',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

describe('layoutNodes', () => {
  it('renders an epic as an epicZone node, never an ordinary ticket card', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const nodes = layoutNodes([epic], {});
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('epicZone');
  });

  it('nests a child under its epic with parentId and extent:parent', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const child = ticket({ id: 'c1', epicTaskId: 'e1' });
    const nodes = layoutNodes([epic, child], {});
    const childNode = nodes.find((n) => n.id === 'c1');
    expect(childNode?.type).toBe('ticket');
    expect(childNode?.parentId).toBe('e1');
    expect(childNode?.extent).toBe('parent');
  });

  it('emits the epic zone before its own children, the order React Flow needs to resolve parentId', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const child = ticket({ id: 'c1', epicTaskId: 'e1' });
    const nodes = layoutNodes([epic, child], {});
    const zoneIndex = nodes.findIndex((n) => n.id === 'e1');
    const childIndex = nodes.findIndex((n) => n.id === 'c1');
    expect(zoneIndex).toBeLessThan(childIndex);
  });

  it('still renders a childless epic as an (empty) zone rather than vanishing', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const nodes = layoutNodes([epic], {});
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('epicZone');
  });

  it('sizes the zone to enclose every child card, not just the header band', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const c1 = ticket({ id: 'c1', epicTaskId: 'e1' });
    const c2 = ticket({ id: 'c2', epicTaskId: 'e1' });
    const withoutChildren = layoutNodes([epic], {});
    const withChildren = layoutNodes([epic, c1, c2], {});
    const zoneNoChildren = withoutChildren.find((n) => n.id === 'e1')!;
    const zoneWithChildren = withChildren.find((n) => n.id === 'e1')!;
    const heightNoChildren = (zoneNoChildren.data as { height: number }).height;
    const heightWithChildren = (zoneWithChildren.data as { height: number }).height;
    expect(heightWithChildren).toBeGreaterThan(heightNoChildren);
  });

  it("keeps a ticket whose epicTaskId names an epic NOT in this project's tickets as a top-level card", () => {
    const orphan = ticket({ id: 'o1', epicTaskId: 'not-on-this-board' });
    const nodes = layoutNodes([orphan], {});
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('ticket');
    expect(nodes[0].parentId).toBeUndefined();
  });

  it('gives a saved position priority over the grid fallback, for a top-level ticket', () => {
    const solo = ticket({ id: 's1' });
    const nodes = layoutNodes([solo], { s1: { x: 42, y: 99 } });
    expect(nodes[0].position).toEqual({ x: 42, y: 99 });
  });

  it('gives a saved position priority over the grid fallback, for a child of an epic', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic' });
    const child = ticket({ id: 'c1', epicTaskId: 'e1' });
    const nodes = layoutNodes([epic, child], { c1: { x: 7, y: 8 } });
    const childNode = nodes.find((n) => n.id === 'c1')!;
    expect(childNode.position).toEqual({ x: 7, y: 8 });
  });

  it('gives a saved position priority over the fallback stack, for an epic zone itself', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic' });
    const nodes = layoutNodes([epic], { e1: { x: 123, y: 456 } });
    expect(nodes[0].position).toEqual({ x: 123, y: 456 });
  });

  it('lays out two epics without overlapping their fallback stack positions', () => {
    const e1 = ticket({ id: 'e1', issueType: 'epic' });
    const c1 = ticket({ id: 'c1', epicTaskId: 'e1' });
    const e2 = ticket({ id: 'e2', issueType: 'epic' });
    const nodes = layoutNodes([e1, c1, e2], {});
    const zone1 = nodes.find((n) => n.id === 'e1')!;
    const zone2 = nodes.find((n) => n.id === 'e2')!;
    expect(zone1.position.y).not.toBe(zone2.position.y);
  });

  it('round-trips through a saved layout unchanged — same shape a real drag-then-reload sees', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic' });
    const child = ticket({ id: 'c1', epicTaskId: 'e1' });
    const saved = { e1: { x: 10, y: 20 }, c1: { x: 30, y: 40 } };
    const first = layoutNodes([epic, child], saved);
    const second = layoutNodes([epic, child], saved);
    expect(second.find((n) => n.id === 'e1')!.position).toEqual(
      first.find((n) => n.id === 'e1')!.position,
    );
    expect(second.find((n) => n.id === 'c1')!.position).toEqual(
      first.find((n) => n.id === 'c1')!.position,
    );
  });

  it('renders a stub as a top-level archivedStub node, never parented, that is not connectable or deletable', () => {
    const visibleTicket = ticket({ id: 'v1' });
    const stub = ticket({ id: 's1', epicTaskId: 'not-on-this-board' });
    const nodes = layoutNodes([visibleTicket], {}, [stub]);
    const stubNode = nodes.find((n) => n.id === 's1')!;
    expect(stubNode.type).toBe('archivedStub');
    expect(stubNode.parentId).toBeUndefined();
    expect(stubNode.connectable).toBe(false);
    expect(stubNode.deletable).toBe(false);
  });

  it("gives a stub its saved position, falling back to the next 'others' grid slot otherwise", () => {
    const visibleTicket = ticket({ id: 'v1' });
    const savedStub = ticket({ id: 's1' });
    const unsavedStub = ticket({ id: 's2' });
    const nodes = layoutNodes([visibleTicket], { s1: { x: 7, y: 8 } }, [savedStub, unsavedStub]);
    expect(nodes.find((n) => n.id === 's1')!.position).toEqual({ x: 7, y: 8 });
    // The un-saved stub continues the SAME grid-fallback sequence as the ordinary top-level
    // ticket, rather than restarting its own — so it never lands on the same slot.
    const visiblePos = nodes.find((n) => n.id === 'v1')!.position;
    const stubPos = nodes.find((n) => n.id === 's2')!.position;
    expect(stubPos).not.toEqual(visiblePos);
  });
});

describe('archivedStubs', () => {
  function link(overrides: Partial<TicketLink> = {}): TicketLink {
    return {
      id: `link-${Math.random()}`,
      fromTaskId: 'a',
      toTaskId: 'b',
      type: 'blocks',
      createdAt: 0,
      ...overrides,
    };
  }

  function chainLink(overrides: Partial<TaskLink> = {}): TaskLink {
    return {
      id: `chain-${Math.random()}`,
      fromTaskId: 'a',
      toTaskId: 'b',
      gate: 'after-merge',
      createdAt: 0,
      ...overrides,
    };
  }

  it('yields no node for a hidden ticket with no visible link partner', () => {
    const hiddenTicket = ticket({ id: 'h1' });
    const stubs = archivedStubs([hiddenTicket], [], [], new Set(['v1']));
    expect(stubs).toHaveLength(0);
  });

  it('yields exactly one stub for a hidden ticket blocks-linked to a visible one', () => {
    const hiddenTicket = ticket({ id: 'h1' });
    const links = [link({ fromTaskId: 'h1', toTaskId: 'v1' })];
    const stubs = archivedStubs([hiddenTicket], links, [], new Set(['v1']));
    expect(stubs).toEqual([hiddenTicket]);
  });

  it('yields exactly one stub for a hidden ticket chain-linked to a visible one', () => {
    const hiddenTicket = ticket({ id: 'h1' });
    const chainLinks = [chainLink({ fromTaskId: 'v1', toTaskId: 'h1' })];
    const stubs = archivedStubs([hiddenTicket], [], chainLinks, new Set(['v1']));
    expect(stubs).toEqual([hiddenTicket]);
  });

  it('does not duplicate a hidden ticket linked to more than one visible ticket', () => {
    const hiddenTicket = ticket({ id: 'h1' });
    const links = [
      link({ fromTaskId: 'h1', toTaskId: 'v1' }),
      link({ fromTaskId: 'h1', toTaskId: 'v2' }),
    ];
    const stubs = archivedStubs([hiddenTicket], links, [], new Set(['v1', 'v2']));
    expect(stubs).toEqual([hiddenTicket]);
  });

  it('drops a hidden ticket only linked to other hidden tickets', () => {
    const h1 = ticket({ id: 'h1' });
    const h2 = ticket({ id: 'h2' });
    const links = [link({ fromTaskId: 'h1', toTaskId: 'h2' })];
    const stubs = archivedStubs([h1, h2], links, [], new Set(['v1']));
    expect(stubs).toHaveLength(0);
  });

  it('ignores a non-blocks ticket link (relates, duplicates, …)', () => {
    const hiddenTicket = ticket({ id: 'h1' });
    const links = [link({ fromTaskId: 'h1', toTaskId: 'v1', type: 'relates' })];
    const stubs = archivedStubs([hiddenTicket], links, [], new Set(['v1']));
    expect(stubs).toHaveLength(0);
  });

  it('returns stubs in the input order of hidden', () => {
    const h1 = ticket({ id: 'h1' });
    const h2 = ticket({ id: 'h2' });
    const links = [
      link({ fromTaskId: 'h2', toTaskId: 'v1' }),
      link({ fromTaskId: 'h1', toTaskId: 'v1' }),
    ];
    const stubs = archivedStubs([h1, h2], links, [], new Set(['v1']));
    expect(stubs).toEqual([h1, h2]);
  });
});

/**
 * The whole F14.6 pipeline `GraphPane` itself runs — `visibleTickets` → `archivedStubs` →
 * `layoutNodes`/`dependencyEdges`/`chainEdges` — exercised end to end the way the pane's own
 * `useMemo` chain composes them, rather than any one stage in isolation.
 */
describe('Graph archive integration (F14.6)', () => {
  function link(overrides: Partial<TicketLink> = {}): TicketLink {
    return {
      id: `link-${Math.random()}`,
      fromTaskId: 'a',
      toTaskId: 'b',
      type: 'blocks',
      createdAt: 0,
      ...overrides,
    };
  }

  it('draws no node for an archived ticket with no visible link partner', () => {
    const live = ticket({ id: 'v1' });
    const archived = ticket({ id: 'h1', trackerArchivedAt: 1 });
    const all = [live, archived];
    const index = archiveIndexOf([], all, []);
    const visible = visibleTickets(all, index);
    const hidden = all.filter((t) => !visible.includes(t));
    const stubs = archivedStubs(hidden, [], [], new Set(visible.map((t) => t.id)));
    const nodes = layoutNodes(visible, {}, stubs);

    expect(nodes.find((n) => n.id === 'h1')).toBeUndefined();
  });

  it('draws exactly one archivedStub node, linked by a muted edge, for an archived ticket blocking a visible one', () => {
    const live = ticket({ id: 'v1' });
    const archived = ticket({ id: 'h1', trackerArchivedAt: 1 });
    const all = [live, archived];
    const links = [link({ fromTaskId: 'h1', toTaskId: 'v1' })];
    const index = archiveIndexOf([], all, []);
    const visible = visibleTickets(all, index);
    const hidden = all.filter((t) => !visible.includes(t));
    const visibleIds = new Set(visible.map((t) => t.id));
    const stubs = archivedStubs(hidden, links, [], visibleIds);
    const nodes = layoutNodes(visible, {}, stubs);
    const stubNodes = nodes.filter((n) => n.type === 'archivedStub');
    expect(stubNodes).toHaveLength(1);
    expect(stubNodes[0].id).toBe('h1');

    const nodeIds = new Set(nodes.map((n) => n.id));
    const stubIds = new Set(stubs.map((t) => t.id));
    const edges = dependencyEdges(links, nodeIds, stubIds);
    expect(edges).toHaveLength(1);
    expect(edges[0].style).toMatchObject({ strokeDasharray: expect.any(String) });
  });

  it("draws a chain edge touching a stub muted, never cyan, whatever the link's own kind", () => {
    const live = ticket({ id: 'v1' });
    const archived = ticket({ id: 'h1', trackerArchivedAt: 1 });
    const all = [live, archived];
    const chainLinks: TaskLink[] = [
      { id: 'c1', fromTaskId: 'v1', toTaskId: 'h1', gate: 'after-merge', createdAt: 0 },
    ];
    const index = archiveIndexOf([], all, []);
    const visible = visibleTickets(all, index);
    const hidden = all.filter((t) => !visible.includes(t));
    const visibleIds = new Set(visible.map((t) => t.id));
    const stubs = archivedStubs(hidden, [], chainLinks, visibleIds);
    const nodes = layoutNodes(visible, {}, stubs);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const stubIds = new Set(stubs.map((t) => t.id));
    const edges = chainEdges(chainLinks, nodeIds, stubIds);
    expect(edges).toHaveLength(1);
    expect(edges[0].style).toMatchObject({ strokeDasharray: expect.any(String) });
    expect((edges[0].style as { stroke: string }).stroke).not.toBe(FLUO_VAR.cyan);
  });

  it("drops an archived epic's zone and every one of its children", () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', trackerArchivedAt: 1 });
    const child = ticket({ id: 'c1', epicTaskId: 'e1' });
    const other = ticket({ id: 'v1' });
    const all = [epic, child, other];
    const index = archiveIndexOf([], all, []);
    const visible = visibleTickets(all, index);
    const hidden = all.filter((t) => !visible.includes(t));
    const stubs = archivedStubs(hidden, [], [], new Set(visible.map((t) => t.id)));
    const nodes = layoutNodes(visible, {}, stubs);

    expect(nodes.find((n) => n.id === 'e1')).toBeUndefined();
    expect(nodes.find((n) => n.id === 'c1')).toBeUndefined();
    expect(nodes.find((n) => n.id === 'v1')).toBeDefined();
  });

  it('draws every ticket as an ordinary node with no stubs once includeArchived is set', () => {
    const live = ticket({ id: 'v1' });
    const archived = ticket({ id: 'h1', trackerArchivedAt: 1 });
    const all = [live, archived];
    const links = [link({ fromTaskId: 'h1', toTaskId: 'v1' })];
    const index = archiveIndexOf([], all, []);
    const visible = visibleTickets(all, index, { includeArchived: true });
    const hidden = all.filter((t) => !visible.includes(t));
    const stubs = archivedStubs(hidden, links, [], new Set(visible.map((t) => t.id)));
    const nodes = layoutNodes(visible, {}, stubs);

    expect(stubs).toHaveLength(0);
    expect(nodes.filter((n) => n.type === 'archivedStub')).toHaveLength(0);
    expect(nodes.map((n) => n.id).sort()).toEqual(['h1', 'v1']);
    expect(nodes.every((n) => n.type === 'ticket')).toBe(true);
  });
});
