import { describe, expect, it } from 'vitest';
import type { Milestone, Task } from '@tm/shared/model';
import { archiveIndexOf } from '@tm/shared/trackerArchive';
import { buildSidebar, NO_MILESTONE_GROUP } from '../shell/sidebarModel';
import {
  backlogEpicGroups,
  backlogGroups,
  type BacklogGroupMode,
  backlogMilestoneGroups,
  type BacklogSection,
  parseGroupMode,
} from './backlogGrouping';
import { backlogStatusGroups } from './backlogStatus';
import { NO_EPIC_GROUP } from './backlogView';

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

function milestone(overrides: Partial<Milestone> & { id: string }): Milestone {
  return {
    projectId: 'proj',
    name: overrides.id,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: 0,
    ...overrides,
  };
}

const base = { query: '', sortKey: 'key' as const };

/** Every row under `sections`, at any depth. */
function allRows(sections: BacklogSection[]): Task[] {
  return sections.flatMap((s) => [...s.tickets, ...allRows(s.sections)]);
}

describe('parseGroupMode', () => {
  it('round-trips every mode', () => {
    for (const mode of ['status', 'epic', 'milestone'] as BacklogGroupMode[]) {
      expect(parseGroupMode(mode)).toBe(mode);
    }
  });

  it('reads anything else as status', () => {
    expect(parseGroupMode(null)).toBe('status');
    expect(parseGroupMode(undefined)).toBe('status');
    expect(parseGroupMode('')).toBe('status');
    expect(parseGroupMode('Milestone')).toBe('status');
    expect(parseGroupMode('swimlane')).toBe('status');
  });
});

describe('backlogGroups — status', () => {
  it('holds exactly backlogStatusGroups contents, one level, no Add child', () => {
    const epic = ticket({ issueType: 'epic', status: 'in-progress' });
    const tickets = [
      epic,
      ticket({ ticketKey: 'TM-3', status: 'done' }),
      ticket({ ticketKey: 'TM-1', status: 'pending', epicTaskId: epic.id }),
      ticket({ ticketKey: 'TM-2', status: 'in-progress' }),
    ];
    const sections = backlogGroups('status', { ...base, tickets, milestones: [] });
    const groups = backlogStatusGroups(tickets, '', 'key');
    expect(sections.map((s) => s.id)).toEqual(groups.map((g) => `status:${g.column}`));
    expect(sections.map((s) => s.label)).toEqual(groups.map((g) => g.label));
    expect(sections.map((s) => s.tickets)).toEqual(groups.map((g) => g.tickets));
    for (const s of sections) {
      expect(s.level).toBe(1);
      expect(s.sections).toEqual([]);
      expect(s.addChildEpicId).toBeUndefined();
    }
  });
});

describe('backlogEpicGroups', () => {
  it('heads a group per epic, No epic last, Add child on real epics only', () => {
    const epic = ticket({ issueType: 'epic', title: 'Payments' });
    const empty = ticket({ issueType: 'epic', title: 'Empty' });
    const child = ticket({ epicTaskId: epic.id });
    const orphan = ticket();
    const sections = backlogEpicGroups({
      ...base,
      tickets: [epic, empty, child, orphan],
      milestones: [],
    });
    expect(sections.map((s) => [s.id, s.label, s.addChildEpicId])).toEqual([
      [`epic:${epic.id}`, 'Payments', epic.id],
      [`epic:${empty.id}`, 'Empty', empty.id],
      ['epic:none', NO_EPIC_GROUP, undefined],
    ]);
    expect(sections[0].tickets).toEqual([child]);
    expect(sections[1].tickets).toEqual([]);
    expect(sections[2].tickets).toEqual([orphan]);
  });
});

describe('backlogMilestoneGroups', () => {
  it('orders milestones exactly as the sidebar does', () => {
    const milestones = [
      milestone({ id: 'closed', closed: true, dueAt: 1 }),
      milestone({ id: 'late', dueAt: 300 }),
      milestone({ id: 'finished', dueAt: 100 }),
      milestone({ id: 'undated' }),
      milestone({ id: 'soon', dueAt: 200 }),
    ];
    const tickets = [
      ticket({ milestoneId: 'closed', status: 'done' }),
      ticket({ milestoneId: 'late' }),
      ticket({ milestoneId: 'finished', status: 'done' }),
      ticket({ milestoneId: 'undated' }),
      ticket({ milestoneId: 'soon' }),
      ticket({ milestoneId: null }),
    ];
    const sections = backlogMilestoneGroups({ ...base, tickets, milestones });

    const team = buildSidebar({
      workspaces: [],
      projects: [],
      milestones,
      tickets,
      attentionCount: 0,
      archivedCount: 0,
      folds: [],
    }).find((s) => s.kind === 'team');
    const sidebarOrder = team && team.kind === 'team' ? team.tree.map((n) => n.id) : [];

    expect(sections.map((s) => s.id)).toEqual(sidebarOrder);
    expect(sections.map((s) => s.label)).toEqual([
      'soon',
      'late',
      'undated',
      NO_MILESTONE_GROUP,
      'finished',
      'closed',
    ]);
  });

  it('puts a finished No milestone after the finished open milestones', () => {
    const milestones = [milestone({ id: 'open' }), milestone({ id: 'done', dueAt: 5 })];
    const tickets = [
      ticket({ milestoneId: 'open' }),
      ticket({ milestoneId: 'done', status: 'done' }),
      ticket({ milestoneId: null, status: 'done' }),
    ];
    const sections = backlogMilestoneGroups({ ...base, tickets, milestones });
    expect(sections.map((s) => s.label)).toEqual(['open', 'done', NO_MILESTONE_GROUP]);
  });

  it('lands a null or unknown milestoneId in No milestone', () => {
    const none = ticket({ milestoneId: null });
    const dangling = ticket({ milestoneId: 'gone' });
    const sections = backlogMilestoneGroups({
      ...base,
      tickets: [none, dangling],
      milestones: [milestone({ id: 'm1' })],
    });
    expect(sections.map((s) => s.id)).toEqual(['milestone:none']);
    expect(sections[0].label).toBe(NO_MILESTONE_GROUP);
    expect(sections[0].tickets).toEqual([none, dangling]);
  });

  it('nests epics as level 2 only where the milestone heads one', () => {
    const epic = ticket({ issueType: 'epic', milestoneId: 'm1', title: 'Checkout' });
    const child = ticket({ milestoneId: 'm1', epicTaskId: epic.id });
    const loose = ticket({ milestoneId: 'm1' });
    const flat = ticket({ milestoneId: 'm2' });
    const sections = backlogMilestoneGroups({
      ...base,
      tickets: [epic, child, loose, flat],
      milestones: [milestone({ id: 'm1', dueAt: 1 }), milestone({ id: 'm2', dueAt: 2 })],
    });

    const [m1, m2] = sections;
    expect(m1.tickets).toEqual([]);
    expect(m1.sections.map((s) => [s.id, s.label, s.level, s.addChildEpicId])).toEqual([
      [`milestone:m1/epic:${epic.id}`, 'Checkout', 2, epic.id],
      ['milestone:m1/epic:none', NO_EPIC_GROUP, 2, undefined],
    ]);
    expect(m1.sections[0].tickets).toEqual([child]);
    expect(m1.sections[1].tickets).toEqual([loose]);

    expect(m2.sections).toEqual([]);
    expect(m2.tickets).toEqual([flat]);
    expect(m2.addChildEpicId).toBeUndefined();
  });

  it('keeps an empty epic sub-header, so Add child stays reachable', () => {
    const epic = ticket({ issueType: 'epic', milestoneId: 'm1' });
    const sections = backlogMilestoneGroups({
      ...base,
      tickets: [epic],
      milestones: [milestone({ id: 'm1' })],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].sections.map((s) => [s.addChildEpicId, s.tickets])).toEqual([[epic.id, []]]);
  });

  it('keeps the Sort-by-due order inside a group', () => {
    const late = ticket({ ticketKey: 'TM-1', milestoneId: 'm1', dueAt: 300 });
    const undated = ticket({ ticketKey: 'TM-2', milestoneId: 'm1', dueAt: null });
    const early = ticket({ ticketKey: 'TM-3', milestoneId: 'm1', dueAt: 100 });
    const sections = backlogMilestoneGroups({
      ...base,
      sortKey: 'due',
      tickets: [late, undated, early],
      milestones: [milestone({ id: 'm1' })],
    });
    expect(sections[0].tickets.map((t) => t.ticketKey)).toEqual(['TM-3', 'TM-1', 'TM-2']);
  });

  it('drops a milestone a search leaves empty', () => {
    const hit = ticket({ title: 'Fix login', milestoneId: 'm1' });
    const miss = ticket({ title: 'Other', milestoneId: 'm2' });
    const sections = backlogMilestoneGroups({
      ...base,
      query: 'login',
      tickets: [hit, miss],
      milestones: [milestone({ id: 'm1' }), milestone({ id: 'm2' })],
    });
    expect(sections.map((s) => s.id)).toEqual(['milestone:m1']);
    expect(sections[0].tickets).toEqual([hit]);
  });

  it('drops an archived milestone unless includeArchived', () => {
    const milestones = [milestone({ id: 'old', archivedAt: 1_000 }), milestone({ id: 'live' })];
    const archived = ticket({ milestoneId: 'old' });
    const live = ticket({ milestoneId: 'live' });
    const index = archiveIndexOf(milestones, [], []);
    const input = { ...base, tickets: [archived, live], milestones };

    const hidden = backlogMilestoneGroups({ ...input, archive: { index } });
    expect(hidden.map((s) => s.id)).toEqual(['milestone:live']);
    expect(allRows(hidden)).toEqual([live]);

    const shown = backlogMilestoneGroups({ ...input, archive: { index, includeArchived: true } });
    expect(new Set(shown.map((s) => s.id))).toEqual(new Set(['milestone:old', 'milestone:live']));
    expect(new Set(allRows(shown))).toEqual(new Set([archived, live]));
  });
});

describe('backlogGroups — every mode', () => {
  const modes: BacklogGroupMode[] = ['status', 'epic', 'milestone'];

  it('hides an archived ticket before grouping', () => {
    const epic = ticket({ issueType: 'epic', milestoneId: 'm1' });
    const live = ticket({ milestoneId: 'm1', epicTaskId: epic.id });
    const gone = ticket({ milestoneId: 'm1', epicTaskId: epic.id, trackerArchivedAt: 5 });
    const index = archiveIndexOf([], [epic], []);
    for (const mode of modes) {
      const sections = backlogGroups(mode, {
        ...base,
        tickets: [epic, live, gone],
        milestones: [milestone({ id: 'm1' })],
        archive: { index },
      });
      expect(allRows(sections), mode).toEqual([live]);
    }
  });

  it('never lists a step', () => {
    const epic = ticket({ issueType: 'epic', milestoneId: 'm1' });
    const parent = ticket({ milestoneId: 'm1', epicTaskId: epic.id });
    const step = ticket({ milestoneId: 'm1', epicTaskId: epic.id, parentTaskId: parent.id });
    const orphanStep = ticket({ parentTaskId: parent.id });
    for (const mode of modes) {
      const sections = backlogGroups(mode, {
        ...base,
        tickets: [epic, parent, step, orphanStep],
        milestones: [milestone({ id: 'm1' })],
      });
      expect(allRows(sections), mode).toEqual([parent]);
    }
  });
});
