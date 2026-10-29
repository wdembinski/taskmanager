import { describe, expect, it } from 'vitest';
import {
  columnFromLabelName,
  firstUnmappedLabel,
  isBlockedishStatus,
  isReviewishStatus,
  resolveGitHubColumn,
  resolveStatusColumn,
} from './statusResolve';

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

describe('resolveGitHubColumn', () => {
  const MAP = { 'In Review': 'in-review', blocked: 'blocked' } as const;

  it('reads an open issue with no mapped label as TO DO', () => {
    expect(resolveGitHubColumn([], 'open')).toEqual({
      column: 'todo',
      reason: 'category',
      label: null,
    });
    expect(resolveGitHubColumn(['good first issue'], 'open', MAP)).toEqual({
      column: 'todo',
      reason: 'category',
      label: null,
    });
  });

  it('lets the user map a label onto a column no GitHub issue could otherwise reach', () => {
    expect(resolveGitHubColumn(['in review'], 'open', MAP)).toEqual({
      column: 'in-review',
      reason: 'explicit',
      label: 'in review',
    });
  });

  it('takes the learned map only when the user said nothing', () => {
    expect(resolveGitHubColumn(['wip'], 'open', MAP, { wip: 'in-progress' })).toEqual({
      column: 'in-progress',
      reason: 'learned',
      label: 'wip',
    });
    // The user's map beats it, on the same issue, whichever order the labels come in.
    expect(resolveGitHubColumn(['wip', 'in review'], 'open', MAP, { wip: 'in-progress' })).toEqual({
      column: 'in-review',
      reason: 'explicit',
      label: 'in review',
    });
  });

  /**
   * The one place this departs from the JIRA resolver's precedence, and the reported failure
   * it exists to prevent: nothing removes a label when you close an issue, so a stale
   * `in review` outranking the close would leave a finished card in IN REVIEW forever and
   * undo a drag into DONE on the very next poll.
   */
  it('lets CLOSED beat every label, mapped or learned', () => {
    expect(resolveGitHubColumn(['in review'], 'closed', MAP)).toEqual({
      column: 'done',
      reason: 'category',
      label: null,
    });
    expect(resolveGitHubColumn(['wip'], 'closed', MAP, { wip: 'in-progress' })).toEqual({
      column: 'done',
      reason: 'category',
      label: null,
    });
  });

  it('reads a state it has never heard of as closed, not as open', () => {
    // The safe direction: a finished issue parked in TO DO hides work, the other way round
    // only shows it. GitHub has two states; a third would be something new.
    expect(resolveGitHubColumn([], 'archived').column).toBe('done');
  });

  it('matches labels ignoring case, like every other map here', () => {
    expect(resolveGitHubColumn(['IN REVIEW'], 'open', MAP).column).toBe('in-review');
  });

  // The JIRA refusal, one forge over: the learned map is written by a drag that "succeeded",
  // so a picker that reached for the wrong label would otherwise be believed for ever.
  it('ignores a learned entry that speaks for a label named blocked', () => {
    expect(resolveGitHubColumn(['blocked'], 'open', undefined, { blocked: 'in-progress' })).toEqual(
      { column: 'todo', reason: 'category', label: null },
    );
    // The human's own map is never refused.
    expect(
      resolveGitHubColumn(['blocked'], 'open', { blocked: 'in-progress' }, { blocked: 'todo' }),
    ).toEqual({ column: 'in-progress', reason: 'explicit', label: 'blocked' });
  });

  it('never guesses from a label NAME — that tier belongs to the move, not the poll', () => {
    // A poll that moved cards on a guess would rearrange a board nobody touched.
    expect(resolveGitHubColumn(['in progress', 'needs review'], 'open').column).toBe('todo');
  });
});

describe('columnFromLabelName', () => {
  it('reads the three columns an issue state cannot express', () => {
    expect(columnFromLabelName('in progress')).toBe('in-progress');
    expect(columnFromLabelName('needs review')).toBe('in-review');
    expect(columnFromLabelName('blocked')).toBe('blocked');
  });

  it('reads the spellings the same idea actually gets in a repository', () => {
    expect(columnFromLabelName('Status: In-Progress')).toBe('in-progress');
    expect(columnFromLabelName('status/WIP')).toBe('in-progress');
    expect(columnFromLabelName('  In_Review  ')).toBe('in-review');
    expect(columnFromLabelName('on-hold')).toBe('blocked');
  });

  it('lets review beat blocked, exactly as isBlockedishStatus does', () => {
    expect(columnFromLabelName('waiting for review')).toBe('in-review');
  });

  it('says nothing about a label that is about something else', () => {
    expect(columnFromLabelName('bug')).toBeNull();
    expect(columnFromLabelName('good first issue')).toBeNull();
    expect(columnFromLabelName('done')).toBeNull(); // said by closing, never by a label
    expect(columnFromLabelName('   ')).toBeNull();
  });
});

describe('firstUnmappedLabel', () => {
  it('skips the labels already spending themselves on the column', () => {
    const map = { 'in review': 'in-review' } as const;
    expect(firstUnmappedLabel(['in review', 'backend'], map)).toBe('backend');
    expect(firstUnmappedLabel(['backend', 'in review'], map)).toBe('backend');
  });

  it('skips a learned label too, and answers null when nothing is left', () => {
    expect(firstUnmappedLabel(['wip'], undefined, { wip: 'in-progress' })).toBeNull();
    expect(firstUnmappedLabel([])).toBeNull();
  });
});
