import { describe, expect, it } from 'vitest';
import { parsePrUrl } from './parsePrUrl';

describe('parsePrUrl', () => {
  it('parses a github.com pull request URL', () => {
    expect(parsePrUrl('https://github.com/acme/web/pull/42')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'web',
      number: 42,
    });
  });

  it('parses a GitHub Enterprise pull request URL', () => {
    expect(parsePrUrl('https://github.mycompany.com/acme/web/pull/7')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'web',
      number: 7,
    });
  });

  it('parses a gitlab.com merge request URL', () => {
    expect(parsePrUrl('https://gitlab.com/acme/web/-/merge_requests/9')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 9,
    });
  });

  it('parses a self-hosted GitLab merge request URL', () => {
    expect(parsePrUrl('https://git.mycompany.com/acme/web/-/merge_requests/3')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 3,
    });
  });

  // Distinguished by PATH, not host: a self-hosted forge can sit on ANY hostname, including
  // one that says nothing about GitLab or GitHub.
  it('recognises a GitLab MR on a hostname that names neither forge', () => {
    expect(parsePrUrl('https://forge.internal/acme/web/-/merge_requests/1')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 1,
    });
  });

  it('preserves nested GitLab subgroups in the project path', () => {
    expect(parsePrUrl('https://gitlab.com/acme/platform/backend/-/merge_requests/15')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/platform/backend',
      number: 15,
    });
  });

  it('tolerates a missing scheme', () => {
    expect(parsePrUrl('gitlab.com/acme/web/-/merge_requests/9')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 9,
    });
    expect(parsePrUrl('github.com/acme/web/pull/42')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'web',
      number: 42,
    });
  });

  it('tolerates a trailing /diffs on a GitLab URL', () => {
    expect(parsePrUrl('https://gitlab.com/acme/web/-/merge_requests/9/diffs')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 9,
    });
  });

  it('tolerates a query string', () => {
    expect(parsePrUrl('https://gitlab.com/acme/web/-/merge_requests/9?tab=commits')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 9,
    });
    expect(parsePrUrl('https://github.com/acme/web/pull/42?diff=split')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'web',
      number: 42,
    });
  });

  it('tolerates a trailing note anchor', () => {
    expect(parsePrUrl('https://gitlab.com/acme/web/-/merge_requests/9#note_12345')).toEqual({
      provider: 'gitlab',
      projectPath: 'acme/web',
      number: 9,
    });
    expect(parsePrUrl('https://github.com/acme/web/pull/42#issuecomment-987')).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'web',
      number: 42,
    });
  });

  it('rejects a GitHub issue URL', () => {
    expect(parsePrUrl('https://github.com/acme/web/issues/42')).toBeNull();
  });

  it('rejects a GitLab issue URL', () => {
    expect(parsePrUrl('https://gitlab.com/acme/web/-/issues/9')).toBeNull();
  });

  it('rejects a GitHub pull-requests LIST URL (no number)', () => {
    expect(parsePrUrl('https://github.com/acme/web/pulls')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(parsePrUrl('not a url at all')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
    expect(parsePrUrl('   ')).toBeNull();
  });
});
