import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from './model';
import {
  ISSUE_TYPES,
  isEpic,
  isIssueType,
  isNativeTicket,
  isTicketLinkType,
  normalizeLabels,
  seedInitials,
  TICKET_LINK_TYPES,
  typeIconKeyFor,
} from './tickets';

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

describe('isIssueType', () => {
  it('accepts every issue type and nothing else', () => {
    for (const type of ISSUE_TYPES) expect(isIssueType(type)).toBe(true);
    expect(isIssueType('feature')).toBe(false);
    expect(isIssueType('')).toBe(false);
    expect(isIssueType('EPIC')).toBe(false);
  });
});

describe('isTicketLinkType', () => {
  it('accepts every link type and nothing else', () => {
    for (const type of TICKET_LINK_TYPES) expect(isTicketLinkType(type)).toBe(true);
    expect(isTicketLinkType('after-merge')).toBe(false);
    expect(isTicketLinkType('')).toBe(false);
  });
});

describe('isNativeTicket', () => {
  it('is true only for a row this app owns', () => {
    expect(isNativeTicket({ source: 'ticket' })).toBe(true);
    expect(isNativeTicket({ source: 'jira' })).toBe(false);
    expect(isNativeTicket({ source: 'adhoc' })).toBe(false);
    expect(isNativeTicket({ source: 'plan' })).toBe(false);
  });
});

describe('isEpic', () => {
  it('is true only for the one issue type that has children', () => {
    expect(isEpic({ issueType: 'epic' })).toBe(true);
    expect(isEpic({ issueType: 'story' })).toBe(false);
    expect(isEpic({ issueType: null })).toBe(false);
    expect(isEpic({})).toBe(false);
  });
});

describe('typeIconKeyFor', () => {
  it("takes a native ticket's own type first", () => {
    expect(typeIconKeyFor(task({ source: 'ticket', issueType: 'epic' }))).toBe('epic');
    expect(typeIconKeyFor(task({ source: 'ticket', issueType: 'subtask' }))).toBe('subtask');
  });

  // A ticket can carry a stale externalType (it was linked to a JIRA issue once) and its
  // own issueType is still the truth.
  it("outranks JIRA's type and the legacy ad-hoc one", () => {
    const t = task({
      source: 'ticket',
      issueType: 'story',
      externalSource: 'jira',
      externalType: 'Bug',
      type: 'feature',
    });
    expect(typeIconKeyFor(t)).toBe('story');
  });

  it('matches a JIRA type loosely, most specific reading first', () => {
    const jira = (externalType: string): string =>
      typeIconKeyFor(task({ source: 'jira', externalSource: 'jira', externalType }));
    // "Sub-task" contains "task"; the narrower reading has to win.
    expect(jira('Sub-task')).toBe('subtask');
    expect(jira('Task')).toBe('task');
    expect(jira('Bug')).toBe('bug');
    expect(jira('Defect')).toBe('bug');
    expect(jira('Epic')).toBe('epic');
    expect(jira('Technical Story')).toBe('story');
    expect(jira('New Feature')).toBe('feature');
    expect(jira('Improvement')).toBe('feature');
    expect(jira('Spike')).toBe('note');
    expect(jira('')).toBe('note');
  });

  // GitHub writes exactly two type names — the labels every new repository is created with —
  // and `Enhancement` is the one JIRA's vocabulary does not already cover. It used to fall
  // through every arm and land on a neutral note, so every GitHub feature request on the board
  // wore the same glyph as a card nobody had typed at all.
  it("reads GitHub's two label-derived types", () => {
    const github = (externalType: string): string =>
      typeIconKeyFor(task({ source: 'github', externalSource: 'github', externalType }));
    expect(github('Bug')).toBe('bug');
    expect(github('Enhancement')).toBe('feature');
    // Nothing else is claimed: the sync writes null for a repo's own taxonomy rather than
    // guessing, and a null type is a note.
    expect(github('')).toBe('note');
  });

  it('falls back to the legacy ad-hoc type, then to a neutral note', () => {
    expect(typeIconKeyFor(task({ type: 'bug' }))).toBe('bug');
    expect(typeIconKeyFor(task({ type: 'feature' }))).toBe('feature');
    expect(typeIconKeyFor(task({}))).toBe('note');
  });

  // The JIRA branch is entered on `externalSource`, not on the type string, so an ad-hoc
  // card that somehow carries a type name is still read as an ad-hoc card.
  it('reads JIRA types only for a JIRA-sourced row', () => {
    expect(typeIconKeyFor(task({ externalType: 'Epic', type: 'bug' }))).toBe('bug');
  });

  it('degrades an issueType it does not know to the next owner', () => {
    const t = task({ source: 'ticket', issueType: 'chore' as never, type: 'bug' });
    expect(typeIconKeyFor(t)).toBe('bug');
  });
});

describe('normalizeLabels', () => {
  it('trims, drops blanks and preserves the order they were added in', () => {
    expect(normalizeLabels([' backend ', '', '  ', 'ui'])).toEqual(['backend', 'ui']);
  });

  it('de-duplicates case-blind, keeping the first spelling seen', () => {
    expect(normalizeLabels(['Backend', 'backend', 'BACKEND'])).toEqual(['Backend']);
  });

  it('reads a missing list as none', () => {
    expect(normalizeLabels(undefined)).toEqual([]);
    expect(normalizeLabels([])).toEqual([]);
  });
});

describe('seedInitials', () => {
  it('takes the first and last words initials', () => {
    expect(seedInitials('Anna Kowalska')).toBe('AK');
    expect(seedInitials('Jan Maria Rokita')).toBe('JR');
  });

  it('takes two letters from a single word', () => {
    expect(seedInitials('prometheus')).toBe('PR');
    expect(seedInitials('x')).toBe('X');
  });

  it('has nothing to seed from an empty name', () => {
    expect(seedInitials('   ')).toBe('');
  });
});
