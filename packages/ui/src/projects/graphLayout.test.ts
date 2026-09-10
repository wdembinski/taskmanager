import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import { layoutNodes } from './GraphPane';

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
});
