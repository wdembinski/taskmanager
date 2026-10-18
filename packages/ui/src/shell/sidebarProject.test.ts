import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@tm/shared/model';
import {
  openTicketCounts,
  parseRememberedProject,
  resolveSidebarProject,
  serializeRememberedProject,
} from './sidebarProject';

type ProjectFixture = Pick<Project, 'id' | 'ticketPrefix' | 'archivedAt'>;
type TaskFixture = Pick<Task, 'projectId' | 'status' | 'trackerArchivedAt'>;

/** A minimal ticket-project fixture — only the fields this module reads are worth naming. */
function project(overrides: Partial<ProjectFixture> = {}): ProjectFixture {
  return { id: 'p', ticketPrefix: 'P', archivedAt: null, ...overrides };
}

/** A minimal ticket fixture — only the fields `openTicketCounts` reads are worth naming. */
function ticket(overrides: Partial<TaskFixture> = {}): TaskFixture {
  return { projectId: 'p', status: 'pending', trackerArchivedAt: null, ...overrides };
}

describe('openTicketCounts', () => {
  it('tallies open tickets per project', () => {
    const counts = openTicketCounts([
      ticket({ projectId: 'tm' }),
      ticket({ projectId: 'tm' }),
      ticket({ projectId: 'em' }),
    ]);
    expect(counts).toEqual(
      new Map([
        ['tm', 2],
        ['em', 1],
      ]),
    );
  });

  it('does not count a closed ticket (done/cancelled)', () => {
    const counts = openTicketCounts([
      ticket({ projectId: 'tm', status: 'done' }),
      ticket({ projectId: 'tm', status: 'cancelled' }),
      ticket({ projectId: 'tm', status: 'pending' }),
    ]);
    expect(counts).toEqual(new Map([['tm', 1]]));
  });

  it('does not count a tracker-archived ticket', () => {
    const counts = openTicketCounts([
      ticket({ projectId: 'tm', trackerArchivedAt: 1700000000000 }),
      ticket({ projectId: 'tm' }),
    ]);
    expect(counts).toEqual(new Map([['tm', 1]]));
  });

  it('returns an empty map for no tickets', () => {
    expect(openTicketCounts([])).toEqual(new Map());
  });
});

describe('resolveSidebarProject', () => {
  it('picks the project with the most open tickets, not the oldest', () => {
    const trav = project({ id: 'trav', ticketPrefix: 'TRAV' });
    const tm = project({ id: 'tm', ticketPrefix: 'TM' });
    const em = project({ id: 'em', ticketPrefix: 'EM' });
    const openCounts = new Map([
      ['tm', 446],
      ['em', 168],
    ]);

    expect(
      resolveSidebarProject({ projects: [trav, tm, em], openCounts, rememberedId: null }),
    ).toBe('tm');
  });

  it('honours a remembered project even though it is empty', () => {
    const trav = project({ id: 'trav', ticketPrefix: 'TRAV' });
    const tm = project({ id: 'tm', ticketPrefix: 'TM' });
    const em = project({ id: 'em', ticketPrefix: 'EM' });
    const openCounts = new Map([
      ['tm', 446],
      ['em', 168],
    ]);

    expect(
      resolveSidebarProject({ projects: [trav, tm, em], openCounts, rememberedId: 'trav' }),
    ).toBe('trav');
  });

  it('falls back when the remembered project is archived', () => {
    const trav = project({ id: 'trav', ticketPrefix: 'TRAV' });
    const tm = project({ id: 'tm', ticketPrefix: 'TM', archivedAt: 1700000000000 });
    const em = project({ id: 'em', ticketPrefix: 'EM' });
    const openCounts = new Map([
      ['tm', 446],
      ['em', 168],
    ]);

    expect(
      resolveSidebarProject({ projects: [trav, tm, em], openCounts, rememberedId: 'tm' }),
    ).toBe('em');
  });

  it('falls back when the remembered project id no longer exists', () => {
    const trav = project({ id: 'trav', ticketPrefix: 'TRAV' });
    const em = project({ id: 'em', ticketPrefix: 'EM' });
    const openCounts = new Map([['em', 168]]);

    expect(resolveSidebarProject({ projects: [trav, em], openCounts, rememberedId: 'tm' })).toBe(
      'em',
    );
  });

  it('falls back when the remembered project is not a ticket project', () => {
    const trav = project({ id: 'trav', ticketPrefix: 'TRAV' });
    const agent = project({ id: 'agent', ticketPrefix: '' });
    const em = project({ id: 'em', ticketPrefix: 'EM' });
    const openCounts = new Map([['em', 168]]);

    expect(
      resolveSidebarProject({ projects: [trav, agent, em], openCounts, rememberedId: 'agent' }),
    ).toBe('em');
  });

  it('breaks a tie in favour of the earlier (older) candidate', () => {
    const trav = project({ id: 'trav', ticketPrefix: 'TRAV' });
    const tm = project({ id: 'tm', ticketPrefix: 'TM' });
    const openCounts = new Map([
      ['trav', 10],
      ['tm', 10],
    ]);

    expect(resolveSidebarProject({ projects: [trav, tm], openCounts, rememberedId: null })).toBe(
      'trav',
    );
  });

  it('returns null when there are no ticket projects', () => {
    const agent = project({ id: 'agent', ticketPrefix: '' });
    const archived = project({ id: 'archived', ticketPrefix: 'ARC', archivedAt: 1700000000000 });

    expect(
      resolveSidebarProject({
        projects: [agent, archived],
        openCounts: new Map(),
        rememberedId: null,
      }),
    ).toBeNull();
    expect(
      resolveSidebarProject({ projects: [], openCounts: new Map(), rememberedId: null }),
    ).toBeNull();
  });
});

describe('parseRememberedProject', () => {
  it('reads back a JSON-encoded project id', () => {
    expect(parseRememberedProject('"tm"')).toBe('tm');
  });

  it('falls back to null for a never-written key', () => {
    expect(parseRememberedProject(null)).toBeNull();
    expect(parseRememberedProject(undefined)).toBeNull();
    expect(parseRememberedProject('')).toBeNull();
  });

  it('falls back to null for invalid JSON', () => {
    expect(parseRememberedProject('not json')).toBeNull();
  });

  it('falls back to null for JSON that is not a non-empty string', () => {
    expect(parseRememberedProject('{"a":1}')).toBeNull();
    expect(parseRememberedProject('42')).toBeNull();
    expect(parseRememberedProject('""')).toBeNull();
  });
});

describe('serializeRememberedProject', () => {
  it('round-trips through parseRememberedProject', () => {
    expect(parseRememberedProject(serializeRememberedProject('tm'))).toBe('tm');
  });
});
