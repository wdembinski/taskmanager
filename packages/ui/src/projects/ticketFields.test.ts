import { describe, expect, it } from 'vitest';
import type { Task } from '@tm/shared/model';
import {
  dateToInput,
  draftFromTicket,
  inputToDate,
  parseDays,
  parsePoints,
  splitLabels,
  ticketPatchFrom,
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

describe('ticketPatchFrom', () => {
  it('returns {} when the draft matches the ticket untouched — closing the drawer writes nothing', () => {
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
    const draft = draftFromTicket(t);
    expect(ticketPatchFrom(draft, t)).toEqual({});
  });

  it('sends an explicit null for a field the human cleared, never undefined', () => {
    const t = ticket({ milestoneId: 'mile1' });
    const draft = draftFromTicket(t);
    draft.milestoneId = '';
    const patch = ticketPatchFrom(draft, t);
    expect(patch).toEqual({ milestoneId: null });
    expect('milestoneId' in patch).toBe(true);
  });

  it('carries only the field that actually changed', () => {
    const t = ticket({ storyPoints: 3, estimateDays: 1 });
    const draft = draftFromTicket(t);
    draft.storyPointsText = '5';
    expect(ticketPatchFrom(draft, t)).toEqual({ storyPoints: 5 });
  });

  it('treats an unestimated ticket left blank as unchanged, not cleared to null again', () => {
    const t = ticket({ storyPoints: null });
    const draft = draftFromTicket(t);
    expect(ticketPatchFrom(draft, t)).toEqual({});
  });

  it('detects a label list change regardless of the registry not being consulted', () => {
    const t = ticket({ labels: ['backend'] });
    const draft = draftFromTicket(t);
    draft.labelsText = 'backend, ui';
    expect(ticketPatchFrom(draft, t)).toEqual({ labels: ['backend', 'ui'] });
  });
});
