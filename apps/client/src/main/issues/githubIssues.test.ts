import { describe, expect, it, vi } from 'vitest';
import type { IssueQuery } from '@shared/issues';
import type { GitHubClient } from '../github/githubClient';
import { githubRepoLabels, githubSearchPage1 } from './__fixtures__/githubSearchIssues';
import { buildIssueSearch, createGithubIssueProvider } from './githubIssues';

const baseQuery: IssueQuery = { provider: 'github' };

describe('buildIssueSearch', () => {
  it('defaults to open issues involving the signed-in user when there is no scope', () => {
    expect(buildIssueSearch(baseQuery)).toBe('is:issue is:open involves:@me');
  });

  it('scopes to the repository instead of the user when a scope is given', () => {
    expect(buildIssueSearch({ ...baseQuery, scope: 'acme/web' })).toBe(
      'is:issue is:open repo:acme/web',
    );
  });

  it('throws on a scope that is not an owner/repo path', () => {
    for (const scope of ['acme', 'acme/web/extra', '/web', 'acme/']) {
      expect(() => buildIssueSearch({ ...baseQuery, scope })).toThrow();
    }
  });

  it('ANDs in a single label', () => {
    expect(buildIssueSearch({ ...baseQuery, labels: ['bug'] })).toBe(
      'is:issue is:open involves:@me label:bug',
    );
  });

  it('quotes a label carrying a space', () => {
    expect(buildIssueSearch({ ...baseQuery, labels: ['good first issue'] })).toBe(
      'is:issue is:open involves:@me label:"good first issue"',
    );
  });

  it('strips a quote out of a label rather than let it close the literal early', () => {
    expect(buildIssueSearch({ ...baseQuery, labels: ['say "hi" there'] })).toBe(
      'is:issue is:open involves:@me label:"say hi there"',
    );
  });

  it('ANDs in every selected label, one qualifier each', () => {
    expect(buildIssueSearch({ ...baseQuery, labels: ['bug', 'urgent'] })).toBe(
      'is:issue is:open involves:@me label:bug label:urgent',
    );
  });

  it('drops blank labels', () => {
    expect(buildIssueSearch({ ...baseQuery, labels: ['', '  '] })).toBe(
      'is:issue is:open involves:@me',
    );
  });

  it('adds the free-text search as the last clause, unquoted', () => {
    expect(buildIssueSearch({ ...baseQuery, search: 'login crash' })).toBe(
      'is:issue is:open involves:@me login crash',
    );
  });

  it('combines scope, labels and search in one query', () => {
    expect(
      buildIssueSearch({ ...baseQuery, scope: 'acme/web', labels: ['bug'], search: 'crash' }),
    ).toBe('is:issue is:open repo:acme/web label:bug crash');
  });
});

function stubClient(
  page: { items: unknown[]; hasNext: boolean },
  labels: unknown[] = githubRepoLabels,
): GitHubClient {
  return {
    searchIssuesPage: vi.fn().mockResolvedValue(page),
    listRepoLabels: vi.fn().mockResolvedValue(labels),
  } as unknown as GitHubClient;
}

describe('createGithubIssueProvider', () => {
  it('maps a page to IssueSummary shape, filters out pull requests', async () => {
    const client = stubClient({ items: githubSearchPage1, hasNext: false });
    const provider = createGithubIssueProvider(client);

    const page = await provider.list({ ...baseQuery, scope: 'acme/web' });

    expect(page.items).toEqual([
      {
        provider: 'github',
        key: 'acme/web#1',
        title: 'Fix login crash on cold start',
        url: 'https://github.com/acme/web/issues/1',
        state: 'open',
        labels: ['crash', 'mobile'],
        type: null,
        assignee: 'ada',
        updatedAt: Date.parse('2026-09-30T14:22:05Z'),
      },
      {
        provider: 'github',
        key: 'acme/web#2',
        title: 'Add dark mode to settings',
        url: 'https://github.com/acme/web/issues/2',
        state: 'open',
        labels: [],
        type: null,
        assignee: null,
        updatedAt: Date.parse('2026-09-29T09:10:00Z'),
      },
    ]);
  });

  it('asks searchIssuesPage with the compiled query, the page and the shared page size', async () => {
    const client = stubClient({ items: [], hasNext: false });
    const provider = createGithubIssueProvider(client);

    await provider.list({ ...baseQuery, cursor: '3' });

    expect(client.searchIssuesPage).toHaveBeenCalledWith('is:issue is:open involves:@me', 3, 50);
  });

  it('turns hasNext into the next page number as the cursor', async () => {
    const client = stubClient({ items: [], hasNext: true });
    const provider = createGithubIssueProvider(client);

    const page = await provider.list({ ...baseQuery, cursor: '2' });
    expect(page.nextCursor).toBe('3');
  });

  it('answers null once the last page has been read', async () => {
    const client = stubClient({ items: [], hasNext: false });
    const provider = createGithubIssueProvider(client);

    const page = await provider.list(baseQuery);
    expect(page.nextCursor).toBeNull();
  });

  it('stops at page 20 even when GitHub still advertises a next page', async () => {
    const client = stubClient({ items: [], hasNext: true });
    const provider = createGithubIssueProvider(client);

    const page = await provider.list({ ...baseQuery, cursor: '20' });
    expect(page.nextCursor).toBeNull();
  });

  it('facets labels from the page, the repository scope, and the current selection', async () => {
    const client = stubClient({ items: githubSearchPage1, hasNext: false }, githubRepoLabels);
    const provider = createGithubIssueProvider(client);

    const page = await provider.list({ ...baseQuery, scope: 'acme/web', labels: ['archived'] });
    expect(page.labels).toEqual(['crash', 'mobile', 'docs', 'archived']);
    expect(client.listRepoLabels).toHaveBeenCalledWith('acme', 'web');
  });

  it('facets from the page alone when there is no repository scope to ask labels of', async () => {
    const client = stubClient({ items: githubSearchPage1, hasNext: false });
    const provider = createGithubIssueProvider(client);

    const page = await provider.list(baseQuery);
    expect(page.labels).toEqual(['crash', 'mobile']);
    expect(client.listRepoLabels).not.toHaveBeenCalled();
  });
});
