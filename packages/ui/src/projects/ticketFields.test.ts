import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import {
  dateToInput,
  inputToDate,
  parseDays,
  parsePoints,
  splitLabels,
  ticketPatchFor,
} from './ticketFields';

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

describe('parsePoints', () => {
  it('reads a blank field as "not estimated", not zero', () => {
    expect(parsePoints('')).toBeNull();
    expect(parsePoints('   ')).toBeNull();
  });

  it('reads "0" as a real estimate of zero points', () => {
    expect(parsePoints('0')).toBe(0);
  });

  it('parses an ordinary number', () => {
    expect(parsePoints('5')).toBe(5);
  });

  it('reads unparsable text as not estimated', () => {
    expect(parsePoints('abc')).toBeNull();
  });
});

describe('parseDays', () => {
  it('reads a blank field as "not estimated"', () => {
    expect(parseDays('')).toBeNull();
  });

  it('reads "0" as a real estimate of zero days', () => {
    expect(parseDays('0')).toBe(0);
  });

  it('parses a fractional day', () => {
    expect(parseDays('0.5')).toBe(0.5);
  });

  it('reads unparsable text as not estimated', () => {
    expect(parseDays('two')).toBeNull();
  });
});

describe('splitLabels', () => {
  it('goes through normalizeLabels — trims, drops blanks, de-dupes case-blind', () => {
    expect(splitLabels(' backend , backend, BACKEND ,ui, ')).toEqual(['backend', 'ui']);
  });

  it('is empty for a blank field', () => {
    expect(splitLabels('')).toEqual([]);
  });
});

describe('dateToInput / inputToDate', () => {
  it('formats an epoch as the local calendar day', () => {
    const t = new Date(2024, 2, 15, 13, 45, 30).getTime();
    expect(dateToInput(t)).toBe('2024-03-15');
  });

  it('formats a null date as blank, and reads a blank field back as null', () => {
    expect(dateToInput(null)).toBe('');
    expect(inputToDate('')).toBeNull();
  });

  it('round-trips to the LOCAL DAY, not to the original instant', () => {
    // A date input has no time of day, so asserting equality to `t` itself would be the
    // test lying about what the round trip actually preserves.
    const t = new Date(2024, 2, 15, 13, 45, 30).getTime();
    const localDayStart = new Date(2024, 2, 15, 0, 0, 0, 0).getTime();
    expect(inputToDate(dateToInput(t))).toBe(localDayStart);
    expect(inputToDate(dateToInput(t))).not.toBe(t);
  });
});

describe('ticketPatchFor', () => {
  it('returns {} when the field matches the ticket untouched', () => {
    const t = ticket({ storyPoints: 3 });
    expect(ticketPatchFor('storyPointsText', '3', t)).toEqual({});
  });

  it('returns {} for every field left exactly as the ticket already has it', () => {
    const t = ticket({
      issueType: 'story',
      epicTaskId: 'epic1',
      milestoneId: 'mile1',
      labels: ['Backend', 'ui'],
      storyPoints: 3,
      estimateDays: 1.5,
      startAt: new Date(2024, 2, 1).getTime(),
      dueAt: new Date(2024, 2, 10).getTime(),
      assigneeId: 'p1',
      reporterId: 'p2',
    });
    expect(ticketPatchFor('issueType', 'story', t)).toEqual({});
    expect(ticketPatchFor('epicTaskId', 'epic1', t)).toEqual({});
    expect(ticketPatchFor('milestoneId', 'mile1', t)).toEqual({});
    expect(ticketPatchFor('labelsText', 'Backend, ui', t)).toEqual({});
    expect(ticketPatchFor('storyPointsText', '3', t)).toEqual({});
    expect(ticketPatchFor('estimateDaysText', '1.5', t)).toEqual({});
    expect(ticketPatchFor('startAtInput', '2024-03-01', t)).toEqual({});
    expect(ticketPatchFor('dueAtInput', '2024-03-10', t)).toEqual({});
    expect(ticketPatchFor('assigneeId', 'p1', t)).toEqual({});
    expect(ticketPatchFor('reporterId', 'p2', t)).toEqual({});
  });

  it('treats an unestimated ticket left blank as unchanged, not cleared to null again', () => {
    const t = ticket({ storyPoints: null });
    expect(ticketPatchFor('storyPointsText', '', t)).toEqual({});
  });

  it('carries only the field that actually changed', () => {
    const t = ticket({ storyPoints: 3, estimateDays: 1 });
    expect(ticketPatchFor('storyPointsText', '5', t)).toEqual({ storyPoints: 5 });
  });

  it('sends an explicit null for a cleared picker, never undefined', () => {
    const t = ticket({ milestoneId: 'mile1' });
    const patch = ticketPatchFor('milestoneId', '', t);
    expect(patch).toEqual({ milestoneId: null });
    expect('milestoneId' in patch).toBe(true);
  });

  it('sends an explicit null for a cleared epic, assignee or reporter', () => {
    const t = ticket({ epicTaskId: 'epic1', assigneeId: 'p1', reporterId: 'p2' });
    expect(ticketPatchFor('epicTaskId', '', t)).toEqual({ epicTaskId: null });
    expect(ticketPatchFor('assigneeId', '', t)).toEqual({ assigneeId: null });
    expect(ticketPatchFor('reporterId', '', t)).toEqual({ reporterId: null });
  });

  it('sends an explicit null for a cleared date', () => {
    const t = ticket({ startAt: new Date(2024, 2, 1).getTime() });
    expect(ticketPatchFor('startAtInput', '', t)).toEqual({ startAt: null });
  });

  it('detects a label list change regardless of the registry not being consulted', () => {
    const t = ticket({ labels: ['backend'] });
    expect(ticketPatchFor('labelsText', 'backend, ui', t)).toEqual({ labels: ['backend', 'ui'] });
  });

  it('is unchanged when the same labels are retyped with different spacing', () => {
    const t = ticket({ labels: ['backend', 'ui'] });
    expect(ticketPatchFor('labelsText', ' backend , ui ', t)).toEqual({});
  });

  it('is a real change when only the casing differs — normalizeLabels dedupes case-blind but keeps the case it first saw', () => {
    const t = ticket({ labels: ['backend', 'ui'] });
    expect(ticketPatchFor('labelsText', 'Backend, ui', t)).toEqual({ labels: ['Backend', 'ui'] });
  });

  it('reports an issueType change', () => {
    const t = ticket({ issueType: 'task' });
    expect(ticketPatchFor('issueType', 'epic', t)).toEqual({ issueType: 'epic' });
  });

  it('reads a ticket missing issueType as "task", its default', () => {
    const t = ticket({});
    expect(ticketPatchFor('issueType', 'task', t)).toEqual({});
  });

  it('round-trips a date change through the local-day input format', () => {
    const t = ticket({ dueAt: new Date(2024, 2, 1).getTime() });
    expect(ticketPatchFor('dueAtInput', '2024-03-15', t)).toEqual({
      dueAt: new Date(2024, 2, 15).getTime(),
    });
  });
});
