/**
 * The two pure answers in `./tracker`. `TrackerMark` itself is one switch over `trackerOf`
 * and is left to the eye; what is worth pinning down is the narrowing (which must refuse a
 * value it does not know rather than guess) and the key spelling (which must shorten GitHub's
 * and leave JIRA's alone).
 */
import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@tm/shared/model';
import { shortTicketKey, ticketChannels, ticketLinkTitle, trackerName, trackerOf } from './tracker';

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
  it('names the trackers there are', () => {
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

describe('ticketChannels', () => {
  it('maps each tracker to its own channel family', () => {
    expect(ticketChannels('jira')).toEqual({
      fetchComments: 'jira:fetchComments',
      markRead: 'jira:markRead',
      addComment: 'jira:addComment',
      searchUsers: 'jira:searchUsers',
    });
    expect(ticketChannels('github')).toEqual({
      fetchComments: 'github:fetchComments',
      markRead: 'github:markRead',
      addComment: 'github:addComment',
      searchUsers: 'github:searchUsers',
    });
  });
});

describe('ticketLinkTitle', () => {
  it('names the key and the tracker it opens in', () => {
    expect(ticketLinkTitle(task({ externalSource: 'jira', externalKey: 'PROJ-123' }))).toBe(
      'Open PROJ-123 in JIRA',
    );
    expect(
      ticketLinkTitle(task({ externalSource: 'github', externalKey: 'octocat/hello-world#123' })),
    ).toBe('Open octocat/hello-world#123 in GitHub');
  });

  it('is null for a card with no external key', () => {
    expect(ticketLinkTitle(task({}))).toBeNull();
    expect(ticketLinkTitle(task({ externalSource: 'github', externalKey: null }))).toBeNull();
  });
});
