/**
 * JIRA's `IssueProvider` (F5.5): the JQL an `issues:list` query compiles to, and the
 * mapping from a `JiraIssue` to the shared, tracker-agnostic `IssueSummary`.
 *
 * The base clause always excludes Done — the issue browser browses OPEN work, the
 * same intent the board's own JQL expresses with whatever filter its user wrote, but
 * fixed here since there is no per-user filter to defer to.
 */
import type { IssueQuery, IssueSummary } from '@shared/issues';
import { ISSUES_PAGE_SIZE } from '@shared/issues';
import type { JiraClient, JiraIssue } from '../jira/jiraClient';
import { jqlString } from '../jira/jiraJql';
import {
  facetLabels,
  normalizeLabels,
  type IssueProvider,
  type ProviderPage,
} from './issueProvider';

/** A JIRA project key: letters, digits and underscores, starting with a letter. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The JQL for one `issues:list` call: open issues, optionally narrowed to a project and
 * to free text, ANDed with one `labels = …` clause per selected label — a card must
 * carry every selected label, not just one, matching how the facet filter reads.
 *
 * `scope` reaches here unchecked from the renderer over IPC; anything that isn't a bare
 * project key is dropped rather than interpolated, so it narrows nothing instead of
 * breaking the query or opening an injection seam.
 */
export function buildIssueJql(query: Pick<IssueQuery, 'search' | 'labels' | 'scope'>): string {
  const clauses = ['statusCategory != Done'];
  const scope = query.scope?.trim();
  if (scope && PROJECT_KEY.test(scope)) clauses.push(`project = ${scope}`);
  for (const label of query.labels ?? []) {
    const trimmed = label.trim();
    if (trimmed) clauses.push(`labels = ${jqlString(trimmed)}`);
  }
  const search = query.search?.trim();
  if (search) clauses.push(`text ~ ${jqlString(search)}`);
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

function mapIssue(issue: JiraIssue, baseUrl: string): Omit<IssueSummary, 'onBoardTaskId'> {
  return {
    provider: 'jira',
    key: issue.key,
    title: issue.fields.summary,
    url: `${baseUrl}/browse/${issue.key}`,
    state: issue.fields.status.name,
    labels: normalizeLabels(issue.fields.labels ?? []),
    type: issue.fields.issuetype?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    updatedAt: Date.parse(issue.fields.updated ?? ''),
  };
}

/** JIRA's `IssueProvider`: wraps an already-configured `JiraClient` and its base URL. */
export function createJiraIssueProvider(client: JiraClient, baseUrl: string): IssueProvider {
  return {
    id: 'jira',
    async list(query: IssueQuery): Promise<ProviderPage> {
      const jql = buildIssueJql(query);
      const [{ issues, nextCursor }, scopeLabels] = await Promise.all([
        client.searchPage(jql, { maxResults: ISSUES_PAGE_SIZE, cursor: query.cursor ?? null }),
        client.listLabels(),
      ]);
      const pageLabels = normalizeLabels(issues.flatMap((issue) => issue.fields.labels ?? []));
      return {
        items: issues.map((issue) => mapIssue(issue, baseUrl)),
        labels: facetLabels(pageLabels, scopeLabels ?? [], query.labels ?? []),
        nextCursor,
      };
    },
  };
}
