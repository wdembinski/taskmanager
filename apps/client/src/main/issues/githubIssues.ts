/**
 * GitHub's `IssueProvider` (F5.5): the search query an `issues:list` query compiles to, and
 * the mapping from a `GitHubSearchIssueItem` to the shared, tracker-agnostic `IssueSummary`.
 *
 * `repoRefFrom`/`issueKeyFor` are reused from `githubIssueSync.ts` rather than re-derived —
 * they are the same `owner/repo#123` identity a synced card already keys on, and inventing a
 * second way to read `repository_url` would risk the two drifting apart.
 */
import type { IssueQuery, IssueSummary } from '@shared/issues';
import { ISSUES_PAGE_SIZE } from '@shared/issues';
import type { GitHubClient, GitHubSearchIssueItem } from '../github/githubClient';
import { issueKeyFor, repoRefFrom } from '../github/githubIssueSync';
import {
  facetLabels,
  normalizeLabels,
  type IssueProvider,
  type ProviderPage,
} from './issueProvider';

/** An `owner/repo` scope: both halves non-empty, no slash inside either. */
const OWNER_REPO = /^[^/\s]+\/[^/\s]+$/;

/** The last page the issue browser will ever ask GitHub's search for. */
const MAX_PAGE = 20;

/**
 * The GitHub search query for one `issues:list` call: open issues only, scoped either to a
 * repository or to the signed-in user, ANDed with one `label:` qualifier per selected label.
 *
 * Unlike JIRA's `buildIssueJql`, an invalid `scope` **throws** rather than being dropped: a
 * bad project key there just means JQL narrows to nothing extra, but here `scope` is also
 * what decides whether `list` can ask for a repository's labels at all, so a scope that
 * cannot be parsed into `owner/repo` needs to stop the call rather than silently search
 * across every repository the token can see.
 */
export function buildIssueSearch(query: Pick<IssueQuery, 'search' | 'labels' | 'scope'>): string {
  const clauses = ['is:issue', 'is:open'];
  const scope = query.scope?.trim();
  if (scope) {
    if (!OWNER_REPO.test(scope)) {
      throw new Error(`"${scope}" is not an owner/repo path, so GitHub cannot scope to it.`);
    }
    clauses.push(`repo:${scope}`);
  } else {
    clauses.push('involves:@me');
  }
  for (const label of query.labels ?? []) {
    // GitHub's search syntax has no escape for a quote inside a quoted qualifier, so one is
    // stripped rather than risk closing the literal early and spilling into the next clause.
    const trimmed = label.trim().replace(/"/g, '');
    if (!trimmed) continue;
    clauses.push(trimmed.includes(' ') ? `label:"${trimmed}"` : `label:${trimmed}`);
  }
  const search = query.search?.trim();
  if (search) clauses.push(search);
  return clauses.join(' ');
}

function mapIssue(issue: GitHubSearchIssueItem): Omit<IssueSummary, 'onBoardTaskId'> {
  const { owner, repo } = repoRefFrom(issue.repository_url);
  return {
    provider: 'github',
    key: issueKeyFor(owner, repo, issue.number),
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    labels: normalizeLabels(issue.labels ?? []),
    type: null,
    assignee: issue.assignee?.login ?? null,
    updatedAt: Date.parse(issue.updated_at),
  };
}

/** GitHub's `IssueProvider`: wraps an already-configured `GitHubClient`. */
export function createGithubIssueProvider(client: GitHubClient): IssueProvider {
  return {
    id: 'github',
    async list(query: IssueQuery): Promise<ProviderPage> {
      const q = buildIssueSearch(query);
      const page = Math.max(1, Number(query.cursor) || 1);
      const { items, hasNext } = await client.searchIssuesPage(q, page, ISSUES_PAGE_SIZE);
      // A search row is an issue OR a pull request sharing one index; this browser lists
      // issues only, so a row carrying `pull_request` is dropped before it reaches a card.
      const issues = items.filter((item) => !item.pull_request);

      const scope = query.scope?.trim();
      let scopeLabels: string[] = [];
      if (scope && OWNER_REPO.test(scope)) {
        const [owner, repo] = scope.split('/');
        scopeLabels = normalizeLabels(await client.listRepoLabels(owner, repo));
      }
      const pageLabels = normalizeLabels(issues.flatMap((issue) => issue.labels ?? []));

      return {
        items: issues.map(mapIssue),
        labels: facetLabels(pageLabels, scopeLabels, query.labels ?? []),
        nextCursor: hasNext && page < MAX_PAGE ? String(page + 1) : null,
      };
    },
  };
}
