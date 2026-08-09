import { describe, expect, it } from 'vitest';
import {
  discoverEpicFieldId,
  epicKeyFromIssue,
  EPIC_LINK_FIELD_TYPE,
  findEpicLinkFieldId,
} from './epicField';
import type { JiraField, JiraIssue } from './jiraClient';

const issue = (fields: Partial<JiraIssue['fields']> = {}): JiraIssue => ({
  id: '1',
  key: 'PROJ-1',
  fields: {
    summary: 'Do a thing',
    status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
    ...fields,
  },
});

describe('findEpicLinkFieldId', () => {
  it('prefers the Greenhopper field type over the name', () => {
    const fields: JiraField[] = [
      { id: 'customfield_1', name: 'Epic Link' },
      { id: 'customfield_2', name: 'Epik-Verknüpfung', schema: { custom: EPIC_LINK_FIELD_TYPE } },
    ];
    expect(findEpicLinkFieldId(fields)).toBe('customfield_2');
  });

  it('falls back to the field name, case- and space-insensitively', () => {
    expect(findEpicLinkFieldId([{ id: 'customfield_9', name: ' epic link ' }])).toBe(
      'customfield_9',
    );
  });

  it('returns null when no epic field exists (team-managed Cloud)', () => {
    expect(findEpicLinkFieldId([{ id: 'summary', name: 'Summary' }, { id: 'parent' }])).toBeNull();
  });
});

describe('discoverEpicFieldId', () => {
  it('returns the discovered id', async () => {
    const client = {
      listFields: async () => [{ id: 'customfield_5', schema: { custom: EPIC_LINK_FIELD_TYPE } }],
    };
    await expect(discoverEpicFieldId(client)).resolves.toBe('customfield_5');
  });

  it('fails soft to null when the field lookup errors (no permission etc.)', async () => {
    const client = {
      listFields: async (): Promise<JiraField[]> => {
        throw new Error('JIRA 403 Forbidden');
      },
    };
    await expect(discoverEpicFieldId(client)).resolves.toBeNull();
  });
});

describe('epicKeyFromIssue', () => {
  it('reads the discovered custom field, upper-cased', () => {
    const i = issue();
    (i.fields as Record<string, unknown>).customfield_7 = 'abc-100';
    expect(epicKeyFromIssue(i, 'customfield_7')).toBe('ABC-100');
  });

  it('prefers the epic custom field over parent', () => {
    const i = issue({ parent: { key: 'ABC-9' } });
    (i.fields as Record<string, unknown>).customfield_7 = 'ABC-100';
    expect(epicKeyFromIssue(i, 'customfield_7')).toBe('ABC-100');
  });

  it('falls back to parent when the epic field is unknown or empty', () => {
    expect(epicKeyFromIssue(issue({ parent: { key: 'ABC-9' } }), null)).toBe('ABC-9');
    const blank = issue({ parent: { key: 'ABC-9' } });
    (blank.fields as Record<string, unknown>).customfield_7 = '   ';
    expect(epicKeyFromIssue(blank, 'customfield_7')).toBe('ABC-9');
  });

  it('returns null when the issue hangs off nothing', () => {
    expect(epicKeyFromIssue(issue(), 'customfield_7')).toBeNull();
    expect(epicKeyFromIssue(issue({ parent: null }), null)).toBeNull();
  });

  it('ignores a non-string custom field value (e.g. an object-valued field)', () => {
    const i = issue();
    (i.fields as Record<string, unknown>).customfield_7 = { key: 'ABC-100' };
    expect(epicKeyFromIssue(i, 'customfield_7')).toBeNull();
  });
});
