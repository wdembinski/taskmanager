import { describe, expect, it } from 'vitest';
import type { Milestone, Task } from '@tm/shared/model';
import { NO_EPIC_GROUP } from '../projects/backlogView';
import {
  NO_MILESTONE_GROUP,
  buildSidebar,
  type SidebarInput,
  type SidebarTreeNode,
} from './sidebarModel';

let ticketSeq = 0;
/** A minimal native-ticket fixture — only the fields this module reads are worth naming. */
function ticket(overrides: Partial<Task> = {}): Task {
  ticketSeq += 1;
  return {
    id: `t${ticketSeq}`,
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

let milestoneSeq = 0;
/** A minimal milestone fixture — only the fields this module reads are worth naming. */
function milestone(overrides: Partial<Milestone> = {}): Milestone {
  milestoneSeq += 1;
  return {
    id: `m${milestoneSeq}`,
    projectId: 'proj',
    name: `Milestone ${milestoneSeq}`,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: milestoneSeq,
    ...overrides,
  };
}

function baseInput(overrides: Partial<SidebarInput> = {}): SidebarInput {
  return {
    workspaces: [{ id: 'w1', name: 'Personal', sub: 'Local' }],
    projects: [],
    milestones: [],
    tickets: [],
    attentionCount: 0,
    archivedCount: 0,
    folds: [],
    ...overrides,
  };
}

function teamTree(sections: ReturnType<typeof buildSidebar>): SidebarTreeNode[] {
  const team = sections.find((s) => s.kind === 'team');
  if (!team || team.kind !== 'team') throw new Error('no team section');
  return team.tree;
}

describe('buildSidebar sections', () => {
  it('always returns the sections in the same order, Reviews absent by default', () => {
    const sections = buildSidebar(baseInput());
    expect(sections.map((s) => s.kind)).toEqual([
      'workspace',
      'views',
      'team',
      'archived',
      'machine',
      'newIssue',
    ]);
    const views = sections.find((s) => s.kind === 'views');
    expect(views?.kind === 'views' && views.views.map((v) => v.id)).toEqual(['inbox', 'myIssues']);
  });

  it('includes Reviews only when reviewsEnabled is true', () => {
    const sections = buildSidebar(baseInput({ reviewsEnabled: true }));
    const views = sections.find((s) => s.kind === 'views');
    expect(views?.kind === 'views' && views.views.map((v) => v.id)).toEqual([
      'inbox',
      'myIssues',
      'reviews',
    ]);
  });

  it('keeps archived → machine → newIssue as the last three sections', () => {
    const projects = [{ id: 'p1', name: 'Personal' }];
    for (const input of [
      baseInput(),
      baseInput({ reviewsEnabled: true }),
      baseInput({ projects }),
      baseInput({ projects, reviewsEnabled: true }),
    ]) {
      const sections = buildSidebar(input);
      const kinds = sections.map((s) => s.kind);
      expect(kinds.slice(-3)).toEqual(['archived', 'machine', 'newIssue']);
      expect(kinds.indexOf('machine')).toBe(kinds.indexOf('archived') + 1);
      expect(kinds[kinds.length - 1]).toBe('newIssue');

      const machine = sections.find((s) => s.kind === 'machine');
      expect(machine).toMatchObject({
        kind: 'machine',
        label: 'This machine',
        location: 'local',
        projects: input.projects,
      });
    }
  });

  it('carries attentionCount onto the Inbox view and archivedCount onto Archived', () => {
    const sections = buildSidebar(baseInput({ attentionCount: 5, archivedCount: 3 }));
    const views = sections.find((s) => s.kind === 'views');
    const inbox = views?.kind === 'views' && views.views.find((v) => v.id === 'inbox');
    expect(inbox && inbox.count).toBe(5);
    const archived = sections.find((s) => s.kind === 'archived');
    expect(archived?.kind === 'archived' && archived.count).toBe(3);
  });
});

describe('buildSidebar milestone ordering', () => {
  it('orders open milestones by due date ascending, undated after dated', () => {
    const dated = milestone({ id: 'm-dated', name: 'Dated', dueAt: 1000 });
    const undated = milestone({ id: 'm-undated', name: 'Undated', dueAt: null });
    const earlier = milestone({ id: 'm-earlier', name: 'Earlier', dueAt: 500 });
    const sections = buildSidebar(baseInput({ milestones: [dated, undated, earlier] }));
    const tree = teamTree(sections);
    expect(tree.map((n) => n.label)).toEqual(['Earlier', 'Dated', 'Undated']);
  });

  it('places closed milestones last, after the No milestone bucket', () => {
    const open = milestone({ id: 'm-open', name: 'Open', closed: false });
    const closed = milestone({ id: 'm-closed', name: 'Closed', closed: true });
    const orphan = ticket({ milestoneId: 'missing-milestone' });
    const sections = buildSidebar(baseInput({ milestones: [closed, open], tickets: [orphan] }));
    const tree = teamTree(sections);
    expect(tree.map((n) => n.label)).toEqual(['Open', NO_MILESTONE_GROUP, 'Closed']);
  });
});

describe('buildSidebar No milestone / No epic buckets', () => {
  it('names the buckets with the exported constants and omits them when empty', () => {
    const m = milestone({ id: 'm1', name: 'M1' });
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one', milestoneId: 'm1' });
    const child = ticket({ epicTaskId: 'e1', milestoneId: 'm1' });
    const sections = buildSidebar(baseInput({ milestones: [m], tickets: [epic, child] }));
    const tree = teamTree(sections);
    expect(tree.map((n) => n.label)).toEqual(['M1']);
    // No ticket anywhere names "No milestone" or "No epic" — both buckets are empty.
    expect(tree[0].children.map((n) => n.label)).toEqual(['Epic one']);
  });

  it('puts a ticket with an unknown milestoneId into No milestone', () => {
    const orphan = ticket({ milestoneId: 'unknown-milestone' });
    const sections = buildSidebar(baseInput({ tickets: [orphan] }));
    const tree = teamTree(sections);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe(NO_MILESTONE_GROUP);
    expect(tree[0].count).toBe(1);
  });

  it('treats a missing/unknown/non-epic epicTaskId as an orphan, listed directly when the milestone heads no real epic group', () => {
    const m = milestone({ id: 'm1', name: 'M1' });
    const missingEpic = ticket({ milestoneId: 'm1', epicTaskId: 'does-not-exist' });
    const noEpic = ticket({ milestoneId: 'm1', epicTaskId: null });
    const notAnEpic = ticket({ id: 'not-epic', milestoneId: 'm1' });
    const pointsAtNonEpic = ticket({ milestoneId: 'm1', epicTaskId: 'not-epic' });
    const sections = buildSidebar(
      baseInput({ milestones: [m], tickets: [missingEpic, noEpic, notAnEpic, pointsAtNonEpic] }),
    );
    const tree = teamTree(sections);
    // This milestone heads no real epic group at all, so there is nothing for a "No epic"
    // level to distinguish itself from — every one of these orphans is a direct child.
    expect(tree[0].children.every((n) => n.kind === 'ticket')).toBe(true);
    expect(tree[0].children.map((n) => n.taskId)).toEqual(
      expect.arrayContaining([missingEpic.id, noEpic.id, notAnEpic.id, pointsAtNonEpic.id]),
    );
  });

  it('keeps the No epic bucket when a real epic group shares the milestone with orphans', () => {
    const m = milestone({ id: 'm1', name: 'M1' });
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one', milestoneId: 'm1' });
    const child = ticket({ epicTaskId: 'e1', milestoneId: 'm1' });
    const orphan = ticket({ milestoneId: 'm1', epicTaskId: null });
    const sections = buildSidebar(baseInput({ milestones: [m], tickets: [epic, child, orphan] }));
    const tree = teamTree(sections);
    expect(tree[0].children.map((n) => n.label)).toEqual(['Epic one', NO_EPIC_GROUP]);
    const noEpicGroup = tree[0].children.find((n) => n.label === NO_EPIC_GROUP)!;
    expect(noEpicGroup.children.map((n) => n.taskId)).toEqual([orphan.id]);
  });
});

describe('buildSidebar epic placement', () => {
  it('lets a ticket follow its own milestone while its epic heads a group in both', () => {
    const m1 = milestone({ id: 'm1', name: 'M1' });
    const m2 = milestone({ id: 'm2', name: 'M2' });
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one', milestoneId: 'm1' });
    const child = ticket({ epicTaskId: 'e1', milestoneId: 'm2' });
    const sections = buildSidebar(baseInput({ milestones: [m1, m2], tickets: [epic, child] }));
    const tree = teamTree(sections);
    const m1Node = tree.find((n) => n.label === 'M1')!;
    const m2Node = tree.find((n) => n.label === 'M2')!;

    const epicUnderM1 = m1Node.children.find((n) => n.taskId === 'e1')!;
    expect(epicUnderM1).toBeDefined();
    expect(epicUnderM1.children).toEqual([]);
    expect(epicUnderM1.count).toBe(0);

    const epicUnderM2 = m2Node.children.find((n) => n.taskId === 'e1')!;
    expect(epicUnderM2).toBeDefined();
    expect(epicUnderM2.children.map((n) => n.taskId)).toEqual([child.id]);
    expect(epicUnderM2.count).toBe(1);

    // Same epic, two different groups — ids must differ because they're qualified by milestone.
    expect(epicUnderM1.id).not.toBe(epicUnderM2.id);
  });

  it('still headers a childless epic as an empty group, and never lists an epic as a ticket', () => {
    const m1 = milestone({ id: 'm1', name: 'M1' });
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one', milestoneId: 'm1' });
    const sections = buildSidebar(baseInput({ milestones: [m1], tickets: [epic] }));
    const tree = teamTree(sections);
    const epicNode = tree[0].children.find((n) => n.taskId === 'e1')!;
    expect(epicNode.label).toBe('Epic one');
    expect(epicNode.children).toEqual([]);
    expect(epicNode.count).toBe(0);

    function findTicketNodes(nodes: SidebarTreeNode[]): SidebarTreeNode[] {
      return nodes.flatMap((n) => (n.kind === 'ticket' ? [n] : findTicketNodes(n.children)));
    }
    expect(findTicketNodes(tree).some((n) => n.taskId === 'e1')).toBe(false);
  });
});

describe('buildSidebar counts', () => {
  it('counts a milestone as every ticket under every one of its epic groups plus No epic', () => {
    const m1 = milestone({ id: 'm1', name: 'M1' });
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one', milestoneId: 'm1' });
    const children = [
      ticket({ epicTaskId: 'e1', milestoneId: 'm1' }),
      ticket({ epicTaskId: 'e1', milestoneId: 'm1' }),
    ];
    const orphan = ticket({ milestoneId: 'm1', epicTaskId: null });
    const sections = buildSidebar(
      baseInput({ milestones: [m1], tickets: [epic, ...children, orphan] }),
    );
    const tree = teamTree(sections);
    expect(tree[0].count).toBe(3);
    const epicNode = tree[0].children.find((n) => n.taskId === 'e1')!;
    expect(epicNode.count).toBe(2);
  });
});

describe('buildSidebar folds', () => {
  it('marks only listed ids as folded, and keeps children present regardless', () => {
    const m1 = milestone({ id: 'm1', name: 'M1' });
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one', milestoneId: 'm1' });
    const child = ticket({ epicTaskId: 'e1', milestoneId: 'm1' });
    const sections = buildSidebar(
      baseInput({ milestones: [m1], tickets: [epic, child], folds: ['milestone:m1'] }),
    );
    const tree = teamTree(sections);
    expect(tree[0].folded).toBe(true);
    expect(tree[0].children).toHaveLength(1);
    const epicNode = tree[0].children[0];
    expect(epicNode.folded).toBe(false);
    expect(epicNode.children).toHaveLength(1);
  });
});

describe('buildSidebar archived milestones', () => {
  it('drops an archived milestone and its tickets from the tree', () => {
    const kept = milestone({ id: 'm-kept', name: 'Kept' });
    const archived = milestone({ id: 'm-archived', name: 'Archived' });
    const keptTicket = ticket({ milestoneId: 'm-kept' });
    const archivedTicket = ticket({ milestoneId: 'm-archived' });
    const sections = buildSidebar(
      baseInput({
        milestones: [kept, archived],
        tickets: [keptTicket, archivedTicket],
        isMilestoneArchived: (m) => m.id === 'm-archived',
      }),
    );
    const tree = teamTree(sections);
    expect(tree.map((n) => n.label)).toEqual(['Kept']);
    expect(tree[0].count).toBe(1);
  });

  it('hides nothing when isMilestoneArchived is omitted', () => {
    const m = milestone({ id: 'm1', name: 'M1' });
    const sections = buildSidebar(baseInput({ milestones: [m], tickets: [] }));
    const tree = teamTree(sections);
    expect(tree.map((n) => n.label)).toEqual(['M1']);
  });
});

describe('buildSidebar ticket ordering', () => {
  it('orders tickets by key numerically, not lexicographically — TM-9 before TM-10', () => {
    const m1 = milestone({ id: 'm1', name: 'M1' });
    const t9 = ticket({ milestoneId: 'm1', ticketKey: 'TM-9' });
    const t10 = ticket({ milestoneId: 'm1', ticketKey: 'TM-10' });
    const t2 = ticket({ milestoneId: 'm1', ticketKey: 'TM-2' });
    const sections = buildSidebar(baseInput({ milestones: [m1], tickets: [t10, t9, t2] }));
    const tree = teamTree(sections);
    // No epics in this milestone — tickets are direct children, not wrapped in No epic.
    expect(tree[0].children.map((n) => n.ticketKey)).toEqual(['TM-2', 'TM-9', 'TM-10']);
  });
});

describe('buildSidebar ticket keys', () => {
  it("falls back to a mirrored ticket's externalKey when it has no native ticketKey", () => {
    const mirrored = ticket({ ticketKey: undefined, externalKey: 'LIN-203' });
    const sections = buildSidebar(baseInput({ tickets: [mirrored] }));
    const tree = teamTree(sections);
    expect(tree[0].children.map((n) => n.ticketKey)).toEqual(['LIN-203']);
  });
});

describe("buildSidebar owner's shape", () => {
  function walk(nodes: SidebarTreeNode[]): SidebarTreeNode[] {
    return nodes.flatMap((n) => [n, ...walk(n.children)]);
  }

  // M1: only done tickets — fully finished, folds by default.
  const m1 = milestone({ id: 'm1', name: 'M1', createdAt: 1 });
  const m1Ticket = ticket({ milestoneId: 'm1', ticketKey: 'TM-1', status: 'done' });

  // M5: a mix of pending and done tickets, plus a step under one of them — open work.
  const m5 = milestone({ id: 'm5', name: 'M5', createdAt: 2 });
  const m5PendingA = ticket({ milestoneId: 'm5', ticketKey: 'TM-9', status: 'pending' });
  const m5PendingB = ticket({ milestoneId: 'm5', ticketKey: 'TM-2', status: 'pending' });
  const m5DoneA = ticket({ milestoneId: 'm5', ticketKey: 'TM-10', status: 'done' });
  const m5DoneB = ticket({ milestoneId: 'm5', ticketKey: 'TM-3', status: 'done' });
  const m5Step = ticket({
    parentTaskId: m5PendingA.id,
    milestoneId: null,
    ticketKey: 'TM-11',
    status: 'done',
  });

  // M6: only pending tickets — open work.
  const m6 = milestone({ id: 'm6', name: 'M6', createdAt: 3 });
  const m6TicketA = ticket({ milestoneId: 'm6', ticketKey: 'TM-7', status: 'pending' });
  const m6TicketB = ticket({ milestoneId: 'm6', ticketKey: 'TM-8', status: 'pending' });

  const tickets = [
    m1Ticket,
    m5PendingA,
    m5PendingB,
    m5DoneA,
    m5DoneB,
    m5Step,
    m6TicketA,
    m6TicketB,
  ];
  const milestones = [m1, m5, m6];

  it('never shows a step, anywhere, and leaves No milestone absent', () => {
    const sections = buildSidebar(baseInput({ milestones, tickets }));
    const tree = teamTree(sections);
    const allNodes = walk(tree);
    expect(allNodes.some((n) => n.taskId === m5Step.id)).toBe(false);
    expect(allNodes.some((n) => n.label === NO_MILESTONE_GROUP)).toBe(false);
  });

  it('folds a fully-done milestone by default and leaves mixed/open ones unfolded', () => {
    const tree = teamTree(buildSidebar(baseInput({ milestones, tickets, folds: [] })));
    expect(tree.find((n) => n.label === 'M1')!.folded).toBe(true);
    expect(tree.find((n) => n.label === 'M5')!.folded).toBe(false);
    expect(tree.find((n) => n.label === 'M6')!.folded).toBe(false);
  });

  it('lets an explicit fold entry override the default either way', () => {
    const unfoldedM1 = teamTree(
      buildSidebar(baseInput({ milestones, tickets, folds: ['!milestone:m1'] })),
    );
    expect(unfoldedM1.find((n) => n.label === 'M1')!.folded).toBe(false);

    const foldedM5 = teamTree(
      buildSidebar(baseInput({ milestones, tickets, folds: ['milestone:m5'] })),
    );
    expect(foldedM5.find((n) => n.label === 'M5')!.folded).toBe(true);
  });

  it('orders open-work milestones before a fully-done one', () => {
    const tree = teamTree(buildSidebar(baseInput({ milestones, tickets })));
    expect(tree.map((n) => n.label)).toEqual(['M5', 'M6', 'M1']);
  });

  it("orders M5's tickets pending-first, each half in key order, and excludes the step from count", () => {
    const tree = teamTree(buildSidebar(baseInput({ milestones, tickets })));
    const m5Node = tree.find((n) => n.label === 'M5')!;
    expect(m5Node.count).toBe(4);
    // M5 has no epics — its tickets are direct children, not wrapped in No epic.
    expect(m5Node.children.map((n) => n.ticketKey)).toEqual(['TM-2', 'TM-9', 'TM-3', 'TM-10']);
  });

  it('carries status onto ticket nodes', () => {
    const tree = teamTree(buildSidebar(baseInput({ milestones, tickets })));
    const m6Node = tree.find((n) => n.label === 'M6')!;
    expect(m6Node.children.every((n) => n.status === 'pending')).toBe(true);
  });

  it("reports M1's milestone count as open/total", () => {
    const tree = teamTree(buildSidebar(baseInput({ milestones, tickets })));
    expect(tree.find((n) => n.label === 'M1')!.openCount).toBe(0);
    expect(tree.find((n) => n.label === 'M5')!.openCount).toBe(2);
    expect(tree.find((n) => n.label === 'M6')!.openCount).toBe(2);
  });
});
