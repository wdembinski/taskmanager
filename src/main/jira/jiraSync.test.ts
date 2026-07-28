import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';
import { reconcileJiraTasks } from './jiraSync';
import type { JiraIssue } from './jiraClient';

const issue = (
  id: string,
  key: string,
  categoryKey: string,
  summary = 'Do a thing',
): JiraIssue => ({
  id,
  key,
  fields: {
    summary,
    status: {
      name: categoryKey === 'indeterminate' ? 'In Progress' : 'To Do',
      statusCategory: { key: categoryKey, name: 'X' },
    },
    priority: { name: 'High' },
    project: { key: 'PROJ', name: 'proj-name' },
  },
});

const jiraTask = (over: Partial<Task>): Task => ({
  id: 'jira-1',
  projectId: PERSONAL_PROJECT_ID,
  phase: 'proj-name',
  title: 'Do a thing',
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'jira',
  isContract: false,
  isScaffold: false,
  externalSource: 'jira',
  externalKey: 'PROJ-1',
  externalId: '1',
  ...over,
});

const opts = { baseUrl: 'https://jira.co' };

describe('reconcileJiraTasks — sprint', () => {
  const withSprint = (sprint: unknown): JiraIssue => {
    const i = issue('1', 'PROJ-1', 'new');
    (i.fields as Record<string, unknown>).customfield_7 = sprint;
    return i;
  };

  it('carries the running sprint name onto the card', () => {
    const { upserts } = reconcileJiraTasks(
      [],
      [withSprint([{ name: 'Sprint 5', state: 'active' }])],
      {
        ...opts,
        sprintFieldId: 'customfield_7',
      },
    );
    expect(upserts[0].externalSprint).toBe('Sprint 5');
  });

  it('leaves the sprint null when the instance has no such field', () => {
    const { upserts } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].externalSprint ?? null).toBeNull();
  });

  // Same rule as the epic and description: a sync that didn't ask for the field must
  // not wipe a name we already knew.
  it('keeps a previously known sprint when this sync did not return one', () => {
    const existing = jiraTask({ externalSprint: 'Sprint 5' });
    const { upserts } = reconcileJiraTasks([existing], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].externalSprint).toBe('Sprint 5');
  });
});

describe('reconcileJiraTasks', () => {
  it('creates a new task for a fetched issue with a stable id and deep link', () => {
    const { upserts, deleteIds } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'new')], opts);
    expect(deleteIds).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: 'jira-1',
      source: 'jira',
      externalKey: 'PROJ-1',
      externalUrl: 'https://jira.co/browse/PROJ-1',
      externalStatusCategory: 'To Do',
      status: 'pending',
      phase: 'proj-name',
    });
  });

  it('maps In Progress category to in-progress status', () => {
    const { upserts } = reconcileJiraTasks([], [issue('1', 'PROJ-1', 'indeterminate')], opts);
    expect(upserts[0].status).toBe('in-progress');
    expect(upserts[0].externalStatusCategory).toBe('In Progress');
  });

  it('preserves the blocked state and preBlockStatus across a re-sync', () => {
    const existing = jiraTask({ status: 'blocked', preBlockStatus: 'in-progress' });
    // JIRA now reports the issue as In Progress, but the user blocked it locally.
    const { upserts } = reconcileJiraTasks(
      existing ? [existing] : [],
      [issue('1', 'PROJ-1', 'indeterminate')],
      opts,
    );
    expect(upserts[0].status).toBe('blocked');
    expect(upserts[0].preBlockStatus).toBe('in-progress');
    // The raw external status is still refreshed for display.
    expect(upserts[0].externalStatusCategory).toBe('In Progress');
  });

  it('keeps the task id (and thus history) stable for an existing issue', () => {
    const existing = jiraTask({ id: 'jira-1', lastReadCommentAt: 555 });
    const { upserts } = reconcileJiraTasks([existing], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].id).toBe('jira-1');
    expect(upserts[0].lastReadCommentAt).toBe(555);
  });

  it('deletes a JIRA task that dropped out of the JQL result', () => {
    const existing = jiraTask({ status: 'in-progress' });
    const { deleteIds, upserts } = reconcileJiraTasks([existing], [], opts);
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual(['jira-1']);
  });

  it('does NOT delete a blocked task missing from the JQL result', () => {
    const existing = jiraTask({ status: 'blocked' });
    const { deleteIds } = reconcileJiraTasks([existing], [], opts);
    expect(deleteIds).toEqual([]);
  });

  it('maps the epic custom field and description onto the task', () => {
    const withEpic = issue('1', 'PROJ-1', 'new');
    (withEpic.fields as Record<string, unknown>).customfield_7 = 'abc-100';
    withEpic.fields.description = 'Reproduce, then fix.';

    const { upserts } = reconcileJiraTasks([], [withEpic], {
      ...opts,
      epicFieldId: 'customfield_7',
    });
    expect(upserts[0]).toMatchObject({
      externalParentKey: 'ABC-100',
      externalDescription: 'Reproduce, then fix.',
    });
  });

  it('falls back to `parent` and flattens a v3 ADF description', () => {
    const cloudIssue = issue('1', 'PROJ-1', 'new');
    cloudIssue.fields.parent = { key: 'ABC-9' };
    cloudIssue.fields.description = {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship it.' }] }],
    };

    const { upserts } = reconcileJiraTasks([], [cloudIssue], opts);
    expect(upserts[0].externalParentKey).toBe('ABC-9');
    expect(upserts[0].externalDescription).toBe('Ship it.');
  });

  it('keeps a known epic key/description when a sync returns neither', () => {
    const existing = jiraTask({
      externalParentKey: 'ABC-100',
      externalDescription: 'Old brief.',
    });
    const { upserts } = reconcileJiraTasks([existing], [issue('1', 'PROJ-1', 'new')], opts);
    expect(upserts[0].externalParentKey).toBe('ABC-100');
    expect(upserts[0].externalDescription).toBe('Old brief.');
  });

  it('carries an agent assignment through a re-sync (JIRA knows nothing about it)', () => {
    const existing = jiraTask({ agentProjectId: 'agent-1' });
    const { upserts } = reconcileJiraTasks(
      [existing],
      [issue('1', 'PROJ-1', 'indeterminate')],
      opts,
    );
    expect(upserts[0].agentProjectId).toBe('agent-1');
  });

  it('never touches ad-hoc internal tasks', () => {
    const adhoc: Task = jiraTask({
      id: 'adhoc-1',
      source: 'adhoc',
      externalSource: null,
      externalKey: null,
      externalId: null,
    });
    const { upserts, deleteIds } = reconcileJiraTasks([adhoc], [], opts);
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual([]);
  });
});
