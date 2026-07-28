import { describe, expect, it } from 'vitest';
import {
  discoverSprintFieldId,
  findSprintFieldId,
  splitOrderBy,
  sprintNameFromIssue,
  SPRINT_FIELD_TYPE,
  withCurrentSprint,
} from './jiraSprint';
import type { JiraIssue } from './jiraClient';

const issueWith = (fields: Record<string, unknown>): JiraIssue =>
  ({
    id: '1',
    key: 'AB-1',
    fields: {
      summary: 's',
      status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
      ...fields,
    },
  }) as unknown as JiraIssue;

describe('splitOrderBy', () => {
  it('splits a filter from its sort', () => {
    expect(splitOrderBy('assignee = currentUser() ORDER BY updated DESC')).toEqual({
      where: 'assignee = currentUser()',
      orderBy: 'ORDER BY updated DESC',
    });
  });

  it('returns an empty sort when there is none', () => {
    expect(splitOrderBy('assignee = currentUser()')).toEqual({
      where: 'assignee = currentUser()',
      orderBy: '',
    });
  });

  // A blind indexOf would cut this query in half inside the string literal.
  it('ignores ORDER BY inside a quoted value', () => {
    const jql = 'summary ~ "order by tuesday" AND resolution = Unresolved';
    expect(splitOrderBy(jql)).toEqual({ where: jql, orderBy: '' });
  });

  it('ignores a bare word that merely ends in "order"', () => {
    const jql = 'summary ~ reorder by AND x = 1';
    expect(splitOrderBy(jql).orderBy).toBe('');
  });

  it('handles a query that is only a sort', () => {
    expect(splitOrderBy('ORDER BY rank ASC')).toEqual({ where: '', orderBy: 'ORDER BY rank ASC' });
  });
});

describe('withCurrentSprint', () => {
  it('inserts the clause before ORDER BY, where JIRA requires it', () => {
    expect(withCurrentSprint('assignee = currentUser() ORDER BY updated DESC')).toBe(
      '(assignee = currentUser()) AND sprint in openSprints() ORDER BY updated DESC',
    );
  });

  // Without the parentheses the clause would bind to the OR's last branch only,
  // widening the board instead of narrowing it.
  it('parenthesises an OR filter so the sprint clause applies to all of it', () => {
    expect(withCurrentSprint('assignee = me OR reporter = me')).toBe(
      '(assignee = me OR reporter = me) AND sprint in openSprints()',
    );
  });

  it('stands alone when the query has no filter', () => {
    expect(withCurrentSprint('')).toBe('sprint in openSprints()');
    expect(withCurrentSprint('ORDER BY rank ASC')).toBe(
      'sprint in openSprints() ORDER BY rank ASC',
    );
  });
});

describe('findSprintFieldId', () => {
  it('prefers the Greenhopper field type over the name', () => {
    const fields = [
      { id: 'customfield_1', name: 'Sprint' },
      { id: 'customfield_2', name: 'Sprint (old)', schema: { custom: SPRINT_FIELD_TYPE } },
    ];
    expect(findSprintFieldId(fields)).toBe('customfield_2');
  });

  it('falls back to the English name', () => {
    expect(findSprintFieldId([{ id: 'customfield_9', name: ' sprint ' }])).toBe('customfield_9');
  });

  it('returns null on an instance without JIRA Software', () => {
    expect(findSprintFieldId([{ id: 'summary', name: 'Summary' }])).toBeNull();
  });
});

describe('discoverSprintFieldId', () => {
  it('fails soft when /field cannot be read, so the sync still runs', async () => {
    const client = { listFields: () => Promise.reject(new Error('403')) };
    await expect(discoverSprintFieldId(client)).resolves.toBeNull();
  });
});

describe('sprintNameFromIssue', () => {
  it('returns null when the field was never discovered', () => {
    expect(sprintNameFromIssue(issueWith({ customfield_1: [{ name: 'S1' }] }), null)).toBeNull();
  });

  it('reads the modern object shape', () => {
    const issue = issueWith({ customfield_1: [{ name: 'Sprint 5', state: 'active' }] });
    expect(sprintNameFromIssue(issue, 'customfield_1')).toBe('Sprint 5');
  });

  // An issue carries every sprint it has ever been in, closed ones included.
  it('prefers the running sprint over a closed one', () => {
    const issue = issueWith({
      customfield_1: [
        { name: 'Sprint 4', state: 'closed' },
        { name: 'Sprint 5', state: 'ACTIVE' },
      ],
    });
    expect(sprintNameFromIssue(issue, 'customfield_1')).toBe('Sprint 5');
  });

  it('falls back to the most recent entry when none is active', () => {
    const issue = issueWith({
      customfield_1: [
        { name: 'Sprint 4', state: 'closed' },
        { name: 'Sprint 6', state: 'future' },
      ],
    });
    expect(sprintNameFromIssue(issue, 'customfield_1')).toBe('Sprint 6');
  });

  // Older Server/DC emits the toString() of the Java object rather than JSON.
  it('parses the legacy Server/DC string form', () => {
    const issue = issueWith({
      customfield_1: [
        'com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=7,rapidViewId=3,state=ACTIVE,name=Sprint 5,startDate=2026-07-01]',
      ],
    });
    expect(sprintNameFromIssue(issue, 'customfield_1')).toBe('Sprint 5');
  });

  it('keeps a comma inside a legacy sprint name', () => {
    const issue = issueWith({
      customfield_1: ['…Sprint@1[id=7,name=Sprint 5, part 2,state=ACTIVE]'],
    });
    expect(sprintNameFromIssue(issue, 'customfield_1')).toBe('Sprint 5, part 2');
  });

  it('handles a single (non-array) value and an empty field', () => {
    expect(sprintNameFromIssue(issueWith({ f: { name: 'Solo' } }), 'f')).toBe('Solo');
    expect(sprintNameFromIssue(issueWith({ f: null }), 'f')).toBeNull();
    expect(sprintNameFromIssue(issueWith({ f: [] }), 'f')).toBeNull();
  });
});
