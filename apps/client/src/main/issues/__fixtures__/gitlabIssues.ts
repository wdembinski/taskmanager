/** Trimmed, real-shaped `GET /projects/:id/issues` rows and a project's own label list. */
import type { GitLabIssue, GitLabLabel } from '../../gitlab/gitlabClient';

export const gitlabIssuesPage1: GitLabIssue[] = [
  {
    iid: 1,
    title: 'Fix login crash on cold start',
    web_url: 'https://gitlab.com/acme/web/-/issues/1',
    state: 'opened',
    labels: ['crash', 'mobile'],
    assignee: { name: 'Ada Lovelace', username: 'ada' },
    updated_at: '2026-09-30T14:22:05Z',
    issue_type: 'issue',
    references: { full: 'acme/web#1' },
  },
  {
    iid: 2,
    title: 'Add dark mode to settings',
    web_url: 'https://gitlab.com/acme/web/-/issues/2',
    state: 'opened',
    labels: [],
    assignee: null,
    updated_at: '2026-09-29T09:10:00Z',
    issue_type: 'task',
    references: { full: 'acme/web#2' },
  },
];

export const gitlabProjectLabels: GitLabLabel[] = [
  { name: 'crash' },
  { name: 'mobile' },
  { name: 'docs' },
];
