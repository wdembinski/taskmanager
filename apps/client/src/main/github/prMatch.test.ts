import { describe, expect, it } from 'vitest';
import { closingReferences, discoverPullRequestKeys, isRepoScopedKey } from './prMatch';

const REPO = 'acme/web';

describe('closingReferences', () => {
  it('resolves a bare number against the pull request’s own repository', () => {
    // The whole point of the scoped spelling: issue 123 exists in every repository there
    // has ever been, so `#123` alone is not an answer.
    expect(closingReferences('Closes #123', REPO)).toEqual(['acme/web#123']);
  });

  it('takes a cross-repository reference at its word', () => {
    expect(closingReferences('Fixes other/api#45', REPO)).toEqual(['other/api#45']);
  });

  it('reads a pasted issue URL', () => {
    expect(closingReferences('Resolves https://github.com/other/api/issues/7', REPO)).toEqual([
      'other/api#7',
    ]);
  });

  it.each([
    'close #1',
    'Closes #1',
    'CLOSED #1',
    'fix #1',
    'Fixes #1',
    'fixed #1',
    'resolve #1',
    'Resolves #1',
    'RESOLVED #1',
    'Closes: #1',
    'closes#1',
  ])('recognises %s', (text) => {
    expect(closingReferences(text, REPO)).toEqual(['acme/web#1']);
  });

  it('ignores a plain mention — only a closing keyword links an issue', () => {
    expect(closingReferences('see #9 for context', REPO)).toEqual([]);
    expect(closingReferences('part of #9', REPO)).toEqual([]);
  });

  it('needs a word boundary: "prefixes #3" is not "fixes #3"', () => {
    expect(closingReferences('prefixes #3', REPO)).toEqual([]);
  });

  it('collects every reference once, in the order written', () => {
    expect(closingReferences('Closes #1, fixes #2 and closes #1 again', REPO)).toEqual([
      'acme/web#1',
      'acme/web#2',
    ]);
  });

  it('drops a bare number when there is no repository to resolve it against', () => {
    expect(closingReferences('Closes #1', '')).toEqual([]);
  });
});

describe('discoverPullRequestKeys', () => {
  const known = ['acme/web#123', 'ENG-1'];

  it('files a PR under the issue it closes', () => {
    expect(
      discoverPullRequestKeys(
        { title: 'Fix the login redirect', description: 'Closes #123', projectPath: REPO },
        known,
      ),
    ).toEqual(['acme/web#123']);
  });

  it('files one under a tracker key in its branch, exactly as GitLab does', () => {
    expect(
      discoverPullRequestKeys(
        { title: 'fix login', sourceBranch: 'feature/ENG-1', projectPath: REPO },
        known,
      ),
    ).toEqual(['ENG-1']);
  });

  it('lets the closing reference win over a tracker key, and keeps both', () => {
    // The PR is FOR the issue GitHub will close when it lands; the ticket it also names is
    // a reference. Every key is still stored, so a board change can re-match.
    expect(
      discoverPullRequestKeys(
        {
          title: 'ENG-1: fix login',
          description: 'Closes #123',
          sourceBranch: 'feature/ENG-1',
          projectPath: REPO,
        },
        known,
      ),
    ).toEqual(['acme/web#123', 'ENG-1']);
  });

  it('matches case-insensitively and answers in the board’s own spelling', () => {
    expect(
      discoverPullRequestKeys({ description: 'closes ACME/WEB#123', projectPath: REPO }, known),
    ).toEqual(['acme/web#123']);
    expect(
      discoverPullRequestKeys({ sourceBranch: 'wd/eng_1-login', projectPath: REPO }, known),
    ).toEqual(['ENG-1']);
  });

  it('drops a candidate nothing on the board carries — the whole safety net', () => {
    expect(
      discoverPullRequestKeys(
        { title: 'bump to UTF-8', description: 'Closes #999', projectPath: REPO },
        known,
      ),
    ).toEqual([]);
  });

  it('returns nothing when the board is empty', () => {
    expect(discoverPullRequestKeys({ description: 'Closes #123', projectPath: REPO }, [])).toEqual(
      [],
    );
  });

  it('prefers a closing reference in the title over one in the body', () => {
    expect(
      discoverPullRequestKeys(
        { title: 'Closes other/api#45', description: 'Closes #123', projectPath: REPO },
        ['acme/web#123', 'other/api#45'],
      ),
    ).toEqual(['other/api#45', 'acme/web#123']);
  });
});

describe('isRepoScopedKey', () => {
  it('tells a remembered closing reference from a tracker key', () => {
    expect(isRepoScopedKey('acme/web#123')).toBe(true);
    expect(isRepoScopedKey('ENG-1')).toBe(false);
  });
});
