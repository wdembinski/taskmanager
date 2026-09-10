import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import {
  NO_EPIC_GROUP,
  backlogRows,
  filterTickets,
  groupTickets,
  sortBacklog,
} from './backlogView';

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

describe('filterTickets', () => {
  it('matches the title, case-blind', () => {
    const match = ticket({ title: 'Fix the Login Flow' });
    const other = ticket({ title: 'Unrelated' });
    expect(filterTickets([match, other], 'login flow')).toEqual([match]);
  });

  it('matches the ticket key, case-blind', () => {
    const match = ticket({ ticketKey: 'TM-42' });
    const other = ticket({ ticketKey: 'TM-7' });
    expect(filterTickets([match, other], 'tm-42')).toEqual([match]);
  });

  it('matches a label, case-blind', () => {
    const match = ticket({ labels: ['Backend'] });
    const other = ticket({ labels: ['Frontend'] });
    expect(filterTickets([match, other], 'backend')).toEqual([match]);
  });

  it('returns the very same array for a blank query, so a no-op keystroke forces no re-render', () => {
    const tickets = [ticket()];
    expect(filterTickets(tickets, '')).toBe(tickets);
    expect(filterTickets(tickets, '   ')).toBe(tickets);
  });
});

describe('groupTickets', () => {
  it('never drops a non-epic ticket, whatever the grouping', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const tickets = [
      epic,
      ticket({ epicTaskId: 'e1' }),
      ticket({ epicTaskId: 'e1' }),
      ticket({ epicTaskId: null }),
      ticket({ epicTaskId: 'missing-epic' }),
    ];
    const groups = groupTickets(tickets);
    const total = groups.reduce((sum, g) => sum + g.tickets.length, 0);
    // The epic itself only ever heads a group — it is never one of the counted rows.
    expect(total).toBe(tickets.length - 1);
  });

  it('collects every orphan into one "No epic" group instead of vanishing', () => {
    const tickets = [
      ticket({ epicTaskId: null }),
      ticket({ epicTaskId: 'missing-epic' }),
      ticket({ epicTaskId: undefined }),
    ];
    const groups = groupTickets(tickets);
    expect(groups).toHaveLength(1);
    expect(groups[0].epicId).toBeNull();
    expect(groups[0].epicTitle).toBe(NO_EPIC_GROUP);
    expect(groups[0].tickets).toHaveLength(3);
  });

  it('buckets a ticket under its own epic', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const child = ticket({ epicTaskId: 'e1' });
    const groups = groupTickets([epic, child]);
    const epicGroup = groups.find((g) => g.epicId === 'e1');
    expect(epicGroup?.epicTitle).toBe('Epic one');
    expect(epicGroup?.tickets).toEqual([child]);
  });

  it('never lists an epic as a row of its own group — only ever as its header', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const child = ticket({ epicTaskId: 'e1' });
    const groups = groupTickets([epic, child]);
    for (const group of groups) {
      expect(group.tickets).not.toContain(epic);
    }
  });

  it('never lists an epic in NO_EPIC_GROUP, even though its own epicTaskId is null', () => {
    // Regression: an epic's own `epicTaskId` is null, exactly like a true orphan's, so
    // without a carve-out the epic fell into "No epic" alongside `orphan` — and rendered
    // twice, once as the header its child promoted it to and once as this ordinary row.
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const child = ticket({ epicTaskId: 'e1' });
    const orphan = ticket({ epicTaskId: null });
    const groups = groupTickets([epic, child, orphan]);
    const noEpicGroup = groups.find((g) => g.epicId === null);
    expect(noEpicGroup?.tickets).toEqual([orphan]);
  });

  it('still headers a childless epic as an empty group instead of vanishing', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const groups = groupTickets([epic]);
    const epicGroup = groups.find((g) => g.epicId === 'e1');
    expect(epicGroup?.epicTitle).toBe('Epic one');
    expect(epicGroup?.tickets).toEqual([]);
  });
});

describe('sortBacklog', () => {
  it('sorts by key numerically, not lexicographically — TM-9 before TM-10', () => {
    const t9 = ticket({ ticketKey: 'TM-9' });
    const t10 = ticket({ ticketKey: 'TM-10' });
    const t2 = ticket({ ticketKey: 'TM-2' });
    const sorted = sortBacklog([t10, t9, t2], 'key');
    expect(sorted.map((t) => t.ticketKey)).toEqual(['TM-2', 'TM-9', 'TM-10']);
  });

  it('sorts undated tickets last, regardless of direction', () => {
    const dated = ticket({ dueAt: 1000 });
    const undated = ticket({ dueAt: null });
    const earlier = ticket({ dueAt: 500 });
    const sorted = sortBacklog([dated, undated, earlier], 'due');
    expect(sorted).toEqual([earlier, dated, undated]);
  });
});

describe('backlogRows', () => {
  it('filters, sorts and groups together without dropping a ticket', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic one' });
    const tickets = [
      epic,
      ticket({ ticketKey: 'TM-10', epicTaskId: 'e1' }),
      ticket({ ticketKey: 'TM-2', epicTaskId: 'e1' }),
      ticket({ ticketKey: 'TM-3', epicTaskId: null }),
    ];
    const rows = backlogRows(tickets, '', 'key');
    const total = rows.reduce((sum, g) => sum + g.tickets.length, 0);
    // The epic itself only ever heads a group — it is never one of the counted rows.
    expect(total).toBe(tickets.length - 1);
    const epicGroup = rows.find((g) => g.epicId === 'e1');
    expect(epicGroup?.tickets.map((t) => t.ticketKey)).toEqual(['TM-2', 'TM-10']);
  });
});
