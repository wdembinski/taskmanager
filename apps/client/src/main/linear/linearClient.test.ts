import { describe, expect, it, vi } from 'vitest';
import {
  LinearAuthError,
  LinearClient,
  LinearError,
  LinearGraphQLError,
  LinearRateLimitError,
  parseRateLimitReset,
} from './linearClient';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

function client(fetchImpl: typeof fetch, extra: Partial<{ endpoint: string }> = {}) {
  return new LinearClient({ apiKey: 'lin_api_x', fetchImpl, ...extra });
}

describe('parseRateLimitReset', () => {
  it('reads x-ratelimit-requests-reset as epoch seconds and converts to ms', () => {
    const headers = {
      get: (k: string) => (k === 'x-ratelimit-requests-reset' ? '1700000000' : null),
    };
    expect(parseRateLimitReset(headers)).toBe(1700000000 * 1000);
  });

  it('passes through a value that is already epoch ms', () => {
    const headers = {
      get: (k: string) => (k === 'x-ratelimit-requests-reset' ? '1700000000000' : null),
    };
    expect(parseRateLimitReset(headers)).toBe(1700000000000);
  });

  it('falls back to x-ratelimit-complexity-reset when the requests header is absent', () => {
    const headers = {
      get: (k: string) => (k === 'x-ratelimit-complexity-reset' ? '1700000000' : null),
    };
    expect(parseRateLimitReset(headers)).toBe(1700000000 * 1000);
  });

  it('returns null when neither header is present', () => {
    const headers = { get: () => null };
    expect(parseRateLimitReset(headers)).toBeNull();
  });

  it('returns null when the header is not a number', () => {
    const headers = { get: (k: string) => (k === 'x-ratelimit-requests-reset' ? 'soon' : null) };
    expect(parseRateLimitReset(headers)).toBeNull();
  });
});

describe('LinearClient — request shape', () => {
  it('posts to the default endpoint with a sanitized, un-Bearer’d key', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      jsonResponse(200, { data: { ok: true } }),
    );
    await client(fetchImpl).fetchComments(UUID1);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('lin_api_x');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init!.body as string);
    expect(body.query).toContain('IssueComments');
    expect(body.variables).toEqual({ id: UUID1, after: null });
  });

  it('cleans a key that arrived with the paste', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      jsonResponse(200, { data: { ok: true } }),
    );
    await new LinearClient({ apiKey: ' lin_api_x\n', fetchImpl }).fetchComments(UUID1);
    const [, init] = fetchImpl.mock.calls[0];
    expect((init!.headers as Record<string, string>).Authorization).toBe('lin_api_x');
  });

  it('honours a configured endpoint override', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      jsonResponse(200, { data: { ok: true } }),
    );
    await client(fetchImpl, { endpoint: 'https://example.test/graphql' }).fetchComments(UUID1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/graphql');
  });
});

describe('LinearClient — the error ladder', () => {
  it('throws LinearAuthError on a plain HTTP 401', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { errors: [{ message: 'Unauthorized' }] }),
    );
    await expect(client(fetchImpl).fetchComments(UUID1)).rejects.toBeInstanceOf(LinearAuthError);
  });

  it('throws LinearAuthError on HTTP 400 carrying AUTHENTICATION_ERROR', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        errors: [
          { message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    );
    const err = await client(fetchImpl)
      .fetchComments(UUID1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearAuthError);
    expect((err as LinearAuthError).status).toBe(400);
  });

  it('throws LinearRateLimitError with resetAt parsed from the requests-reset header', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        200,
        { errors: [{ message: 'Rate limited', extensions: { code: 'RATELIMITED' } }] },
        { 'x-ratelimit-requests-reset': '1700000000' },
      ),
    );
    const err = await client(fetchImpl)
      .fetchComments(UUID1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearRateLimitError);
    expect((err as LinearRateLimitError).resetAt).toBe(1700000000 * 1000);
  });

  it('throws LinearRateLimitError on a plain HTTP 429', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    await expect(client(fetchImpl).fetchComments(UUID1)).rejects.toBeInstanceOf(
      LinearRateLimitError,
    );
  });

  it('throws LinearGraphQLError with partialData attached when data and errors both come back', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: { issue: null },
        errors: [{ message: 'Issue not visible to this key' }],
      }),
    );
    const err = await client(fetchImpl)
      .fetchComments(UUID1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearGraphQLError);
    expect((err as LinearGraphQLError).partialData).toEqual({ issue: null });
    expect((err as LinearGraphQLError).message).toContain('Issue not visible to this key');
  });

  it('throws a plain LinearError for any other non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, 'internal error'));
    const err = await client(fetchImpl)
      .fetchComments(UUID1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinearError);
    expect(err).not.toBeInstanceOf(LinearAuthError);
    expect((err as LinearError).status).toBe(500);
  });
});

describe('LinearClient#fetchIssues', () => {
  function issuePage(n: number, hasNextPage: boolean, endCursor: string | null) {
    return jsonResponse(200, {
      data: {
        issues: {
          nodes: Array.from({ length: n }, (_, i) => ({ id: `issue-${i}` })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    });
  }

  it('pages through three pages, passing the prior endCursor as after', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(issuePage(50, true, 'cursor-1'))
      .mockResolvedValueOnce(issuePage(50, true, 'cursor-2'))
      .mockResolvedValueOnce(issuePage(20, false, null));

    const page = await client(fetchImpl).fetchIssues({});

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(page.issues).toHaveLength(120);
    expect(page.truncated).toBe(false);
    expect(page.cap).toBe(500);

    const secondVars = JSON.parse(fetchImpl.mock.calls[1][1]!.body as string).variables;
    expect(secondVars.after).toBe('cursor-1');
    const thirdVars = JSON.parse(fetchImpl.mock.calls[2][1]!.body as string).variables;
    expect(thirdVars.after).toBe('cursor-2');
  });

  it('stops at an 11x50 cap of 500, reporting truncated and making exactly 10 calls', async () => {
    const fetchImpl = vi.fn(async () => issuePage(50, true, 'cursor-next'));

    const page = await client(fetchImpl).fetchIssues({}, { cap: 500, pageSize: 50 });

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(page.issues).toHaveLength(500);
    expect(page.truncated).toBe(true);
  });

  it('reports truncated: false when exactly 500 issues end the pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(issuePage(50, true, 'c1'))
      .mockResolvedValueOnce(issuePage(50, true, 'c2'))
      .mockResolvedValueOnce(issuePage(50, true, 'c3'))
      .mockResolvedValueOnce(issuePage(50, true, 'c4'))
      .mockResolvedValueOnce(issuePage(50, true, 'c5'))
      .mockResolvedValueOnce(issuePage(50, true, 'c6'))
      .mockResolvedValueOnce(issuePage(50, true, 'c7'))
      .mockResolvedValueOnce(issuePage(50, true, 'c8'))
      .mockResolvedValueOnce(issuePage(50, true, 'c9'))
      .mockResolvedValueOnce(issuePage(50, false, null));

    const page = await client(fetchImpl).fetchIssues({}, { cap: 500, pageSize: 50 });

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(page.issues).toHaveLength(500);
    expect(page.truncated).toBe(false);
  });

  it('stops and reports truncated when hasNextPage is true but endCursor is missing', async () => {
    const fetchImpl = vi.fn(async () => issuePage(10, true, null));

    const page = await client(fetchImpl).fetchIssues({}, { cap: 500, pageSize: 50 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(page.issues).toHaveLength(10);
    expect(page.truncated).toBe(true);
  });
});

describe('LinearClient#fetchIssuesByIds', () => {
  it('chunks 120 ids into 3 requests', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => UUID1.replace(/1$/, String(i % 10)));
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { issues: { nodes: [{ id: UUID1 }] } } }),
    );

    const issues = await client(fetchImpl).fetchIssuesByIds(ids);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(issues).toHaveLength(3);
  });

  it('short-circuits to [] with no call when every id is invalid', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: {} }));

    const issues = await client(fetchImpl).fetchIssuesByIds(['not-a-uuid']);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });
});

describe('LinearClient — mutations', () => {
  it('updateIssueState resolves on success', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: { issueUpdate: { success: true, issue: { id: UUID1 } } },
      }),
    );
    await expect(client(fetchImpl).updateIssueState(UUID1, UUID2)).resolves.toBeUndefined();
  });

  it('updateIssueState throws when success is false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { issueUpdate: { success: false, issue: null } } }),
    );
    await expect(client(fetchImpl).updateIssueState(UUID1, UUID2)).rejects.toBeInstanceOf(
      LinearError,
    );
  });

  it('createComment returns the comment on success', async () => {
    const comment = { id: UUID1, body: 'hi', createdAt: 'now', url: 'u', user: null };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { commentCreate: { success: true, comment } } }),
    );
    await expect(client(fetchImpl).createComment(UUID1, 'hi')).resolves.toEqual(comment);
  });

  it('createComment throws when success is false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: { commentCreate: { success: false, comment: null } } }),
    );
    await expect(client(fetchImpl).createComment(UUID1, 'hi')).rejects.toBeInstanceOf(LinearError);
  });
});

describe('LinearClient#getViewer', () => {
  it('round-trips the viewer query', async () => {
    const viewer = { id: UUID1, name: 'ada', displayName: 'Ada' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { viewer } }));

    const result = await client(fetchImpl).getViewer();

    expect(result).toEqual(viewer);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.query).toContain('Viewer');
  });
});

describe('LinearClient#listTeams', () => {
  it('round-trips the teams query', async () => {
    const teams = [{ id: UUID1, key: 'ENG', name: 'Engineering' }];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { teams: { nodes: teams } } }));

    const result = await client(fetchImpl).listTeams();

    expect(result).toEqual(teams);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.query).toContain('Teams');
  });
});

describe('LinearClient#listTeamStates', () => {
  it('round-trips the team states query, passing the key as a variable', async () => {
    const nodes = [{ id: UUID1, name: 'Todo', type: 'unstarted', position: 0 }];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { workflowStates: { nodes } } }));

    const result = await client(fetchImpl).listTeamStates('ENG');

    expect(result).toEqual(nodes);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.variables).toEqual({ key: 'ENG' });
    expect(body.query).not.toContain('"ENG"');
  });

  it('narrows an unrecognised state type to unstarted', async () => {
    const nodes = [{ id: UUID1, name: 'Weird', type: 'something-new', position: 0 }];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { workflowStates: { nodes } } }));

    const result = await client(fetchImpl).listTeamStates('ENG');

    expect(result).toEqual([{ id: UUID1, name: 'Weird', type: 'unstarted', position: 0 }]);
  });
});
