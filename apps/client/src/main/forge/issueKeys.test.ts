import { describe, expect, it } from 'vitest';
import { discoverIssueKeys, pickTaskKey } from './issueKeys';

const BOARD = ['ENG-431', 'ENG-9', 'OPS-12'];

describe('discoverIssueKeys', () => {
  it('finds the key in a branch name', () => {
    expect(discoverIssueKeys({ sourceBranch: 'feature/ENG-431-fix-login' }, BOARD)).toEqual([
      'ENG-431',
    ]);
  });

  it('finds it in the title and the description too', () => {
    expect(discoverIssueKeys({ title: 'ENG-431: fix login' }, BOARD)).toEqual(['ENG-431']);
    expect(discoverIssueKeys({ description: 'Closes ENG-9.' }, BOARD)).toEqual(['ENG-9']);
  });

  it('matches case-insensitively and returns the board’s own spelling', () => {
    expect(discoverIssueKeys({ sourceBranch: 'eng-431-fix' }, BOARD)).toEqual(['ENG-431']);
  });

  it('normalises an underscore, which branch slugs love', () => {
    expect(discoverIssueKeys({ sourceBranch: 'wd/eng_431_login' }, BOARD)).toEqual(['ENG-431']);
  });

  it('rejects key-shaped noise that no board card carries', () => {
    // The whole reason for intersecting with the board.
    const noisy = {
      title: 'Move to UTF-8 and ISO-8601, per RFC-2119, dropping IE-11',
      sourceBranch: 'chore/utf-8',
    };
    expect(discoverIssueKeys(noisy, BOARD)).toEqual([]);
  });

  it('prefers the branch’s key over the title’s when they disagree', () => {
    const mr = { sourceBranch: 'feature/OPS-12-runbook', title: 'ENG-431 follow-up' };
    expect(discoverIssueKeys(mr, BOARD)).toEqual(['OPS-12', 'ENG-431']);
  });

  it('de-duplicates a key named in several places', () => {
    const mr = {
      sourceBranch: 'feature/ENG-431',
      title: 'ENG-431: fix',
      description: 'part of ENG-431',
    };
    expect(discoverIssueKeys(mr, BOARD)).toEqual(['ENG-431']);
  });

  it('finds nothing when the board is empty or the MR names no key', () => {
    expect(discoverIssueKeys({ title: 'ENG-431' }, [])).toEqual([]);
    expect(discoverIssueKeys({ title: 'tidy up', sourceBranch: 'chore/tidy' }, BOARD)).toEqual([]);
    expect(discoverIssueKeys({}, BOARD)).toEqual([]);
  });

  it('does not match a key glued to other characters', () => {
    expect(discoverIssueKeys({ title: 'xENG-431x' }, BOARD)).toEqual([]);
  });
});

describe('pickTaskKey', () => {
  it('files the MR under the first key — the branch’s, by the ordering above', () => {
    expect(pickTaskKey(['OPS-12', 'ENG-431'])).toBe('OPS-12');
  });

  it('is null when nothing was found', () => {
    expect(pickTaskKey([])).toBeNull();
  });
});
