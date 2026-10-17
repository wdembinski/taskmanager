import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import { archiveIndexOf } from '@tm/shared/trackerArchive';
import { backlogStatusGroups } from './backlogStatus';

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

describe('backlogStatusGroups', () => {
  it('orders groups in-progress, in-review, blocked, todo, done', () => {
    const tickets = [
      ticket({ status: 'done' }),
      ticket({ status: 'pending' }),
      ticket({ status: 'blocked' }),
      ticket({ status: 'in-review' }),
      ticket({ status: 'in-progress' }),
    ];
    const groups = backlogStatusGroups(tickets, '', 'key');
    expect(groups.map((g) => g.column)).toEqual([
      'in-progress',
      'in-review',
      'blocked',
      'todo',
      'done',
    ]);
  });

  it('labels a group from the column badge, so it reads "In Progress"', () => {
    const groups = backlogStatusGroups([ticket({ status: 'in-progress' })], '', 'key');
    expect(groups[0].label).toBe('In Progress');
  });

  it('drops epics rather than grouping them', () => {
    const epic = ticket({ issueType: 'epic', status: 'in-progress' });
    const child = ticket({ status: 'in-progress', epicTaskId: epic.id });
    const groups = backlogStatusGroups([epic, child], '', 'key');
    const all = groups.flatMap((g) => g.tickets);
    expect(all).toEqual([child]);
  });

  it('omits a column with nothing in it instead of rendering it empty', () => {
    const groups = backlogStatusGroups([ticket({ status: 'in-progress' })], '', 'key');
    expect(groups).toHaveLength(1);
    expect(groups[0].column).toBe('in-progress');
  });

  it('respects the query, filtering before grouping', () => {
    const match = ticket({ title: 'Fix the login flow', status: 'in-progress' });
    const other = ticket({ title: 'Unrelated', status: 'in-progress' });
    const groups = backlogStatusGroups([match, other], 'login', 'key');
    expect(groups.flatMap((g) => g.tickets)).toEqual([match]);
  });

  it('respects the sort key within a group', () => {
    const t10 = ticket({ ticketKey: 'TM-10', status: 'pending' });
    const t9 = ticket({ ticketKey: 'TM-9', status: 'pending' });
    const t2 = ticket({ ticketKey: 'TM-2', status: 'pending' });
    const groups = backlogStatusGroups([t10, t9, t2], '', 'key');
    const todo = groups.find((g) => g.column === 'todo');
    expect(todo?.tickets.map((t) => t.ticketKey)).toEqual(['TM-2', 'TM-9', 'TM-10']);
  });

  it('lists every non-epic ticket exactly once across all groups', () => {
    const epic = ticket({ issueType: 'epic', status: 'pending' });
    const tickets = [
      epic,
      ticket({ status: 'pending' }),
      ticket({ status: 'in-progress' }),
      ticket({ status: 'in-review' }),
      ticket({ status: 'blocked' }),
      ticket({ status: 'done' }),
    ];
    const groups = backlogStatusGroups(tickets, '', 'key');
    const all = groups.flatMap((g) => g.tickets);
    expect(all).toHaveLength(tickets.length - 1);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  it('drops a ticket whose milestone is archived, and brings it back with includeArchived (F14.6)', () => {
    const archived = ticket({ milestoneId: 'm1', status: 'in-progress' });
    const live = ticket({ milestoneId: 'm2', status: 'in-progress' });
    const index = archiveIndexOf(
      [
        { id: 'm1', archivedAt: 1_000 },
        { id: 'm2', archivedAt: null },
      ],
      [],
      [],
    );

    const hidden = backlogStatusGroups([archived, live], '', 'key', { index }).flatMap(
      (g) => g.tickets,
    );
    expect(hidden.map((t) => t.id)).toEqual([live.id]);

    const shown = backlogStatusGroups([archived, live], '', 'key', {
      index,
      includeArchived: true,
    }).flatMap((g) => g.tickets);
    expect(new Set(shown.map((t) => t.id))).toEqual(new Set([archived.id, live.id]));
  });
});
