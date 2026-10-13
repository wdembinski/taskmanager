/**
 * Trimmed, real-shaped `GET /rest/api/2/search` (Server/DC) responses — same fields as
 * {@link ./jiraSearchV3}, but offset-paged (`startAt`/`total`) rather than token-paged.
 */

export const jiraSearchV2Page1 = {
  issues: [
    {
      id: '20001',
      key: 'SRV-1',
      fields: {
        summary: 'Upgrade the build agent image',
        status: {
          name: 'In Progress',
          statusCategory: { key: 'indeterminate', name: 'In Progress' },
        },
        issuetype: { name: 'Task' },
        labels: ['infra'],
        assignee: { displayName: 'Alan Turing' },
        updated: '2026-09-28T08:45:00.000+0200',
      },
    },
  ],
  startAt: 0,
  maxResults: 1,
  total: 2,
};

export const jiraSearchV2LastPage = {
  issues: [
    {
      id: '20002',
      key: 'SRV-2',
      fields: {
        summary: 'Rotate the staging database password',
        status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
        issuetype: { name: 'Task' },
        labels: [],
        assignee: null,
        updated: '2026-09-27T16:30:00.000+0200',
      },
    },
  ],
  startAt: 1,
  maxResults: 1,
  total: 2,
};
