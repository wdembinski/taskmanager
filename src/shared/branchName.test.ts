import { describe, expect, it } from 'vitest';
import {
  buildBranchName,
  dedupeBranchName,
  inferBranchType,
  slugify,
  validateBranchName,
} from './branchName';

describe('inferBranchType', () => {
  it.each([
    ['Bug', 'fix'],
    ['Defect', 'fix'],
    ['Incident', 'fix'],
    ['Hotfix', 'fix'],
    ['Story', 'feat'],
    ['New Feature', 'feat'],
    ['Epic', 'feat'],
  ] as const)('lets the JIRA issue type %s decide (%s)', (issueType, expected) => {
    // A human already classified the work in the tracker; that beats guessing from prose.
    expect(inferBranchType('some vague title', issueType)).toBe(expected);
  });

  it.each(['Task', 'Sub-task', 'Improvement', 'Change', ''])(
    'falls through to the title when the issue type (%s) says nothing about the KIND of work',
    (issueType) => {
      expect(inferBranchType('Refactor the store', issueType)).toBe('ref');
    },
  );

  it.each([
    ['Fix the login redirect', 'fix'],
    ['Resolve the flaky test', 'fix'],
    ['Refactor the store', 'ref'],
    ['Extract the branch naming', 'ref'],
    ['Migrate the settings blob', 'ref'],
    ['Test the sync path', 'tests'],
    ['Cover the reducer', 'tests'],
    ['Document the IPC contract', 'docs'],
    ['Bump electron to 33', 'chore'],
    ['Optimise the board render', 'perf'],
    ['Format the settings pane', 'style'],
  ] as const)('reads the leading verb of "%s" as %s', (title, expected) => {
    expect(inferBranchType(title, null)).toBe(expected);
  });

  it('falls back to feat — the honest default for work of unstated kind', () => {
    expect(inferBranchType('Something about the board', null)).toBe('feat');
    expect(inferBranchType('', null)).toBe('feat');
  });

  it('matches whole words, so a verb-lookalike does not win', () => {
    expect(inferBranchType('Fixture loading is slow', null)).toBe('feat');
    expect(inferBranchType('Testing-library upgrade', null)).toBe('feat');
  });
});

describe('slugify', () => {
  it('lower-cases and hyphenates', () => {
    expect(slugify('Add SSO Support')).toBe('add-sso-support');
  });

  it('folds accents rather than dropping the letters', () => {
    // Dropping them would turn "Émojis" into "mojis".
    expect(slugify('Émojis and Ünicode')).toBe('emojis-and-unicode');
  });

  it('collapses punctuation, emoji and runs of spaces', () => {
    expect(slugify('Émojis 🎉 and   spaces!!')).toBe('emojis-and-spaces');
    expect(slugify('feat/thing: the (good) one')).toBe('feat-thing-the-good-one');
  });

  it('never starts or ends with a hyphen', () => {
    expect(slugify('  --hello--  ')).toBe('hello');
    expect(slugify('!!!')).toBe('');
  });

  it('cuts long titles on a word boundary', () => {
    const slug = slugify('Add the authentication guard and wire it through every router path');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.split('-').every((w) => w.length > 0)).toBe(true);
  });

  it('takes a hard cut rather than nothing when one token is enormous', () => {
    expect(slugify('a'.repeat(80))).toHaveLength(40);
  });
});

describe('buildBranchName', () => {
  it('builds the full four-segment form', () => {
    expect(
      buildBranchName({
        prefix: 'wd',
        externalKey: 'ABC-123',
        externalType: 'Bug',
        title: 'Login fails on Safari',
      }),
    ).toBe('wd/fix/abc-123/login-fails-on-safari');
  });

  it('omits the prefix segment entirely when there is none — no leading slash', () => {
    // `/feat/…` is not a valid git ref, so this cannot be a naive concatenation.
    expect(
      buildBranchName({ prefix: '', externalKey: 'ABC-9', externalType: 'Story', title: 'Add SSO' }),
    ).toBe('feat/abc-9/add-sso');
    expect(buildBranchName({ title: 'Add SSO' }).startsWith('/')).toBe(false);
  });

  it('omits the ticket segment for a card that has no ticket', () => {
    expect(buildBranchName({ prefix: 'wd', title: 'Refactor the store' })).toBe(
      'wd/ref/refactor-the-store',
    );
  });

  it('honours a prefix that is itself a path', () => {
    expect(buildBranchName({ prefix: 'team/wd', externalKey: 'X-1', title: 'Add a thing' })).toBe(
      'team/wd/feat/x-1/add-a-thing',
    );
  });

  it('tolerates a prefix the user typed with slashes', () => {
    expect(buildBranchName({ prefix: '/wd/', title: 'Add a thing' })).toBe('wd/feat/add-a-thing');
  });

  it('lets an explicit type override the inference', () => {
    expect(
      buildBranchName({ type: 'tests', externalType: 'Bug', title: 'Login fails on Safari' }),
    ).toBe('tests/login-fails-on-safari');
  });

  it('falls back to a placeholder slug rather than a trailing slash', () => {
    expect(buildBranchName({ title: '🎉🎉🎉' })).toBe('feat/work');
    expect(buildBranchName({ title: '' })).toBe('feat/work');
  });

  it('always produces something git accepts', () => {
    const names = [
      buildBranchName({ prefix: 'wd', externalKey: 'ABC-1', title: 'Fix the ~weird~ [thing]' }),
      buildBranchName({ title: '...' }),
      buildBranchName({ prefix: '..', title: 'x' }),
      buildBranchName({ title: 'a'.repeat(200) }),
    ];
    for (const name of names) expect(validateBranchName(name)).toEqual({ ok: true });
  });
});

describe('validateBranchName', () => {
  it.each([
    'feat/add-sso',
    'wd/fix/abc-123/login-fails',
    'main',
    'release/2.0.1',
  ])('accepts %s', (name) => {
    expect(validateBranchName(name)).toEqual({ ok: true });
  });

  it.each([
    ['', 'empty'],
    ['  ', 'empty'],
    ['/feat/x', 'slash'],
    ['feat/x/', 'slash'],
    ['feat//x', 'empty path segment'],
    ['feat/../x', '".."'],
    ['feat/x.', 'dot'],
    ['feat/x.lock', '.lock'],
    ['feat/.hidden', 'dot'],
    ['feat/x@{1}', '@{'],
    ['@', 'reserved'],
    ['feat/has space', '" "'],
    ['feat/x~1', '"~"'],
    ['feat/x^', '"^"'],
    ['feat/x:y', '":"'],
    ['feat/x?', '"?"'],
    ['feat/x*', '"*"'],
    ['feat/x[y]', '"["'],
    ['feat/x\\y', '"\\"'],
  ])('rejects %s', (name, hint) => {
    const result = validateBranchName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain(hint.toLowerCase());
  });

  it('explains itself, since the reason is shown under the input as you type', () => {
    const result = validateBranchName('feat/bad name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^it /);
  });
});

describe('dedupeBranchName', () => {
  it('returns the name untouched when it is free', () => {
    expect(dedupeBranchName('feat/x', () => false)).toBe('feat/x');
  });

  it('suffixes until it finds a free one', () => {
    const used = new Set(['feat/x', 'feat/x-2', 'feat/x-3']);
    expect(dedupeBranchName('feat/x', (c) => used.has(c))).toBe('feat/x-4');
  });

  it('gives up rather than looping forever', () => {
    expect(dedupeBranchName('feat/x', () => true)).toBe('feat/x');
  });
});
