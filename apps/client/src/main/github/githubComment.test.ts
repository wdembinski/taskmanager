import { describe, expect, it } from 'vitest';
import { buildCommentBody } from './githubComment';

describe('buildCommentBody', () => {
  it('is the identity when nobody was mentioned', () => {
    expect(buildCommentBody('ship it\n\n- [ ] and a list')).toBe('ship it\n\n- [ ] and a list');
  });

  it('leaves markdown alone — the body IS the wire format', () => {
    const md = '## Heading\n\n```ts\nconst a = 1;\n```\n\n> quoted';
    expect(buildCommentBody(md, [])).toBe(md);
  });

  it('spells a mention the way GitHub resolves one, whatever the label said', () => {
    // The composer typed the person's display name; the pick carries the login.
    const text = 'thanks @Ada Lovelace, merging';
    const body = buildCommentBody(text, [{ start: 7, end: 20, login: 'ada' }]);
    expect(body).toBe('thanks @ada, merging');
  });

  it('rewrites an already-correct mention to the same string', () => {
    const text = 'over to you @octocat';
    expect(buildCommentBody(text, [{ start: 12, end: 20, login: 'octocat' }])).toBe(text);
  });

  it('leaves an unresolved mention as the plain text it already is', () => {
    const text = 'ping @somebody';
    expect(buildCommentBody(text, [{ start: 5, end: 14, login: null }])).toBe(text);
  });

  it('handles several mentions, and keeps the text between them', () => {
    const text = '@A and @B, see this';
    const body = buildCommentBody(text, [
      { start: 0, end: 2, login: 'alice' },
      { start: 7, end: 9, login: 'bob' },
    ]);
    expect(body).toBe('@alice and @bob, see this');
  });

  it('drops ranges that no longer fit the text rather than slicing at random', () => {
    // A mention left dangling past a trimmed tail — the same hazard `buildAdf` guards.
    const text = 'short';
    expect(buildCommentBody(text, [{ start: 3, end: 40, login: 'ada' }])).toBe('short');
    expect(buildCommentBody(text, [{ start: -2, end: 2, login: 'ada' }])).toBe('short');
  });

  it('drops a mention that overlaps one it already took', () => {
    const text = '@ada rules';
    const body = buildCommentBody(text, [
      { start: 0, end: 4, login: 'ada' },
      { start: 2, end: 6, login: 'bob' },
    ]);
    expect(body).toBe('@ada rules');
  });
});
