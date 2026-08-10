import { describe, expect, it } from 'vitest';
import { isBlockedishStatus, isReviewishStatus, resolveStatusColumn } from './statusResolve';

describe('isReviewishStatus', () => {
  it('recognises review statuses in the indeterminate middle', () => {
    expect(isReviewishStatus('In Review', 'In Progress')).toBe(true);
    expect(isReviewishStatus('Code Review', 'In Progress')).toBe(true);
    expect(isReviewishStatus('review', 'In Progress')).toBe(true);
    expect(isReviewishStatus('Peer Reviewing', 'In Progress')).toBe(true);
  });

  it('ignores review-shaped names outside it', () => {
    // Nobody has picked this up yet — it belongs in TO DO, not IN REVIEW.
    expect(isReviewishStatus('Ready for review', 'To Do')).toBe(false);
    // And a finished one is finished.
    expect(isReviewishStatus('Reviewed', 'Done')).toBe(false);
  });

  it('is false for ordinary in-progress statuses', () => {
    expect(isReviewishStatus('In Progress', 'In Progress')).toBe(false);
    expect(isReviewishStatus('Development', 'In Progress')).toBe(false);
  });
});

describe('isBlockedishStatus', () => {
  it('recognises the names a workflow gives "this is stuck"', () => {
    expect(isBlockedishStatus('Blocked', 'In Progress')).toBe(true);
    expect(isBlockedishStatus('On Hold', 'In Progress')).toBe(true);
    expect(isBlockedishStatus('Impediment', 'In Progress')).toBe(true);
    expect(isBlockedishStatus('Waiting for customer', 'In Progress')).toBe(true);
    expect(isBlockedishStatus('Paused', 'In Progress')).toBe(true);
  });

  it('is NOT gated to the indeterminate category — that is the To Do half of the bug', () => {
    // Plenty of schemes file "Blocked" under To Do. A card dropped into IN PROGRESS
    // transitioned the issue there and then snapped back to TO DO on the next sync.
    expect(isBlockedishStatus('Blocked', 'To Do')).toBe(true);
    expect(isBlockedishStatus('On Hold', 'To Do')).toBe(true);
  });

  it('lets review win — those transitions belong to IN REVIEW', () => {
    expect(isBlockedishStatus('Waiting for review', 'In Progress')).toBe(false);
    expect(isBlockedishStatus('Pending review', 'In Progress')).toBe(false);
  });

  it('does not match the name that means the opposite', () => {
    expect(isBlockedishStatus('Unblocked', 'In Progress')).toBe(false);
  });

  it('is false for ordinary statuses', () => {
    expect(isBlockedishStatus('In Progress', 'In Progress')).toBe(false);
    expect(isBlockedishStatus('Backlog', 'To Do')).toBe(false);
  });

  it('is false once the ticket is resolved, whatever it is called', () => {
    expect(isBlockedishStatus('Blocked', 'Done')).toBe(false);
    expect(isBlockedishStatus('Cancelled — blocked', 'Done')).toBe(false);
  });
});

describe('resolveStatusColumn', () => {
  it('takes the user map first and says so', () => {
    expect(
      resolveStatusColumn('Code Review', 'In Progress', { 'Code Review': 'in-review' }),
    ).toEqual({ column: 'in-review', reason: 'explicit' });
  });

  it('lets the user map override the category outright', () => {
    expect(resolveStatusColumn('Backlog', 'In Progress', { Backlog: 'todo' })).toEqual({
      column: 'todo',
      reason: 'explicit',
    });
  });

  it('matches both maps ignoring case and surrounding space', () => {
    expect(
      resolveStatusColumn('  code review  ', 'In Progress', { 'Code Review': 'done' }),
    ).toEqual({ column: 'done', reason: 'explicit' });
    expect(resolveStatusColumn('QA', 'In Progress', undefined, { '  qa  ': 'in-review' })).toEqual({
      column: 'in-review',
      reason: 'learned',
    });
  });

  it('falls to the learned map when the user has not spoken', () => {
    expect(
      resolveStatusColumn('QA Check', 'In Progress', undefined, { 'QA Check': 'in-review' }),
    ).toEqual({ column: 'in-review', reason: 'learned' });
  });

  it('lets an explicit entry beat a learned one for the same status', () => {
    expect(
      resolveStatusColumn(
        'QA Check',
        'In Progress',
        { 'QA Check': 'in-progress' },
        { 'QA Check': 'in-review' },
      ),
    ).toEqual({ column: 'in-progress', reason: 'explicit' });
  });

  // The regression this whole module exists for: with no configuration at all, a
  // review status used to resolve by category to IN PROGRESS, which is what snapped a
  // freshly-dragged card back on the next sync.
  it('reaches In Review by name with no map configured', () => {
    expect(resolveStatusColumn('In Review', 'In Progress')).toEqual({
      column: 'in-review',
      reason: 'heuristic',
    });
    expect(resolveStatusColumn('Code Review', 'In Progress')).toEqual({
      column: 'in-review',
      reason: 'heuristic',
    });
  });

  it('does not let the heuristic reach outside the indeterminate category', () => {
    expect(resolveStatusColumn('Ready for review', 'To Do')).toEqual({
      column: 'todo',
      reason: 'category',
    });
    expect(resolveStatusColumn('Reviewed', 'Done')).toEqual({ column: 'done', reason: 'category' });
  });

  // The second half of the same bug: BLOCKED was a column no JIRA status could reach, so
  // a workflow's "Blocked" landed wherever its category pointed — IN PROGRESS or TO DO.
  it('reaches Blocked by name with no map configured', () => {
    expect(resolveStatusColumn('Blocked', 'In Progress')).toEqual({
      column: 'blocked',
      reason: 'heuristic',
    });
    expect(resolveStatusColumn('On Hold', 'To Do')).toEqual({
      column: 'blocked',
      reason: 'heuristic',
    });
  });

  it('lets the review heuristic keep the statuses it already claimed', () => {
    expect(resolveStatusColumn('Waiting for review', 'In Progress')).toEqual({
      column: 'in-review',
      reason: 'heuristic',
    });
  });

  it('still lets the user map a blocked-ish status wherever they say', () => {
    expect(resolveStatusColumn('Blocked', 'In Progress', { Blocked: 'in-progress' })).toEqual({
      column: 'in-progress',
      reason: 'explicit',
    });
  });

  // Every installation that hit the bug is carrying this entry: a drag "succeeded" into
  // Blocked and the app remembered the wrong meaning on the authority of that drag. The
  // learned tier refuses to speak for a blocked-ish name rather than the map being migrated.
  it('ignores a learned entry that speaks for a blocked-ish name', () => {
    expect(
      resolveStatusColumn('Blocked', 'In Progress', undefined, { Blocked: 'in-review' }),
    ).toEqual({ column: 'blocked', reason: 'heuristic' });
    expect(resolveStatusColumn('Blocked', 'To Do', undefined, { Blocked: 'in-progress' })).toEqual({
      column: 'blocked',
      reason: 'heuristic',
    });
  });

  it('falls back to the category for everything else', () => {
    expect(resolveStatusColumn('In Progress', 'In Progress')).toEqual({
      column: 'in-progress',
      reason: 'category',
    });
    expect(resolveStatusColumn('Backlog', 'To Do')).toEqual({ column: 'todo', reason: 'category' });
    expect(resolveStatusColumn('Closed', 'Done')).toEqual({ column: 'done', reason: 'category' });
  });

  it('ignores an empty or blank status name', () => {
    expect(resolveStatusColumn('   ', 'In Progress', { '   ': 'done' })).toEqual({
      column: 'in-progress',
      reason: 'category',
    });
  });
});
