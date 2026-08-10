import { describe, expect, it } from 'vitest';
import { isReviewishStatus, resolveStatusColumn } from './statusResolve';

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
