/**
 * The guard's own rules are exercised through `jiraSync.test.ts`, which has driven them since
 * they lived in that file. What is tested HERE is the part that only exists because there are
 * now two trackers: that the sentence names the one it was told about.
 *
 * That is not cosmetic. This warning's whole job is to send someone to go and look at the
 * right thing, and "check the board's JQL" shown to a GitHub user is worse than saying nothing
 * — it sends them to a screen with no JQL on it.
 */
import { describe, expect, it } from 'vitest';
import { guardRemovals, type ForgeRemoval } from './removalGuard';

const many = (n: number): ForgeRemoval[] =>
  Array.from({ length: n }, (_, i) => ({
    taskId: `t-${i + 1}`,
    key: `acme/web#${i + 1}`,
    title: 'Do a thing',
    reason: 'left-query' as const,
  }));

describe('guardRemovals', () => {
  it('names the tracker and its query in the refusal', () => {
    const guarded = guardRemovals(many(12), 30, { tracker: 'GitHub', queryName: 'issue query' });
    expect(guarded.removals).toEqual([]);
    expect(guarded.refused).toHaveLength(12);
    expect(guarded.warning).toContain('GitHub cards that GitHub says');
    expect(guarded.warning).toContain("board's issue query");
    expect(guarded.warning).not.toContain('JIRA');
  });

  it('names no tracker at all rather than guessing at one', () => {
    // A shared module that says "JIRA" when nobody told it which is how a GitHub board comes
    // to be told to check its JQL.
    const guarded = guardRemovals(many(12), 30);
    expect(guarded.warning).not.toContain('JIRA');
    expect(guarded.warning).toContain('the tracker');
  });

  it('is all or nothing — a partial removal is a board no question produced', () => {
    const guarded = guardRemovals(many(12), 30, { tracker: 'GitHub' });
    expect(guarded.removals.length + guarded.refused.length).toBe(12);
    expect(guarded.removals).toEqual([]);
  });
});
