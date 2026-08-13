/**
 * `githubAuthorIsMe` decides whether a comment lights a card orange, so every branch of it
 * is a visible bug in one direction or the other: too eager and every pull request you have
 * ever answered stays permanently unread; too shy and a waiting reviewer is silent. The
 * fallback from numeric id to `login` is the interesting part — ids are stable across
 * renames but not every author payload carries one.
 */
import { describe, expect, it } from 'vitest';
import { githubAuthorIsMe, githubIdentityFrom } from './identity';
import type { GitHubUser } from './githubClient';

const me = { id: 9, login: 'wd', baseUrl: 'https://api.github.com' };

describe('githubAuthorIsMe', () => {
  it('matches on the numeric id when both sides carry one', () => {
    expect(githubAuthorIsMe({ id: 9, login: 'someone-else' }, me)).toBe(true);
    expect(githubAuthorIsMe({ id: 10, login: 'wd' }, me)).toBe(false);
  });

  it('falls back to the login when the author has no id', () => {
    expect(githubAuthorIsMe({ login: 'wd' }, me)).toBe(true);
    expect(githubAuthorIsMe({ login: 'WD ' }, me)).toBe(true);
    expect(githubAuthorIsMe({ login: 'other' }, me)).toBe(false);
  });

  it('falls back to the login when OUR id is unknown', () => {
    const noId = { ...me, id: null };
    expect(githubAuthorIsMe({ id: 9, login: 'wd' }, noId)).toBe(true);
    expect(githubAuthorIsMe({ id: 9, login: 'other' }, noId)).toBe(false);
  });

  it('matches nothing when the identity is unknown — the safe direction', () => {
    expect(githubAuthorIsMe({ id: 9, login: 'wd' }, null)).toBe(false);
    expect(githubAuthorIsMe(null, me)).toBe(false);
    expect(githubAuthorIsMe(undefined, me)).toBe(false);
  });

  it('never matches on an empty login, so a blank identity is not everybody', () => {
    const blank = { id: null, login: '  ', baseUrl: 'https://api.github.com' };
    expect(githubAuthorIsMe({ login: '' }, blank)).toBe(false);
    expect(githubAuthorIsMe({}, blank)).toBe(false);
  });
});

describe('githubIdentityFrom', () => {
  it('keys the cache by the instance it came from', () => {
    const user = { id: 9, login: 'wd' } as GitHubUser;
    expect(githubIdentityFrom(user, 'https://github.acme.test')).toEqual({
      id: 9,
      login: 'wd',
      baseUrl: 'https://github.acme.test',
    });
  });

  it('tolerates a server that answers without an id or a login', () => {
    expect(githubIdentityFrom({} as GitHubUser, 'https://api.github.com')).toEqual({
      id: null,
      login: '',
      baseUrl: 'https://api.github.com',
    });
  });
});
