import { describe, expect, it } from 'vitest';
import type { Milestone, Task } from '@tm/shared/model';
import { inputToDate } from './ticketFields';
import { ticketSummaryLine } from './ticketSummary';

type SummaryTicket = Pick<Task, 'issueType' | 'milestoneId' | 'storyPoints' | 'dueAt'>;

function ticket(overrides: Partial<SummaryTicket> = {}): SummaryTicket {
  return { issueType: undefined, milestoneId: null, storyPoints: null, dueAt: null, ...overrides };
}

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

const NEW_YEAR_2026 = new Date(2026, 0, 1).getTime();

describe('ticketSummaryLine', () => {
  it('is only the capitalised type when everything else is empty', () => {
    expect(ticketSummaryLine(ticket(), { milestones: [] })).toBe('Task');
    expect(ticketSummaryLine(ticket({ issueType: 'bug' }), { milestones: [] })).toBe('Bug');
  });

  it('drops an unknown milestone id rather than showing it', () => {
    const known = milestone({ id: 'mile1', name: 'Beta' });
    expect(ticketSummaryLine(ticket({ milestoneId: 'nope' }), { milestones: [known] })).toBe(
      'Task',
    );
  });

  it('looks the milestone name up by id when it is known', () => {
    const beta = milestone({ id: 'mile1', name: 'Beta' });
    expect(ticketSummaryLine(ticket({ milestoneId: 'mile1' }), { milestones: [beta] })).toBe(
      'Task · Beta',
    );
  });

  it('reads 1 point as singular and everything else as plural, including zero', () => {
    expect(ticketSummaryLine(ticket({ storyPoints: 1 }), { milestones: [] })).toBe('Task · 1 pt');
    expect(ticketSummaryLine(ticket({ storyPoints: 3 }), { milestones: [] })).toBe('Task · 3 pts');
    expect(ticketSummaryLine(ticket({ storyPoints: 0 }), { milestones: [] })).toBe('Task · 0 pts');
  });

  it('drops the points part for an unestimated ticket', () => {
    expect(ticketSummaryLine(ticket({ storyPoints: null }), { milestones: [] })).toBe('Task');
  });

  it('formats a due date without the year when it is this year', () => {
    const dueAt = new Date(2026, 9, 14).getTime();
    expect(
      ticketSummaryLine(ticket({ dueAt }), {
        milestones: [],
        locale: 'en-GB',
        now: NEW_YEAR_2026,
      }),
    ).toBe('Task · due 14 Oct');
  });

  it('adds the year for a due date that is not the current one', () => {
    const dueAt = new Date(2027, 0, 3).getTime();
    expect(
      ticketSummaryLine(ticket({ dueAt }), {
        milestones: [],
        locale: 'en-GB',
        now: NEW_YEAR_2026,
      }),
    ).toBe('Task · due 3 Jan 2027');
  });

  it("formats a date-input's local midnight as the same calendar day", () => {
    const dueAt = inputToDate('2026-10-14');
    expect(
      ticketSummaryLine(ticket({ dueAt }), {
        milestones: [],
        locale: 'en-GB',
        now: NEW_YEAR_2026,
      }),
    ).toBe('Task · due 14 Oct');
  });

  it('joins every present part with the same separator, dropping empty ones', () => {
    const beta = milestone({ id: 'mile1', name: 'Beta' });
    const dueAt = new Date(2026, 9, 14).getTime();
    expect(
      ticketSummaryLine(
        ticket({ issueType: 'story', milestoneId: 'mile1', storyPoints: 5, dueAt }),
        {
          milestones: [beta],
          locale: 'en-GB',
          now: NEW_YEAR_2026,
        },
      ),
    ).toBe('Story · Beta · 5 pts · due 14 Oct');
  });
});
