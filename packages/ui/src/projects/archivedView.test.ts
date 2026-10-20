import { describe, expect, it } from 'vitest';
import type { Milestone, Project, Task } from '@tm/shared/model';
import type { ArchivedListing } from '@tm/shared/trackerArchive';
import { archivedTicketSummary, archivedViewModel } from './archivedView';

let seq = 0;

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  seq += 1;
  return {
    id: `m${seq}`,
    projectId: 'p1',
    name: 'Milestone',
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: 1_000,
    createdAt: 0,
    ...overrides,
  };
}

/** A minimal epic fixture — an epic is just a `Task` with `issueType: 'epic'`. */
function epic(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return ticket({
    id: `e${seq}`,
    issueType: 'epic',
    title: 'Epic',
    trackerArchivedAt: 1_000,
    ...overrides,
  });
}

function project(overrides: Partial<Project> = {}): Project {
  seq += 1;
  return {
    id: `pr${seq}`,
    name: 'Untitled',
    path: '',
    planPath: '',
    defaultModel: 'sonnet',
    planningModel: null,
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: true,
    baseBranch: '',
    writeBackPlan: false,
    autoRelease: false,
    autoCreatePr: false,
    autoMergeOnGreen: false,
    autoMergeMethod: 'squash',
    autoMergeBy: 'forge',
    autoMergeRequiredChecks: [],
    autoIntegrate: null,
    autoApprovePlans: false,
    autoApproveMaxSteps: 6,
    readyLanes: 3,
    autoDoneOnLand: false,
    autoVisualSignOff: false,
    autoVisualSignOffMaxRounds: 2,
    planAligned: true,
    jiraEpicKeys: [],
    ticketPrefix: '',
    target: { kind: 'local' },
    instructions: '',
    color: '',
    createdAt: 0,
    archivedAt: 1_000,
    ...overrides,
  };
}

function ticket(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    projectId: 'p1',
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

function listing(overrides: Partial<ArchivedListing> = {}): ArchivedListing {
  return { projects: [], milestones: [], epics: [], ...overrides };
}

describe('archivedViewModel', () => {
  it('groups tickets under their milestone, epic and project rows', () => {
    const m = milestone({ id: 'm1' });
    const e = epic({ id: 'e1' });
    const p = project({ id: 'p1' });
    const onMilestone = ticket({ milestoneId: 'm1', status: 'done' });
    const onEpic = ticket({ epicTaskId: 'e1', status: 'done' });
    const onProject = ticket({ projectId: 'p1', status: 'done' });

    const model = archivedViewModel(
      listing({ milestones: [m], epics: [e], projects: [p] }),
      [onMilestone, onEpic, onProject],
      'p1',
    );

    expect(model.milestones[0].tickets).toEqual([onMilestone]);
    expect(model.epics[0].tickets).toEqual([onEpic]);
    // every ticket in this fixture is `projectId: 'p1'`, so the project row collects all three
    expect(model.projects[0].tickets).toHaveLength(3);
  });

  it('counts done and open tickets separately', () => {
    const m = milestone({ id: 'm1' });
    const done = ticket({ milestoneId: 'm1', status: 'done' });
    const cancelled = ticket({ milestoneId: 'm1', status: 'cancelled' });
    const open = ticket({ milestoneId: 'm1', status: 'in-progress' });

    const model = archivedViewModel(listing({ milestones: [m] }), [done, cancelled, open], 'p1');

    expect(model.milestones[0].doneCount).toBe(2);
    expect(model.milestones[0].openCount).toBe(1);
  });

  it('flags a row with an open ticket, and does not flag a fully-done one', () => {
    const open = milestone({ id: 'm1' });
    const closed = milestone({ id: 'm2' });
    const model = archivedViewModel(
      listing({ milestones: [open, closed] }),
      [
        ticket({ milestoneId: 'm1', status: 'in-progress' }),
        ticket({ milestoneId: 'm2', status: 'done' }),
      ],
      'p1',
    );
    const openRow = model.milestones.find((r) => r.id === 'm1')!;
    const closedRow = model.milestones.find((r) => r.id === 'm2')!;
    expect(openRow.flagged).toBe(true);
    expect(closedRow.flagged).toBe(false);
  });

  it('never counts a JIRA-sourced ticket', () => {
    const m = milestone({ id: 'm1' });
    const jiraTicket = ticket({ milestoneId: 'm1', source: 'jira', status: 'in-progress' });
    const model = archivedViewModel(listing({ milestones: [m] }), [jiraTicket], 'p1');
    expect(model.milestones[0].tickets).toEqual([]);
    expect(model.milestones[0].openCount).toBe(0);
    expect(model.milestones[0].flagged).toBe(false);
  });

  it('names an epic row "KEY · title", and a milestone/project row by its own name', () => {
    const m = milestone({ id: 'm1', name: 'M2 · Review' });
    const e = epic({ id: 'e1', ticketKey: 'TM-9', title: 'Linear integration' });
    const p = project({ id: 'p1', name: 'Task Manager' });
    const model = archivedViewModel(
      listing({ milestones: [m], epics: [e], projects: [p] }),
      [],
      'p1',
    );
    expect(model.milestones[0].name).toBe('M2 · Review');
    expect(model.epics[0].name).toBe('TM-9 · Linear integration');
    expect(model.projects[0].name).toBe('Task Manager');
  });

  it('falls back to the plain title when an epic has no key', () => {
    const e = epic({ id: 'e1', ticketKey: null, title: 'Linear integration' });
    const model = archivedViewModel(listing({ epics: [e] }), [], 'p1');
    expect(model.epics[0].name).toBe('Linear integration');
  });

  it("scopes milestones and epics to projectId, dropping another project's row", () => {
    const here = milestone({ id: 'm1', projectId: 'p1' });
    const elsewhere = milestone({ id: 'm2', projectId: 'p2' });
    const model = archivedViewModel(listing({ milestones: [here, elsewhere] }), [], 'p1');
    expect(model.milestones.map((r) => r.id)).toEqual(['m1']);
  });

  it('keeps every archived project regardless of projectId', () => {
    const p1 = project({ id: 'p1' });
    const p2 = project({ id: 'p2' });
    const model = archivedViewModel(listing({ projects: [p1, p2] }), [], 'p1');
    expect(model.projects.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('shows every milestone and epic when projectId is null', () => {
    const here = milestone({ id: 'm1', projectId: 'p1' });
    const elsewhere = milestone({ id: 'm2', projectId: 'p2' });
    const model = archivedViewModel(listing({ milestones: [here, elsewhere] }), [], null);
    expect(model.milestones.map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('sorts each group by archivedAt, newest first', () => {
    const oldest = milestone({ id: 'm1', archivedAt: 1_000 });
    const newest = milestone({ id: 'm2', archivedAt: 3_000 });
    const middle = milestone({ id: 'm3', archivedAt: 2_000 });
    const model = archivedViewModel(listing({ milestones: [oldest, newest, middle] }), [], 'p1');
    expect(model.milestones.map((r) => r.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('totals the three groups', () => {
    const model = archivedViewModel(
      listing({
        milestones: [milestone(), milestone()],
        epics: [epic()],
        projects: [project()],
      }),
      [],
      null,
    );
    expect(model.total).toBe(4);
  });

  it('reads a listing missing a key as empty, rather than throwing', () => {
    const model = archivedViewModel({} as ArchivedListing, [], 'p1');
    expect(model).toEqual({ milestones: [], epics: [], projects: [], total: 0 });
  });

  it("carries a milestone's own dueAt, and leaves it null for epics and projects", () => {
    const m = milestone({ id: 'm1', dueAt: 5_000 });
    const e = epic({ id: 'e1' });
    const p = project({ id: 'p1' });
    const model = archivedViewModel(
      listing({ milestones: [m], epics: [e], projects: [p] }),
      [],
      'p1',
    );
    expect(model.milestones[0].dueAt).toBe(5_000);
    expect(model.epics[0].dueAt).toBeNull();
    expect(model.projects[0].dueAt).toBeNull();
  });

  it("sorts a row's tickets in key order, numerically — TM-9 before TM-10", () => {
    const m = milestone({ id: 'm1' });
    const t10 = ticket({ milestoneId: 'm1', ticketKey: 'TM-10' });
    const t9 = ticket({ milestoneId: 'm1', ticketKey: 'TM-9' });
    const t2 = ticket({ milestoneId: 'm1', ticketKey: 'TM-2' });
    const model = archivedViewModel(listing({ milestones: [m] }), [t10, t9, t2], 'p1');
    expect(model.milestones[0].tickets.map((t) => t.ticketKey)).toEqual(['TM-2', 'TM-9', 'TM-10']);
  });
});

describe('archivedTicketSummary', () => {
  it('reads "No tickets" for an empty row', () => {
    const m = milestone({ id: 'm1' });
    const model = archivedViewModel(listing({ milestones: [m] }), [], 'p1');
    expect(archivedTicketSummary(model.milestones[0])).toBe('No tickets');
  });

  it('reads "N done" when nothing is open', () => {
    const m = milestone({ id: 'm1' });
    const tickets = Array.from({ length: 12 }, () => ticket({ milestoneId: 'm1', status: 'done' }));
    const model = archivedViewModel(listing({ milestones: [m] }), tickets, 'p1');
    expect(archivedTicketSummary(model.milestones[0])).toBe('12 done');
  });

  it('reads "N done · M open" when some are open', () => {
    const m = milestone({ id: 'm1' });
    const done = Array.from({ length: 41 }, () => ticket({ milestoneId: 'm1', status: 'done' }));
    const open = ticket({ milestoneId: 'm1', status: 'in-progress' });
    const model = archivedViewModel(listing({ milestones: [m] }), [...done, open], 'p1');
    expect(archivedTicketSummary(model.milestones[0])).toBe('41 done · 1 open');
  });
});
