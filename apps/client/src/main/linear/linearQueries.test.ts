import { describe, expect, it } from 'vitest';
import type { LinearSettings } from '@shared/settings';
import {
  buildIssueFilter,
  chunkIds,
  commentCreateMutation,
  commentsQuery,
  issueUpdateStateMutation,
  issuesByIdQuery,
  issuesQuery,
  parseAdvancedFilter,
  teamStatesQuery,
  teamsQuery,
  viewerQuery,
} from './linearQueries';

type FilterSettings = Pick<
  LinearSettings,
  'teamKeys' | 'assignee' | 'includeStateTypes' | 'advancedFilter'
>;

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('parseAdvancedFilter', () => {
  it('treats blank/undefined as "nothing extra"', () => {
    expect(parseAdvancedFilter(undefined)).toEqual({ ok: true, filter: null });
    expect(parseAdvancedFilter('')).toEqual({ ok: true, filter: null });
    expect(parseAdvancedFilter('   ')).toEqual({ ok: true, filter: null });
  });

  it('treats an empty object the same as blank', () => {
    expect(parseAdvancedFilter('{}')).toEqual({ ok: true, filter: null });
  });

  it('parses a real filter object', () => {
    expect(parseAdvancedFilter('{"priority":{"gte":2}}')).toEqual({
      ok: true,
      filter: { priority: { gte: 2 } },
    });
  });

  it('rejects malformed JSON with a message', () => {
    const result = parseAdvancedFilter('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Linear advanced filter is not valid JSON/);
  });

  it('rejects a JSON array', () => {
    const result = parseAdvancedFilter('[1,2,3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Linear advanced filter must be a JSON object.');
  });

  it('rejects a bare JSON string', () => {
    const result = parseAdvancedFilter('"just a string"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Linear advanced filter must be a JSON object.');
  });
});

describe('buildIssueFilter', () => {
  const base: FilterSettings = {
    teamKeys: ['ENG'],
    assignee: 'me',
    includeStateTypes: ['triage', 'backlog'],
    advancedFilter: undefined,
  };

  it('trims and dedupes team keys', () => {
    const result = buildIssueFilter({ ...base, teamKeys: [' ENG ', 'ENG', 'OPS'] });
    expect(result).toEqual({
      ok: true,
      filter: {
        and: [
          { team: { key: { in: ['ENG', 'OPS'] } } },
          { assignee: { isMe: { eq: true } } },
          { state: { type: { in: ['triage', 'backlog'] } } },
        ],
      },
    });
  });

  it('adds isMe for "me" and omits it for "anyone"', () => {
    const mine = buildIssueFilter(base);
    expect(mine).toEqual({
      ok: true,
      filter: {
        and: [
          { team: { key: { in: ['ENG'] } } },
          { assignee: { isMe: { eq: true } } },
          { state: { type: { in: ['triage', 'backlog'] } } },
        ],
      },
    });

    const anyone = buildIssueFilter({ ...base, assignee: 'anyone' });
    expect(anyone).toEqual({
      ok: true,
      filter: {
        and: [
          { team: { key: { in: ['ENG'] } } },
          { state: { type: { in: ['triage', 'backlog'] } } },
        ],
      },
    });
  });

  it('passes through known state types and drops unknown ones', () => {
    const result = buildIssueFilter({
      ...base,
      includeStateTypes: ['started', 'bogus' as never, 'completed'],
    });
    expect(result).toEqual({
      ok: true,
      filter: {
        and: [
          { team: { key: { in: ['ENG'] } } },
          { assignee: { isMe: { eq: true } } },
          { state: { type: { in: ['started', 'completed'] } } },
        ],
      },
    });
  });

  it('omits the state clause entirely when no state type survives', () => {
    const result = buildIssueFilter({ ...base, includeStateTypes: [] });
    expect(result).toEqual({
      ok: true,
      filter: {
        and: [{ team: { key: { in: ['ENG'] } } }, { assignee: { isMe: { eq: true } } }],
      },
    });
  });

  it('ANDs the advanced filter onto the declarative clauses', () => {
    const result = buildIssueFilter({
      ...base,
      advancedFilter: '{"priority":{"gte":2}}',
    });
    expect(result).toEqual({
      ok: true,
      filter: {
        and: [
          { team: { key: { in: ['ENG'] } } },
          { assignee: { isMe: { eq: true } } },
          { state: { type: { in: ['triage', 'backlog'] } } },
          { priority: { gte: 2 } },
        ],
      },
    });
  });

  it('errors when no team key survives', () => {
    const result = buildIssueFilter({ ...base, teamKeys: [] });
    expect(result).toEqual({
      ok: false,
      error: 'Linear has no team selected — add at least one team key before syncing.',
    });

    const blankOnly = buildIssueFilter({ ...base, teamKeys: ['   '] });
    expect(blankOnly.ok).toBe(false);
  });

  it('propagates an invalid advanced filter instead of building a filter', () => {
    const result = buildIssueFilter({ ...base, advancedFilter: '{not json' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Linear advanced filter is not valid JSON/);
  });
});

describe('issuesQuery', () => {
  it('asks for null after on page one', () => {
    const request = issuesQuery({ and: [] });
    expect(request.variables).toEqual({ first: 50, after: null, filter: { and: [] } });
    expect(request.query).toContain('issues(first: $first, after: $after, filter: $filter');
  });

  it('carries a cursor and page size through to the variables', () => {
    const request = issuesQuery({ and: [] }, 'cursor-123', 25);
    expect(request.variables).toEqual({ first: 25, after: 'cursor-123', filter: { and: [] } });
  });
});

describe('issuesByIdQuery', () => {
  it('dedupes ids', () => {
    const request = issuesByIdQuery([ID_A, ID_A, ID_B]);
    expect(request?.variables.ids).toEqual([ID_A, ID_B]);
  });

  it('drops invalid ids and keeps the valid ones', () => {
    const request = issuesByIdQuery([ID_A, 'not-a-uuid', null, 42]);
    expect(request?.variables.ids).toEqual([ID_A]);
  });

  it('returns null when every id is invalid', () => {
    expect(issuesByIdQuery(['nope', '', null, undefined])).toBeNull();
    expect(issuesByIdQuery([])).toBeNull();
  });

  it('sizes the connection to the number of surviving ids', () => {
    const request = issuesByIdQuery([ID_A, ID_B]);
    expect(request?.query).toContain('issues(first: 2, filter:');
  });
});

describe('chunkIds', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `id-${i + 1}`);

  it('chunks at the batch size', () => {
    expect(chunkIds(ids(0))).toEqual([]);
    expect(chunkIds(ids(50)).map((c) => c.length)).toEqual([50]);
    expect(chunkIds(ids(51)).map((c) => c.length)).toEqual([50, 1]);
  });

  it('takes a custom size', () => {
    expect(chunkIds(ids(5), 2).map((c) => c.length)).toEqual([2, 2, 1]);
  });
});

describe('issueUpdateStateMutation', () => {
  it('documents issueUpdate and carries the ids exactly', () => {
    const request = issueUpdateStateMutation(ID_A, ID_B);
    expect(request.query).toContain('issueUpdate');
    expect(request.variables).toEqual({ id: ID_A, stateId: ID_B });
  });

  it('throws on an invalid issue id', () => {
    expect(() => issueUpdateStateMutation('not-a-uuid', ID_B)).toThrow();
  });

  it('throws on an invalid state id', () => {
    expect(() => issueUpdateStateMutation(ID_A, 'not-a-uuid')).toThrow();
  });
});

describe('commentCreateMutation', () => {
  it('documents commentCreate and carries the id/body exactly', () => {
    const request = commentCreateMutation(ID_A, 'hello there');
    expect(request.query).toContain('commentCreate');
    expect(request.variables).toEqual({ issueId: ID_A, body: 'hello there' });
  });

  it('throws on an invalid issue id', () => {
    expect(() => commentCreateMutation('not-a-uuid', 'hello')).toThrow();
  });
});

describe('commentsQuery', () => {
  it('asks for the comment user by id, not just name', () => {
    const request = commentsQuery(ID_A);
    expect(request.query).toContain('user { id name displayName }');
  });
});

describe('viewerQuery', () => {
  it('has no variables and asks for the viewer plus the organization, in one request', () => {
    const request = viewerQuery();
    expect(request.variables).toEqual({});
    expect(request.query).toContain('viewer { id name displayName }');
    expect(request.query).toContain('organization { name urlKey }');
  });
});

describe('teamsQuery', () => {
  it('has no variables and asks for id, key and name', () => {
    const request = teamsQuery();
    expect(request.variables).toEqual({});
    expect(request.query).toContain('teams(first: 100)');
    expect(request.query).toContain('nodes { id key name }');
  });
});

describe('teamStatesQuery', () => {
  it('passes the team key as a variable, never interpolated into the document', () => {
    const request = teamStatesQuery('ENG');
    expect(request.variables).toEqual({ key: 'ENG' });
    expect(request.query).not.toContain('ENG');
    expect(request.query).toContain('team: { key: { eq: $key } }');
    expect(request.query).toContain('nodes { id name type position }');
  });
});
