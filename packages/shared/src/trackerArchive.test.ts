import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  archivedBy,
  archiveIndexOf,
  isHidden,
  pickableEpics,
  pickableMilestones,
  pickableProjects,
  visibleTickets,
  type ArchivableMilestone,
  type ArchivableProject,
  type ArchivableTicket,
  type ArchiveIndex,
} from './trackerArchive';

// `trackerArchivedAt` does not exist on `Task` yet — F14.1 adds the real column — so the
// fixture carries it as an extra, optional field, matching `ArchivableTicket`.
type TestTicket = Task & { trackerArchivedAt?: number | null };

const ticket = (over: Partial<TestTicket>): TestTicket => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'ticket',
  isContract: false,
  isScaffold: false,
  ...over,
});

function indexOf(opts: {
  milestones?: readonly ArchivableMilestone[];
  epics?: readonly ArchivableTicket[];
  projects?: readonly ArchivableProject[];
}): ArchiveIndex {
  return archiveIndexOf(opts.milestones ?? [], opts.epics ?? [], opts.projects ?? []);
}

describe('archivedBy', () => {
  it('is hidden by an archived project', () => {
    const t = ticket({ id: 't1', projectId: 'p1' });
    const index = indexOf({ projects: [{ id: 'p1', archivedAt: 1 }] });
    expect(archivedBy(t, index)).toEqual({ by: 'project', id: 'p1' });
  });

  it('is hidden by an archived milestone', () => {
    const t = ticket({ id: 't1', milestoneId: 'm1' });
    const index = indexOf({ milestones: [{ id: 'm1', archivedAt: 1 }] });
    expect(archivedBy(t, index)).toEqual({ by: 'milestone', id: 'm1' });
  });

  it('is hidden by an archived epic', () => {
    const t = ticket({ id: 't1', epicTaskId: 'e1' });
    const index = indexOf({ epics: [ticket({ id: 'e1', trackerArchivedAt: 1 })] });
    expect(archivedBy(t, index)).toEqual({ by: 'epic', id: 'e1' });
  });

  it('is hidden by itself', () => {
    const t = ticket({ id: 't1', trackerArchivedAt: 1 });
    const index = indexOf({});
    expect(archivedBy(t, index)).toEqual({ by: 'self', id: 't1' });
  });

  it('nothing archived returns null, and the ticket is not hidden', () => {
    const t = ticket({ id: 't1', projectId: 'p1', milestoneId: 'm1', epicTaskId: 'e1' });
    const index = indexOf({
      projects: [{ id: 'p1', archivedAt: null }],
      milestones: [{ id: 'm1', archivedAt: null }],
      epics: [ticket({ id: 'e1', trackerArchivedAt: null })],
    });
    expect(archivedBy(t, index)).toBeNull();
    expect(isHidden(t, index)).toBe(false);
  });

  describe('precedence', () => {
    it('project wins when project, milestone, epic and self are all archived', () => {
      const t = ticket({
        id: 't1',
        projectId: 'p1',
        milestoneId: 'm1',
        epicTaskId: 'e1',
        trackerArchivedAt: 1,
      });
      const index = indexOf({
        projects: [{ id: 'p1', archivedAt: 1 }],
        milestones: [{ id: 'm1', archivedAt: 1 }],
        epics: [ticket({ id: 'e1', trackerArchivedAt: 1 })],
      });
      expect(archivedBy(t, index)).toEqual({ by: 'project', id: 'p1' });
    });

    it('milestone wins when milestone, epic and self are archived but project is not', () => {
      const t = ticket({
        id: 't1',
        projectId: 'p1',
        milestoneId: 'm1',
        epicTaskId: 'e1',
        trackerArchivedAt: 1,
      });
      const index = indexOf({
        projects: [{ id: 'p1', archivedAt: null }],
        milestones: [{ id: 'm1', archivedAt: 1 }],
        epics: [ticket({ id: 'e1', trackerArchivedAt: 1 })],
      });
      expect(archivedBy(t, index)).toEqual({ by: 'milestone', id: 'm1' });
    });

    it('epic wins when epic and self are archived but project and milestone are not', () => {
      const t = ticket({
        id: 't1',
        projectId: 'p1',
        milestoneId: 'm1',
        epicTaskId: 'e1',
        trackerArchivedAt: 1,
      });
      const index = indexOf({
        projects: [{ id: 'p1', archivedAt: null }],
        milestones: [{ id: 'm1', archivedAt: null }],
        epics: [ticket({ id: 'e1', trackerArchivedAt: 1 })],
      });
      expect(archivedBy(t, index)).toEqual({ by: 'epic', id: 'e1' });
    });
  });

  it('a milestoneId missing from the index is not hidden', () => {
    const t = ticket({ id: 't1', milestoneId: 'ghost' });
    expect(archivedBy(t, indexOf({}))).toBeNull();
  });

  it('an epicTaskId missing from the index is not hidden', () => {
    const t = ticket({ id: 't1', epicTaskId: 'ghost' });
    expect(archivedBy(t, indexOf({}))).toBeNull();
  });

  it('a projectId missing from the index is not hidden', () => {
    const t = ticket({ id: 't1', projectId: 'ghost' });
    expect(archivedBy(t, indexOf({}))).toBeNull();
  });

  it('is never hidden for a jira-sourced row, even with its project, milestone and own flag all archived', () => {
    const t = ticket({
      id: 't1',
      source: 'jira',
      projectId: 'p1',
      milestoneId: 'm1',
      trackerArchivedAt: 1,
    });
    const index = indexOf({
      projects: [{ id: 'p1', archivedAt: 1 }],
      milestones: [{ id: 'm1', archivedAt: 1 }],
    });
    expect(archivedBy(t, index)).toBeNull();
  });

  it('is never hidden for a github-sourced row, even with its project, milestone and own flag all archived', () => {
    const t = ticket({
      id: 't1',
      source: 'github',
      projectId: 'p1',
      milestoneId: 'm1',
      trackerArchivedAt: 1,
    });
    const index = indexOf({
      projects: [{ id: 'p1', archivedAt: 1 }],
      milestones: [{ id: 'm1', archivedAt: 1 }],
    });
    expect(archivedBy(t, index)).toBeNull();
  });

  it('is never hidden for an adhoc row, even with its project, milestone and own flag all archived', () => {
    const t = ticket({
      id: 't1',
      source: 'adhoc',
      projectId: 'p1',
      milestoneId: 'm1',
      trackerArchivedAt: 1,
    });
    const index = indexOf({
      projects: [{ id: 'p1', archivedAt: 1 }],
      milestones: [{ id: 'm1', archivedAt: 1 }],
    });
    expect(archivedBy(t, index)).toBeNull();
  });

  it('Task.archivedAt (board removal) set alone does not hide', () => {
    const t = ticket({ id: 't1', archivedAt: Date.now(), archivedReason: 'gone-from-jira' });
    expect(archivedBy(t, indexOf({}))).toBeNull();
  });
});

describe('isHidden', () => {
  it('includeArchived shows an otherwise-hidden ticket', () => {
    const t = ticket({ id: 't1', milestoneId: 'm1' });
    const index = indexOf({ milestones: [{ id: 'm1', archivedAt: 1 }] });
    expect(isHidden(t, index)).toBe(true);
    expect(isHidden(t, index, { includeArchived: true })).toBe(false);
  });
});

describe('visibleTickets', () => {
  it('drops hidden tickets and keeps the rest in order', () => {
    const visible = ticket({ id: 'visible' });
    const hidden = ticket({ id: 'hidden', milestoneId: 'm1' });
    const other = ticket({ id: 'other' });
    const index = indexOf({ milestones: [{ id: 'm1', archivedAt: 1 }] });

    expect(visibleTickets([visible, hidden, other], index)).toEqual([visible, other]);
  });

  it('returns every ticket, in order, with includeArchived', () => {
    const visible = ticket({ id: 'visible' });
    const hidden = ticket({ id: 'hidden', milestoneId: 'm1' });
    const other = ticket({ id: 'other' });
    const index = indexOf({ milestones: [{ id: 'm1', archivedAt: 1 }] });

    expect(visibleTickets([visible, hidden, other], index, { includeArchived: true })).toEqual([
      visible,
      hidden,
      other,
    ]);
  });
});

describe('pickableMilestones', () => {
  it('drops archived entries, keeps the archived currentId, and keeps order', () => {
    const open: ArchivableMilestone = { id: 'open', archivedAt: null };
    const archived: ArchivableMilestone = { id: 'archived', archivedAt: 1 };
    const current: ArchivableMilestone = { id: 'current', archivedAt: 1 };

    expect(pickableMilestones([open, archived, current], 'current')).toEqual([open, current]);
    expect(pickableMilestones([open, archived, current])).toEqual([open]);
  });
});

describe('pickableEpics', () => {
  it('drops archived entries, keeps the archived currentId, and keeps order', () => {
    const open = ticket({ id: 'open', trackerArchivedAt: null });
    const archived = ticket({ id: 'archived', trackerArchivedAt: 1 });
    const current = ticket({ id: 'current', trackerArchivedAt: 1 });

    expect(pickableEpics([open, archived, current], 'current')).toEqual([open, current]);
    expect(pickableEpics([open, archived, current])).toEqual([open]);
  });
});

describe('pickableProjects', () => {
  it('drops archived entries, keeps the archived currentId, and keeps order', () => {
    const open: ArchivableProject = { id: 'open', archivedAt: null };
    const archived: ArchivableProject = { id: 'archived', archivedAt: 1 };
    const current: ArchivableProject = { id: 'current', archivedAt: 1 };

    expect(pickableProjects([open, archived, current], 'current')).toEqual([open, current]);
    expect(pickableProjects([open, archived, current])).toEqual([open]);
  });
});
