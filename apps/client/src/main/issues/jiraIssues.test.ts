import { describe, expect, it, vi } from 'vitest';
import type { IssueQuery } from '@shared/issues';
import type { JiraClient } from '../jira/jiraClient';
import { jiraLabelsPage } from './__fixtures__/jiraLabels';
import { jiraSearchV2LastPage, jiraSearchV2Page1 } from './__fixtures__/jiraSearchV2';
import { jiraSearchV3LastPage, jiraSearchV3Page1 } from './__fixtures__/jiraSearchV3';
import { buildIssueJql, createJiraIssueProvider } from './jiraIssues';

const baseQuery: IssueQuery = { provider: 'jira' };

describe('buildIssueJql', () => {
  it('is just the open-issues filter and the sort when nothing else is asked', () => {
    expect(buildIssueJql(baseQuery)).toBe('statusCategory != Done ORDER BY updated DESC');
  });

  it('ANDs in a single label', () => {
    expect(buildIssueJql({ ...baseQuery, labels: ['bug'] })).toBe(
      'statusCategory != Done AND labels = "bug" ORDER BY updated DESC',
    );
  });

  it('ANDs in every selected label, one clause each — a card must carry all of them', () => {
    expect(buildIssueJql({ ...baseQuery, labels: ['bug', 'urgent'] })).toBe(
      'statusCategory != Done AND labels = "bug" AND labels = "urgent" ORDER BY updated DESC',
    );
  });

  it('escapes a label carrying a quote rather than letting it close the literal early', () => {
    expect(buildIssueJql({ ...baseQuery, labels: ['say "hi"'] })).toBe(
      'statusCategory != Done AND labels = "say \\"hi\\"" ORDER BY updated DESC',
    );
  });

  it('drops blank labels', () => {
    expect(buildIssueJql({ ...baseQuery, labels: ['', '  '] })).toBe(
      'statusCategory != Done ORDER BY updated DESC',
    );
  });

  it('adds the free-text search as a quoted text clause', () => {
    expect(buildIssueJql({ ...baseQuery, search: 'login crash' })).toBe(
      'statusCategory != Done AND text ~ "login crash" ORDER BY updated DESC',
    );
  });

  it('narrows to the scoped project when it looks like a real project key', () => {
    expect(buildIssueJql({ ...baseQuery, scope: 'AB' })).toBe(
      'statusCategory != Done AND project = AB ORDER BY updated DESC',
    );
  });

  it('drops a scope that is not a bare project key, rather than interpolating it', () => {
    for (const scope of ['AB-1', 'AB OR 1=1', '"; DROP', '']) {
      expect(buildIssueJql({ ...baseQuery, scope })).toBe(
        'statusCategory != Done ORDER BY updated DESC',
      );
    }
  });

  it('combines scope, labels and search in one query', () => {
    expect(buildIssueJql({ ...baseQuery, scope: 'AB', labels: ['bug'], search: 'crash' })).toBe(
      'statusCategory != Done AND project = AB AND labels = "bug" AND text ~ "crash" ORDER BY updated DESC',
    );
  });
});

function stubClient(
  page: { issues: unknown[]; nextCursor: string | null },
  labels: string[] | null = jiraLabelsPage.values,
): JiraClient {
  return {
    searchPage: vi.fn().mockResolvedValue(page),
    listLabels: vi.fn().mockResolvedValue(labels),
  } as unknown as JiraClient;
}

describe('createJiraIssueProvider', () => {
  it('maps a v3 page to IssueSummary shape, reading assignee and parsing updated', async () => {
    const client = stubClient({ issues: jiraSearchV3Page1.issues, nextCursor: 'CAEaAggD' });
    const provider = createJiraIssueProvider(client, 'https://acme.atlassian.net');

    const page = await provider.list(baseQuery);

    expect(page.items).toEqual([
      {
        provider: 'jira',
        key: 'AB-1',
        title: 'Fix login crash on cold start',
        url: 'https://acme.atlassian.net/browse/AB-1',
        state: 'In Progress',
        labels: ['crash', 'mobile'],
        type: 'Bug',
        assignee: 'Ada Lovelace',
        updatedAt: Date.parse('2026-09-30T14:22:05.000+0200'),
      },
      {
        provider: 'jira',
        key: 'AB-2',
        title: 'Add dark mode to settings',
        url: 'https://acme.atlassian.net/browse/AB-2',
        state: 'To Do',
        labels: [],
        type: 'Story',
        assignee: null,
        updatedAt: Date.parse('2026-09-29T09:10:00.000+0200'),
      },
    ]);
    expect(page.nextCursor).toBe('CAEaAggD');
  });

  it('passes the cursor and page size through to searchPage', async () => {
    const client = stubClient({ issues: [], nextCursor: null });
    const provider = createJiraIssueProvider(client, 'https://acme.atlassian.net');

    await provider.list({ ...baseQuery, cursor: 'CAEaAggD' });

    expect(client.searchPage).toHaveBeenCalledWith('statusCategory != Done ORDER BY updated DESC', {
      maxResults: 50,
      cursor: 'CAEaAggD',
    });
  });

  it('answers null when v3 hands back the last page (isLast)', async () => {
    const client = stubClient({ issues: jiraSearchV3LastPage.issues, nextCursor: null });
    const provider = createJiraIssueProvider(client, 'https://acme.atlassian.net');

    const page = await provider.list(baseQuery);
    expect(page.nextCursor).toBeNull();
  });

  it('maps a v2 page the same way, offset cursor and all', async () => {
    const client = stubClient({ issues: jiraSearchV2Page1.issues, nextCursor: '1' });
    const provider = createJiraIssueProvider(client, 'https://jira.company.com');

    const page = await provider.list(baseQuery);
    expect(page.items[0]).toMatchObject({
      key: 'SRV-1',
      assignee: 'Alan Turing',
      labels: ['infra'],
    });
    expect(page.nextCursor).toBe('1');
  });

  it('answers null when v2 hands back the last page', async () => {
    const client = stubClient({ issues: jiraSearchV2LastPage.issues, nextCursor: null });
    const provider = createJiraIssueProvider(client, 'https://jira.company.com');

    const page = await provider.list(baseQuery);
    expect(page.nextCursor).toBeNull();
  });

  it('facets labels from the page, the instance-wide list, and the current selection', async () => {
    const client = stubClient({ issues: jiraSearchV3Page1.issues, nextCursor: null }, [
      'crash',
      'mobile',
      'docs',
    ]);
    const provider = createJiraIssueProvider(client, 'https://acme.atlassian.net');

    const page = await provider.list({ ...baseQuery, labels: ['archived'] });
    expect(page.labels).toEqual(['crash', 'mobile', 'docs', 'archived']);
  });

  it('facets from the page alone when the instance has no /label endpoint', async () => {
    const client = stubClient({ issues: jiraSearchV3Page1.issues, nextCursor: null }, null);
    const provider = createJiraIssueProvider(client, 'https://acme.atlassian.net');

    const page = await provider.list(baseQuery);
    expect(page.labels).toEqual(['crash', 'mobile']);
  });
});
