/**
 * The two pure answers in `./tracker`. `TrackerMark` itself is one switch over `trackerOf`
 * and is left to the eye; what is worth pinning down is the narrowing (which must refuse a
 * value it does not know rather than guess) and the key spelling (which must shorten GitHub's
 * and leave JIRA's alone).
 */
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import { shortTicketKey, trackerName, trackerOf } from './tracker';

const task = (over: Partial<Task>): Task => ({
  id: 't',
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: 'x',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

describe('trackerOf', () => {
  it('names the two trackers there are', () => {
    expect(trackerOf(task({ externalSource: 'jira' }))).toBe('jira');
    expect(trackerOf(task({ externalSource: 'github' }))).toBe('github');
  });

  it('reads a card with no tracker, and one naming a tracker it has never heard of, as none', () => {
    expect(trackerOf(task({}))).toBeNull();
    expect(trackerOf(task({ externalSource: null }))).toBeNull();
    // A row written by a newer build. Losing the mark is right; drawing the wrong one is not.
    expect(trackerOf(task({ externalSource: 'gitea' as never }))).toBeNull();
  });
});

describe('trackerName', () => {
  it('spells each tracker the way that tracker spells itself', () => {
    expect(trackerName(task({ externalSource: 'jira' }))).toBe('JIRA');
    expect(trackerName(task({ externalSource: 'github' }))).toBe('GitHub');
    expect(trackerName(task({}))).toBeNull();
  });
});

describe('shortTicketKey', () => {
  it("leaves JIRA's key alone — it is already as short as it gets", () => {
    expect(shortTicketKey(task({ externalSource: 'jira', externalKey: 'PROJ-123' }))).toBe(
      'PROJ-123',
    );
  });

  it("drops GitHub's repository, which is three quarters of the card's width", () => {
    expect(
      shortTicketKey(task({ externalSource: 'github', externalKey: 'octocat/hello-world#123' })),
    ).toBe('#123');
  });

  it('hands back what it was given when there is nothing to shorten', () => {
    expect(shortTicketKey(task({}))).toBeNull();
    expect(shortTicketKey(task({ externalSource: 'github', externalKey: null }))).toBeNull();
    // Not the spelling `githubIssueSync` writes, but a key with no '#' is still a key: it is
    // shown whole rather than blanked.
    expect(shortTicketKey(task({ externalSource: 'github', externalKey: 'octocat/repo' }))).toBe(
      'octocat/repo',
    );
  });
});
