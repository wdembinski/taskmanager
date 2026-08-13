import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError, apiRoot, nextPageUrl } from './githubClient';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

const client = (baseUrl = 'https://api.github.com'): GitHubClient =>
  new GitHubClient({ baseUrl, token: 'ghp_x' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHubClient', () => {
  it('sends the whole header set GitHub pins its responses to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, login: 'wd' }));
    vi.stubGlobal('fetch', fetchMock);

    const me = await client().getMe();

    expect(me.login).toBe('wd');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.github.com/user');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers).toEqual({
      Authorization: 'Bearer ghp_x',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('cleans a token that arrived with the paste', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1, login: 'wd' }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitHubClient({ baseUrl: 'https://api.github.com', token: ' ghp_x\n' }).getMe();
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_x');
  });

  it('throws a GitHubError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Bad creds' }, 401)));
    await expect(client().getMe()).rejects.toBeInstanceOf(GitHubError);
    await expect(client().getMe()).rejects.toMatchObject({ status: 401 });
  });

  it('follows Link rel="next" and stops when it is gone', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], 200, {
          link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 2 }], 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const all = await client().paged<{ id: number }>('/user/repos');

    expect(all.map((r) => r.id)).toEqual([1, 2]);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.github.com/user/repos?page=2');
  });

  it('stops paging at the cap rather than trusting the header forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([{ id: 1 }], 200, {
          link: '<https://api.github.com/user/repos?page=2>; rel="next"',
        }),
      ),
    );
    await client().paged('/user/repos', 3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('appends /api/v3 for an Enterprise host and not for github.com', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1, login: 'wd' }));
    vi.stubGlobal('fetch', fetchMock);
    await client('https://github.acme.internal/').getMe();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://github.acme.internal/api/v3/user');
  });
});

describe('GitHubClient — pull requests and their checks', () => {
  /**
   * `advanced_search=true` is load-bearing: GitHub deprecated the legacy issue-search
   * syntax on 4 Sep 2025, and a query sent without the flag is on a removal schedule.
   */
  it('asks search for your own open PRs, in the syntax GitHub has not deprecated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ total_count: 0, items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await client().listMyPullRequests();

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/search/issues?q=');
    expect(decodeURIComponent(url)).toContain('q=is:pr is:open author:@me');
    expect(url).toContain('advanced_search=true');
    expect(url).toContain('sort=updated');
  });

  // Search wraps its rows in `items`, unlike every list endpoint — and pages by `Link`.
  it('unwraps `items` and follows the search’s own next link', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ number: 1 }] }, 200, {
          link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ number: 2 }] }, 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const prs = await client().listMyPullRequests();

    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://api.github.com/search/issues?q=x&page=2',
    );
  });

  it('unwraps `check_runs`, and asks the server to drop superseded re-runs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ total_count: 1, check_runs: [{ name: 'build' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const runs = await client().listCheckRuns('acme', 'web', 'deadbeef');

    expect(runs).toEqual([{ name: 'build' }]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(
      'https://api.github.com/repos/acme/web/commits/deadbeef/check-runs?per_page=100&filter=latest',
    );
  });

  it('reads a PR, its reviews and its combined status off the repo path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await client().getPullRequest('acme', 'web', 7);
    await client().listReviews('acme', 'web', 7);
    await client().getCombinedStatus('acme', 'web', 'deadbeef');

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.github.com/repos/acme/web/pulls/7',
      'https://api.github.com/repos/acme/web/pulls/7/reviews?per_page=100',
      'https://api.github.com/repos/acme/web/commits/deadbeef/status?per_page=100',
    ]);
  });

  // A branch name is a path segment with slashes in it — the commonest kind there is.
  it('escapes a branch name on the way into the protection path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await client().getBranchProtection('acme', 'web', 'release/2026-08');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/branches/release%2F2026-08/protection',
    );
  });

  // The admin-gated case the caller degrades on: the status has to survive the throw.
  it('carries the 403 on branch protection through as a status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'admin' }, 403)));
    await expect(client().getBranchProtection('acme', 'web', 'main')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('searchIssues', () => {
  it('sends the user’s query with advanced_search, and collects every page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ number: 1 }], incomplete_results: false }, 200, {
          link: '<https://api.github.com/search/issues?page=2&opaque=x>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ number: 2 }], incomplete_results: false }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().searchIssues('is:issue is:open assignee:@me');

    expect(result.items.map((i) => i.number)).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toContain('advanced_search=true');
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      encodeURIComponent('is:issue is:open assignee:@me'),
    );
    // The `Link` URL verbatim — search hangs its own parameters off it and re-deriving drops
    // them.
    expect(String(fetchMock.mock.calls[1][0])).toContain('opaque=x');
  });

  /**
   * The one fact the reconciler turns on. Both shapes of short answer have to reach it as the
   * same flag, because both have the same consequence: a board that read either as a shrunken
   * board would archive the difference.
   */
  it('reports GitHub giving up as truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ items: [{ number: 1 }], incomplete_results: true })),
    );
    const result = await client().searchIssues('is:issue');
    expect(result).toMatchObject({ incompleteResults: true, truncated: true });
  });

  it('reports OUR page cap as truncated too', async () => {
    // Every page advertises a next one; the cap is what stops us, and there is provably more
    // out there that we chose not to read.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ items: [{ number: 1 }], incomplete_results: false }, 200, {
          link: '<https://api.github.com/search/issues?page=99>; rel="next"',
        }),
      ),
    );
    const result = await client().searchIssues('is:issue', 2);
    expect(result).toMatchObject({ incompleteResults: false, truncated: true });
    expect(result.items).toHaveLength(2);
  });
});

describe('getIssue / listIssueComments', () => {
  it('asks for one issue by number, with both path parts escaped', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ number: 12, state: 'closed' }));
    vi.stubGlobal('fetch', fetchMock);
    await client().getIssue('acme', 'web.js', 12);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web.js/issues/12',
    );
  });

  it('pages an issue’s comments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 1 }]));
    vi.stubGlobal('fetch', fetchMock);
    const comments = await client().listIssueComments('acme', 'web', 12);
    expect(comments).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/repos/acme/web/issues/12/comments');
  });
});

describe('commenting on an issue', () => {
  it('POSTs the body as JSON and returns what GitHub recorded', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 99, created_at: '2026-08-13T09:00:00Z' }));
    vi.stubGlobal('fetch', fetchMock);

    const created = await client().addIssueComment('acme', 'web', 12, 'looks good @octocat');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/repos/acme/web/issues/12/comments');
    expect(init.method).toBe('POST');
    // Markdown, verbatim: there is no document to build, so the body is the string as typed.
    expect(JSON.parse(String(init.body))).toEqual({ body: 'looks good @octocat' });
    expect(created.id).toBe(99);
  });

  it('asks /assignees for the mention picker — /collaborators needs push access', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: 1, login: 'octocat', avatar_url: 'https://a/1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const people = await client().listAssignableUsers('acme', 'web');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/assignees?per_page=100',
    );
    expect(people.map((p) => p.login)).toEqual(['octocat']);
  });
});

describe('the writes a card’s move makes', () => {
  it('PATCHes the state and NOTHING else', async () => {
    // A PATCH that carried a title or a body would rewrite whatever it had merely read.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ number: 12, state: 'closed' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().setIssueState('acme', 'web', 12, 'closed');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/repos/acme/web/issues/12');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ state: 'closed' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('POSTs labels to the additive endpoint, never a PUT of the whole set', async () => {
    // A PUT would delete every label the app knows nothing about — the repo's own taxonomy.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ name: 'wip' }]));
    vi.stubGlobal('fetch', fetchMock);

    await client().addLabels('acme', 'web', 12, ['wip']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/repos/acme/web/issues/12/labels');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ labels: ['wip'] });
  });

  it('escapes the label name it deletes — labels have spaces and slashes in them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await client().removeLabel('acme', 'web', 12, 'status: in review');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      'https://api.github.com/repos/acme/web/issues/12/labels/status%3A%20in%20review',
    );
    expect(init.method).toBe('DELETE');
    // No body, so no Content-Type either.
    expect(init.body).toBeUndefined();
  });

  it('throws a GitHubError with the status, so a refused move can be told from a missing label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404)));
    await expect(client().removeLabel('acme', 'web', 12, 'wip')).rejects.toMatchObject({
      status: 404,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'no' }, 403)));
    await expect(client().setIssueState('acme', 'web', 12, 'closed')).rejects.toBeInstanceOf(
      GitHubError,
    );
  });
});

describe('apiRoot', () => {
  it('leaves github.com’s own API host alone, trailing slash and all', () => {
    expect(apiRoot('https://api.github.com')).toBe('https://api.github.com');
    expect(apiRoot('https://api.github.com/')).toBe('https://api.github.com');
  });

  it('adds /api/v3 to an Enterprise instance root, but never twice', () => {
    expect(apiRoot('https://github.acme.internal')).toBe('https://github.acme.internal/api/v3');
    expect(apiRoot('https://github.acme.internal/api/v3')).toBe(
      'https://github.acme.internal/api/v3',
    );
  });
});

describe('nextPageUrl', () => {
  it('finds rel="next" wherever it sits in the list', () => {
    const link =
      '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextPageUrl(link)).toBe('https://api.github.com/x?page=3');
  });

  it('is null on the last page, and on no header at all', () => {
    expect(nextPageUrl('<https://api.github.com/x?page=1>; rel="first"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl(undefined)).toBeNull();
  });
});
