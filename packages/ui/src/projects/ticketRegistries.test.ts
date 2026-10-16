import { describe, expect, it } from 'vitest';
import type { Milestone, TicketLabel } from '@tm/shared/model';
import { offeredMilestones, scopeTicketRegistries } from './ticketRegistries';

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
    createdAt: 0,
    ...overrides,
  };
}
function label(overrides: Partial<TicketLabel> = {}): TicketLabel {
  seq += 1;
  return { id: `l${seq}`, projectId: 'p1', name: 'Label', color: '', createdAt: 0, ...overrides };
}

describe('scopeTicketRegistries', () => {
  it('returns empty lists for a null project', () => {
    expect(scopeTicketRegistries(null, [milestone()], [label()])).toEqual({
      milestones: [],
      labels: [],
    });
  });

  it('narrows milestones and labels to the given project', () => {
    const mine = milestone({ projectId: 'p1' });
    const other = milestone({ projectId: 'p2' });
    const mineLabel = label({ projectId: 'p1' });
    const otherLabel = label({ projectId: 'p2' });
    expect(scopeTicketRegistries('p1', [mine, other], [mineLabel, otherLabel])).toEqual({
      milestones: [mine],
      labels: [mineLabel],
    });
  });

  it('keeps closed milestones in — only the picker drops them', () => {
    const closed = milestone({ projectId: 'p1', closed: true });
    expect(scopeTicketRegistries('p1', [closed], [])).toEqual({ milestones: [closed], labels: [] });
  });
});

describe('offeredMilestones', () => {
  it('offers only open milestones with no current id', () => {
    const open = milestone({ closed: false });
    const closed = milestone({ closed: true });
    expect(offeredMilestones([open, closed])).toEqual([open]);
  });

  it('also offers the current milestone even when closed', () => {
    const open = milestone({ closed: false });
    const closed = milestone({ closed: true });
    expect(offeredMilestones([open, closed], closed.id)).toEqual([open, closed]);
  });

  it('does not resurrect a different closed milestone', () => {
    const current = milestone({ closed: true });
    const other = milestone({ closed: true });
    expect(offeredMilestones([current, other], current.id)).toEqual([current]);
  });
});
