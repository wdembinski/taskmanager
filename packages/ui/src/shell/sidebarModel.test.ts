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
    workspaces: [{ id: 'w1', name: 'This machine' }],
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

  it('puts a ticket whose epic is missing, or unknown, into No epic', () => {
    const m = milestone({ id: 'm1', name: 'M1' });
    const missingEpic = ticket({ milestoneId: 'm1', epicTaskId: 'does-not-exist' });
    const noEpic = ticket({ milestoneId: 'm1', epicTaskId: null });
    const notAnEpic = ticket({ id: 'not-epic', milestoneId: 'm1' });
    const pointsAtNonEpic = ticket({ milestoneId: 'm1', epicTaskId: 'not-epic' });
    const sections = buildSidebar(
      baseInput({ milestones: [m], tickets: [missingEpic, noEpic, notAnEpic, pointsAtNonEpic] }),
    );
    const tree = teamTree(sections);
    const noEpicGroup = tree[0].children.find((n) => n.label === NO_EPIC_GROUP);
    expect(noEpicGroup).toBeDefined();
    // notAnEpic is itself a plain ticket with no epic — it lands in the bucket too.
    expect(noEpicGroup?.children.map((n) => n.taskId)).toEqual(
      expect.arrayContaining([missingEpic.id, noEpic.id, notAnEpic.id, pointsAtNonEpic.id]),
    );
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
    const noEpicGroup = tree[0].children.find((n) => n.label === NO_EPIC_GROUP)!;
    expect(noEpicGroup.children.map((n) => n.ticketKey)).toEqual(['TM-2', 'TM-9', 'TM-10']);
  });
});
