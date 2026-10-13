/**
 * Trimmed, real-shaped `GET /search/issues` rows, including one pull request that should
 * never survive the provider's own `pull_request` filter.
 */
import type { GitHubSearchIssueItem } from '../../github/githubClient';

export const githubSearchPage1: GitHubSearchIssueItem[] = [
  {
    id: 3001,
    number: 1,
    title: 'Fix login crash on cold start',
    state: 'open',
    html_url: 'https://github.com/acme/web/issues/1',
    repository_url: 'https://api.github.com/repos/acme/web',
    updated_at: '2026-09-30T14:22:05Z',
    labels: [{ name: 'crash' }, { name: 'mobile' }],
    assignee: { login: 'ada' },
  },
  {
    id: 3002,
    number: 2,
    title: 'Add dark mode to settings',
    state: 'open',
    html_url: 'https://github.com/acme/web/issues/2',
    repository_url: 'https://api.github.com/repos/acme/web',
    updated_at: '2026-09-29T09:10:00Z',
    labels: [],
    assignee: null,
  },
  {
    id: 3003,
    number: 3,
    title: 'Bump the build image',
    state: 'open',
    html_url: 'https://github.com/acme/web/pull/3',
    repository_url: 'https://api.github.com/repos/acme/web',
    updated_at: '2026-09-28T11:00:00Z',
    labels: [],
    pull_request: { url: 'https://api.github.com/repos/acme/web/pulls/3' },
  },
];

export const githubRepoLabels = [{ name: 'crash' }, { name: 'mobile' }, { name: 'docs' }];
