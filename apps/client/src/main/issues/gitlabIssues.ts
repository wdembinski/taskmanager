/**
 * GitLab's `IssueProvider` (F5.5): the mapping from a `GitLabIssue` to the shared,
 * tracker-agnostic `IssueSummary`, and the page-at-a-time read behind it.
 *
 * Unlike JIRA's JQL or GitHub's search syntax, GitLab's issue list takes its filters as
 * plain query parameters — `GitLabClient.listIssues` already builds those, so there is no
 * query string to compile here, only the page to ask for and the result to shape.
 */
import type { IssueQuery, IssueSummary } from '@shared/issues';
import { ISSUES_PAGE_SIZE } from '@shared/issues';
import type { GitLabClient, GitLabIssue } from '../gitlab/gitlabClient';
import {
  facetLabels,
  normalizeLabels,
  type IssueProvider,
  type ProviderPage,
} from './issueProvider';

function mapIssue(issue: GitLabIssue): Omit<IssueSummary, 'onBoardTaskId'> {
  return {
    provider: 'gitlab',
    key: issue.references?.full ?? String(issue.iid),
    title: issue.title,
    url: issue.web_url,
    state: issue.state,
    labels: normalizeLabels(issue.labels ?? []),
    type: issue.issue_type ?? null,
    assignee: issue.assignee?.name ?? issue.assignee?.username ?? null,
    updatedAt: Date.parse(issue.updated_at),
  };
}

/** GitLab's `IssueProvider`: wraps an already-configured `GitLabClient`. */
export function createGitlabIssueProvider(client: GitLabClient): IssueProvider {
  return {
    id: 'gitlab',
    async list(query: IssueQuery): Promise<ProviderPage> {
      const scope = query.scope?.trim() || null;
      const page = Math.max(1, Number(query.cursor) || 1);
      const labels = (query.labels ?? []).map((label) => label.trim()).filter(Boolean);
      const search = query.search?.trim() || undefined;

      const [{ issues, nextPage }, scopeLabels] = await Promise.all([
        client.listIssues(scope, {
          state: 'opened',
          labels: labels.length ? labels : undefined,
          search,
          page,
          perPage: ISSUES_PAGE_SIZE,
        }),
        scope ? client.listProjectLabels(scope) : Promise.resolve([]),
      ]);
      const pageLabels = normalizeLabels(issues.flatMap((issue) => issue.labels ?? []));

      return {
        items: issues.map(mapIssue),
        labels: facetLabels(pageLabels, normalizeLabels(scopeLabels), query.labels ?? []),
        nextCursor: nextPage,
      };
    },
  };
}
