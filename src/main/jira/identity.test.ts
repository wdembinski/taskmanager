import { describe, expect, it } from 'vitest';
import { authorIsMe, identityFrom, type JiraIdentityCache } from './identity';

const cloud: JiraIdentityCache = {
  accountId: '557058:abc',
  displayName: 'Wojciech Dembinski',
  baseUrl: 'https://x.atlassian.net',
};
const server: JiraIdentityCache = {
  accountId: null,
  displayName: 'Wojciech Dembinski',
  baseUrl: 'https://jira.corp',
};

describe('authorIsMe', () => {
  it('matches on accountId when both sides have one', () => {
    expect(authorIsMe({ accountId: '557058:abc', displayName: 'Someone Else' }, cloud)).toBe(true);
    // The id wins over the name: a rename must not lose your own comments.
    expect(authorIsMe({ accountId: 'other', displayName: 'Wojciech Dembinski' }, cloud)).toBe(
      false,
    );
  });

  it('falls back to display name where there is no accountId', () => {
    expect(authorIsMe({ displayName: 'wojciech dembinski' }, server)).toBe(true);
    expect(authorIsMe({ displayName: 'Someone Else' }, server)).toBe(false);
  });

  it('matches nothing when the identity is unknown', () => {
    // Everything then renders as someone else's — never as words you did not write.
    expect(authorIsMe({ displayName: 'Wojciech Dembinski' }, null)).toBe(false);
    expect(authorIsMe(undefined, cloud)).toBe(false);
  });

  it('never matches an empty display name against an empty author', () => {
    const blank: JiraIdentityCache = { accountId: null, displayName: '', baseUrl: 'x' };
    expect(authorIsMe({ displayName: '' }, blank)).toBe(false);
  });
});

describe('identityFrom', () => {
  it('keeps the site it was fetched from, so another instance re-discovers', () => {
    expect(identityFrom({ displayName: 'Me', accountId: 'a1' }, 'https://x')).toEqual({
      accountId: 'a1',
      displayName: 'Me',
      baseUrl: 'https://x',
    });
    expect(identityFrom({ displayName: 'Me' }, 'https://y').accountId).toBeNull();
  });
});
