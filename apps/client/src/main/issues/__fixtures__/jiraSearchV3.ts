/**
 * Trimmed, real-shaped `GET /rest/api/3/search/jql` (Cloud) responses — just the fields
 * `jiraIssues.ts` reads, with the opaque cursor Cloud actually hands back.
 */

export const jiraSearchV3Page1 = {
  issues: [
    {
      id: '10001',
      key: 'AB-1',
      fields: {
        summary: 'Fix login crash on cold start',
        status: {
          name: 'In Progress',
          statusCategory: { key: 'indeterminate', name: 'In Progress' },
        },
        issuetype: { name: 'Bug' },
        labels: ['crash', 'mobile'],
        assignee: { displayName: 'Ada Lovelace' },
        updated: '2026-09-30T14:22:05.000+0200',
      },
    },
    {
      id: '10002',
      key: 'AB-2',
      fields: {
        summary: 'Add dark mode to settings',
        status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
        issuetype: { name: 'Story' },
        labels: [],
        assignee: null,
        updated: '2026-09-29T09:10:00.000+0200',
      },
    },
  ],
  nextPageToken: 'CAEaAggD',
  isLast: false,
};

export const jiraSearchV3LastPage = {
  issues: [
    {
      id: '10003',
      key: 'AB-3',
      fields: {
        summary: 'Document the release checklist',
        status: { name: 'Done', statusCategory: { key: 'done', name: 'Done' } },
        issuetype: { name: 'Task' },
        labels: ['docs'],
        assignee: { displayName: 'Grace Hopper' },
        updated: '2026-09-20T11:00:00.000+0200',
      },
    },
  ],
  isLast: true,
};
