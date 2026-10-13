import { describe, expect, it, vi } from 'vitest';
import type { IssueQuery } from '@shared/issues';
import type { GitLabClient } from '../gitlab/gitlabClient';
import { gitlabIssuesPage1, gitlabProjectLabels } from './__fixtures__/gitlabIssues';
import { createGitlabIssueProvider } from './gitlabIssues';

const baseQuery: IssueQuery = { provider: 'gitlab' };

function stubClient(
  page: { issues: unknown[]; nextPage: string | null },
  labels: unknown[] = gitlabProjectLabels,
): GitLabClient {
  return {
    listIssues: vi.fn().mockResolvedValue(page),
    listProjectLabels: vi.fn().mockResolvedValue(labels),
  } as unknown as GitLabClient;
}

describe('createGitlabIssueProvider', () => {
  it('maps a page to IssueSummary shape, keyed by references.full', async () => {
    const client = stubClient({ issues: gitlabIssuesPage1, nextPage: null });
    const provider = createGitlabIssueProvider(client);

    const page = await provider.list({ ...baseQuery, scope: 'acme/web' });

    expect(page.items).toEqual([
      {
        provider: 'gitlab',
        key: 'acme/web#1',
        title: 'Fix login crash on cold start',
        url: 'https://gitlab.com/acme/web/-/issues/1',
        state: 'opened',
        labels: ['crash', 'mobile'],
        type: 'issue',
        assignee: 'Ada Lovelace',
        updatedAt: Date.parse('2026-09-30T14:22:05Z'),
      },
      {
        provider: 'gitlab',
        key: 'acme/web#2',
        title: 'Add dark mode to settings',
        url: 'https://gitlab.com/acme/web/-/issues/2',
        state: 'opened',
        labels: [],
        type: 'task',
        assignee: null,
        updatedAt: Date.parse('2026-09-29T09:10:00Z'),
      },
    ]);
  });

  it('asks listIssues with the project scope, open state, the page and the shared page size', async () => {
    const client = stubClient({ issues: [], nextPage: null });
    const provider = createGitlabIssueProvider(client);

    await provider.list({ ...baseQuery, scope: 'acme/web', cursor: '3' });

    expect(client.listIssues).toHaveBeenCalledWith('acme/web', {
      state: 'opened',
      labels: undefined,
      search: undefined,
      page: 3,
      perPage: 50,
    });
  });

  it('asks for assigned-to-me issues across the whole instance when there is no scope', async () => {
    const client = stubClient({ issues: [], nextPage: null });
    const provider = createGitlabIssueProvider(client);

    await provider.list(baseQuery);

    expect(client.listIssues).toHaveBeenCalledWith(null, expect.objectContaining({ page: 1 }));
    expect(client.listProjectLabels).not.toHaveBeenCalled();
  });

  it('joins the selected labels with a comma', async () => {
    const client = stubClient({ issues: [], nextPage: null });
    const provider = createGitlabIssueProvider(client);

    await provider.list({ ...baseQuery, labels: ['bug', 'urgent'] });

    expect(client.listIssues).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ labels: ['bug', 'urgent'] }),
    );
  });

  it('passes the free-text search through, trimmed', async () => {
    const client = stubClient({ issues: [], nextPage: null });
    const provider = createGitlabIssueProvider(client);

    await provider.list({ ...baseQuery, search: '  login crash  ' });

    expect(client.listIssues).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ search: 'login crash' }),
    );
  });

  it('turns x-next-page into the cursor, as-is', async () => {
    const client = stubClient({ issues: [], nextPage: '4' });
    const provider = createGitlabIssueProvider(client);

    const page = await provider.list(baseQuery);
    expect(page.nextCursor).toBe('4');
  });

  it('answers null once the last page has been read', async () => {
    const client = stubClient({ issues: [], nextPage: null });
    const provider = createGitlabIssueProvider(client);

    const page = await provider.list(baseQuery);
    expect(page.nextCursor).toBeNull();
  });

  it('facets labels from the page, the project scope, and the current selection', async () => {
    const client = stubClient({ issues: gitlabIssuesPage1, nextPage: null }, gitlabProjectLabels);
    const provider = createGitlabIssueProvider(client);

    const page = await provider.list({ ...baseQuery, scope: 'acme/web', labels: ['archived'] });
    expect(page.labels).toEqual(['crash', 'mobile', 'docs', 'archived']);
    expect(client.listProjectLabels).toHaveBeenCalledWith('acme/web');
  });

  it('facets from the page alone when there is no project scope to ask labels of', async () => {
    const client = stubClient({ issues: gitlabIssuesPage1, nextPage: null });
    const provider = createGitlabIssueProvider(client);

    const page = await provider.list(baseQuery);
    expect(page.labels).toEqual(['crash', 'mobile']);
    expect(client.listProjectLabels).not.toHaveBeenCalled();
  });
});
