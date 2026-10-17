import { describe, expect, it } from 'vitest';
import type { Milestone, Task } from '@tm/shared/model';
import { ARCHIVE_SAMPLE_KEYS, archiveDialogModel, archiveDialogTitle } from './archiveDialog';

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
    archivedAt: null,
    createdAt: 0,
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

describe('archiveDialogModel', () => {
  it('needs no dialog when the milestone has no open tickets', () => {
    const m = milestone();
    const model = archiveDialogModel(m, [], []);
    expect(model.needsDialog).toBe(false);
    expect(model.openCount).toBe(0);
    expect(model.sampleKeys).toEqual([]);
    expect(model.moreCount).toBe(0);
    expect(model.archiveTooKeys).toEqual([]);
  });

  it('does not count done or cancelled tickets on the milestone', () => {
    const m = milestone();
    const done = ticket({ milestoneId: m.id, status: 'done' });
    const cancelled = ticket({ milestoneId: m.id, status: 'cancelled' });
    const model = archiveDialogModel(m, [done, cancelled], []);
    expect(model.needsDialog).toBe(false);
    expect(model.openCount).toBe(0);
  });

  it('does not count open tickets on a different milestone', () => {
    const m = milestone();
    const other = milestone();
    const elsewhere = ticket({ milestoneId: other.id, status: 'pending' });
    const model = archiveDialogModel(m, [elsewhere], []);
    expect(model.needsDialog).toBe(false);
    expect(model.openCount).toBe(0);
  });

  it('needs a dialog when open tickets exist, and lists their keys', () => {
    const m = milestone();
    const t1 = ticket({ milestoneId: m.id, status: 'pending', ticketKey: 'TM-1' });
    const t2 = ticket({ milestoneId: m.id, status: 'in-progress', ticketKey: 'TM-2' });
    const model = archiveDialogModel(m, [t1, t2], []);
    expect(model.needsDialog).toBe(true);
    expect(model.openCount).toBe(2);
    expect(model.sampleKeys).toEqual(['TM-1', 'TM-2']);
    expect(model.archiveTooKeys).toEqual(['TM-1', 'TM-2']);
    expect(model.moreCount).toBe(0);
  });

  it('falls back to the title when a ticket has no key', () => {
    const m = milestone();
    const t = ticket({ milestoneId: m.id, status: 'pending', ticketKey: null, title: 'Fix it' });
    const model = archiveDialogModel(m, [t], []);
    expect(model.sampleKeys).toEqual(['Fix it']);
  });

  it('caps sampleKeys at ARCHIVE_SAMPLE_KEYS and reports the rest in moreCount', () => {
    const m = milestone();
    const open = Array.from({ length: 7 }, (_, i) =>
      ticket({ milestoneId: m.id, status: 'pending', ticketKey: `TM-${i + 1}` }),
    );
    const model = archiveDialogModel(m, open, []);
    expect(model.openCount).toBe(7);
    expect(model.sampleKeys).toHaveLength(ARCHIVE_SAMPLE_KEYS);
    expect(model.sampleKeys).toEqual(['TM-1', 'TM-2', 'TM-3', 'TM-4', 'TM-5']);
    expect(model.moreCount).toBe(2);
    expect(model.archiveTooKeys).toHaveLength(7);
  });

  it('excludes the milestone itself, archived milestones, closed milestones and other projects from targets', () => {
    const m = milestone({ projectId: 'p1' });
    const closed = milestone({ projectId: 'p1', closed: true });
    const archived = milestone({ projectId: 'p1', archivedAt: 123 });
    const otherProject = milestone({ projectId: 'p2' });
    const eligible = milestone({ projectId: 'p1' });
    const model = archiveDialogModel(m, [], [m, closed, archived, otherProject, eligible]);
    expect(model.targets).toEqual([eligible]);
  });

  it('keeps target input order', () => {
    const m = milestone({ projectId: 'p1' });
    const b = milestone({ projectId: 'p1' });
    const a = milestone({ projectId: 'p1' });
    const model = archiveDialogModel(m, [], [b, a]);
    expect(model.targets).toEqual([b, a]);
  });
});

describe('archiveDialogTitle', () => {
  it('pluralises open tickets', () => {
    const m = milestone({ name: 'M2 · Review' });
    const t1 = ticket({ milestoneId: m.id, status: 'pending' });
    const t2 = ticket({ milestoneId: m.id, status: 'pending' });
    const t3 = ticket({ milestoneId: m.id, status: 'pending' });
    const t4 = ticket({ milestoneId: m.id, status: 'pending' });
    const model = archiveDialogModel(m, [t1, t2, t3, t4], []);
    expect(archiveDialogTitle(m, model)).toBe('M2 · Review has 4 open tickets');
  });

  it('keeps the noun singular for exactly one', () => {
    const m = milestone({ name: 'M2 · Review' });
    const t1 = ticket({ milestoneId: m.id, status: 'pending' });
    const model = archiveDialogModel(m, [t1], []);
    expect(archiveDialogTitle(m, model)).toBe('M2 · Review has 1 open ticket');
  });
});
