import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubClient,
  GitHubError,
  apiRoot,
  graphqlRoot,
  nextPageUrl,
  pickMergeMethod,
} from './githubClient';
import { pullRequestFilesPage1, pullRequestFilesPage2 } from './__fixtures__/pullRequestFiles';

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

function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    json: async () => JSON.parse(body),
    text: async () => body,
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

  // A large monorepo's matrix build can carry more than 100 check runs — `Link` pagination,
  // the same as every other list endpoint, rather than losing everything past the first page.
  it('follows Link rel="next" through check runs, up to the cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ total_count: 2, check_runs: [{ name: 'build' }] }, 200, {
          link: '<https://api.github.com/repos/acme/web/commits/deadbeef/check-runs?per_page=100&filter=latest&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ total_count: 2, check_runs: [{ name: 'test' }] }, 200, {}),
      );
    vi.stubGlobal('fetch', fetchMock);

    const runs = await client().listCheckRuns('acme', 'web', 'deadbeef');

    expect(runs).toEqual([{ name: 'build' }, { name: 'test' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://api.github.com/repos/acme/web/commits/deadbeef/check-runs?per_page=100&filter=latest&page=2',
    );
  });

  it('stops paging check runs at maxPages rather than trusting the header forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ total_count: 1, check_runs: [{ name: 'build' }] }, 200, {
          link: '<https://api.github.com/repos/acme/web/commits/deadbeef/check-runs?page=2>; rel="next"',
        }),
      ),
    );

    await client().listCheckRuns('acme', 'web', 'deadbeef', 3);

    expect(fetch).toHaveBeenCalledTimes(3);
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

  it('PATCHes only the body — the refresh-on-push never touches the title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ number: 7, body: 'new body' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().updatePullRequest('acme', 'web', 7, { body: 'new body' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/repos/acme/web/pulls/7');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ body: 'new body' });
  });

  it('updates the branch with a PUT to /pulls/:number/update-branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Updating pull request branch.' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await client().updateBranch('acme', 'web', 7);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/pulls/7/update-branch',
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
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

describe('searchIssuesPage / listRepoLabels', () => {
  it('asks for an explicit page, at the given page size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [{ number: 1 }] }));
    vi.stubGlobal('fetch', fetchMock);

    await client().searchIssuesPage('is:issue is:open involves:@me', 3, 50);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('per_page=50&page=3');
  });

  it('reads hasNext off the Link header rather than a count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ items: [{ number: 1 }] }, 200, {
        link: '<https://api.github.com/search/issues?page=2>; rel="next"',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await client().searchIssuesPage('is:issue', 1, 50);
    expect(page.hasNext).toBe(true);
  });

  it('answers hasNext: false once there is no next link', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [] })));
    const page = await client().searchIssuesPage('is:issue', 1, 50);
    expect(page.hasNext).toBe(false);
  });

  it('lists a repository’s own labels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ name: 'bug' }]));
    vi.stubGlobal('fetch', fetchMock);

    const labels = await client().listRepoLabels('acme', 'web');

    expect(labels).toEqual([{ name: 'bug' }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/labels?per_page=100',
    );
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

  /**
   * A different endpoint from the one above, despite a pull request BEING an issue: the
   * conversation tab is the issue's, the line-by-line remarks are the pull request's. A PR
   * reviewed diff-first has all of its discussion in this one.
   */
  it('reads a pull request’s inline review comments from the pulls path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 1, path: 'src/app.ts' }]));
    vi.stubGlobal('fetch', fetchMock);
    const comments = await client().listReviewComments('acme', 'web', 7);
    expect(comments).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/pulls/7/comments?per_page=100',
    );
  });

  it('follows `Link: rel="next"` through the review comments, up to the cap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ id: 1 }], 200, {
        link: '<https://api.github.com/repos/acme/web/pulls/7/comments?page=2>; rel="next"',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const comments = await client().listReviewComments('acme', 'web', 7);

    expect(comments).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://api.github.com/repos/acme/web/pulls/7/comments?page=2',
    );
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

describe('graphqlRoot', () => {
  it('hangs github.com’s GraphQL endpoint off its own API host', () => {
    expect(graphqlRoot('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlRoot('https://api.github.com/')).toBe('https://api.github.com/graphql');
  });

  it('puts an Enterprise instance’s GraphQL endpoint at /api/graphql, not under /api/v3', () => {
    expect(graphqlRoot('https://github.acme.internal')).toBe(
      'https://github.acme.internal/api/graphql',
    );
    expect(graphqlRoot('https://github.acme.internal/api/v3')).toBe(
      'https://github.acme.internal/api/graphql',
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

describe('GitHubClient.createPullRequest', () => {
  it('POSTs to /pulls and reports the pull request it made', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 1,
        number: 12,
        title: 'Add SSO',
        state: 'open',
        draft: false,
        html_url: 'https://github.com/o/r/pull/12',
        head: { ref: 'feat/sso', repo: { id: 555 } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const created = await client().createPullRequest('o', 'r', {
      head: 'feat/sso',
      base: 'main',
      title: 'Add SSO',
      body: 'Closes o/r#3',
    });

    expect(created.existed).toBe(false);
    expect(created.pullRequest.number).toBe(12);
    // The numeric repository id the board keys its row on lives on `head.repo`.
    expect(created.pullRequest.head?.repo?.id).toBe(555);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.github.com/repos/o/r/pulls');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      head: 'feat/sso',
      base: 'main',
      title: 'Add SSO',
      body: 'Closes o/r#3',
      draft: false,
    });
  });

  it('treats "already exists" as a success and hands back the open one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { errors: [{ message: 'A pull request already exists for o:feat/sso.' }] },
          422,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1, number: 7, title: 'Add SSO', state: 'open', html_url: 'u' }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const created = await client().createPullRequest('o', 'r', {
      head: 'feat/sso',
      base: 'main',
      title: 'Add SSO',
    });

    expect(created.existed).toBe(true);
    expect(created.pullRequest.number).toBe(7);
    // The head must be owner-qualified or the list endpoint matches nothing at all.
    expect(String(fetchMock.mock.calls[1][0])).toContain('head=o%3Afeat%2Fsso');
  });

  it('re-throws a 422 that is NOT a duplicate, rather than hunting for a PR', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Validation Failed: base is invalid' }, 422));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createPullRequest('o', 'r', { head: 'x', base: 'nope', title: 't' }),
    ).rejects.toMatchObject({ status: 422 });
    // One call: no lookup was attempted for a PR that was never refused as a duplicate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-throws the original refusal when the duplicate cannot be found', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'A pull request already exists for o:x.' }] }, 422),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createPullRequest('o', 'r', { head: 'x', base: 'main', title: 't' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('pickMergeMethod', () => {
  it('prefers a plain merge commit when nothing says otherwise', () => {
    expect(pickMergeMethod({})).toBe('merge');
    expect(pickMergeMethod({ allow_merge_commit: true })).toBe('merge');
  });

  it('falls back to squash when merge commits are disabled', () => {
    expect(pickMergeMethod({ allow_merge_commit: false, allow_squash_merge: true })).toBe('squash');
  });

  it('falls back to rebase when both merge and squash are disabled', () => {
    expect(
      pickMergeMethod({
        allow_merge_commit: false,
        allow_squash_merge: false,
        allow_rebase_merge: true,
      }),
    ).toBe('rebase');
  });

  it('falls back to merge, and lets GitHub refuse, when all three are off', () => {
    expect(
      pickMergeMethod({
        allow_merge_commit: false,
        allow_squash_merge: false,
        allow_rebase_merge: false,
      }),
    ).toBe('merge');
  });
});

describe('GitHubClient.mergePullRequest', () => {
  it('PUTs to /pulls/:number/merge with the sha and the repo’s preferred method', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sha: 'deadbeef', merged: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().mergePullRequest('o', 'r', 7, 'deadbeef');

    expect(result.merged).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.github.com/repos/o/r/pulls/7');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/repos/o/r/pulls/7/merge');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ sha: 'deadbeef', merge_method: 'merge' });
  });

  it('falls back to squash when the repo disabled plain merge commits', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: {
            ref: 'main',
            repo: { id: 1, allow_merge_commit: false, allow_squash_merge: true },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sha: 'deadbeef', merged: true }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergePullRequest('o', 'r', 7);

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ merge_method: 'squash' });
  });

  it('surfaces a refused merge as a GitHubError carrying GitHub’s own message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ number: 7, state: 'open', base: { repo: { id: 1 } } }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Pull Request is not mergeable' }, 405));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().mergePullRequest('o', 'r', 7)).rejects.toMatchObject({ status: 405 });
  });

  it('splits a given message into commit_title and commit_message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sha: 'deadbeef', merged: true }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergePullRequest('o', 'r', 7, undefined, 'Add SSO\n\nCloses #3');

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      merge_method: 'merge',
      commit_title: 'Add SSO',
      commit_message: 'Closes #3',
    });
  });

  it('sends no commit_title/commit_message when the message is blank', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: { repo: { id: 1, allow_merge_commit: true } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sha: 'deadbeef', merged: true }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergePullRequest('o', 'r', 7, undefined, '   ');

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ merge_method: 'merge' });
  });

  it('never sends a message for rebase, even when one is given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: {
            repo: {
              id: 1,
              allow_merge_commit: false,
              allow_squash_merge: false,
              allow_rebase_merge: true,
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sha: 'deadbeef', merged: true }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergePullRequest('o', 'r', 7, undefined, 'Add SSO');

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ merge_method: 'rebase' });
  });
});

describe('GitHubClient.getMergeProposal', () => {
  it('asks GraphQL for the viewer-merge text, using the repo’s own preferred method', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: { ref: 'main', repo: { id: 1, allow_merge_commit: true } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                viewerMergeHeadlineText: 'Add SSO (#7)',
                viewerMergeBodyText: 'Closes #3',
              },
            },
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const proposal = await client().getMergeProposal('o', 'r', 7);

    expect(proposal).toEqual({ method: 'merge', message: 'Add SSO (#7)\n\nCloses #3' });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe('https://api.github.com/graphql');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent.variables).toEqual({ owner: 'o', repo: 'r', number: 7, mergeType: 'MERGE' });
    expect(sent.query).toContain('viewerMergeHeadlineText');
  });

  it('uses SQUASH as the mergeType when the repo prefers squash', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          state: 'open',
          base: { repo: { id: 1, allow_merge_commit: false, allow_squash_merge: true } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: { viewerMergeHeadlineText: 'Add SSO', viewerMergeBodyText: null },
            },
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const proposal = await client().getMergeProposal('o', 'r', 7);

    expect(proposal).toEqual({ method: 'squash', message: 'Add SSO' });
    const sent = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(sent.variables.mergeType).toBe('SQUASH');
  });

  it('never calls GraphQL for rebase — there is no merge commit to propose a message for', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        number: 7,
        state: 'open',
        base: {
          repo: {
            id: 1,
            allow_merge_commit: false,
            allow_squash_merge: false,
            allow_rebase_merge: true,
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const proposal = await client().getMergeProposal('o', 'r', 7);

    expect(proposal).toEqual({ method: 'rebase', message: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws a GitHubError when GraphQL answers 200 with an errors array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ number: 7, state: 'open', base: { repo: { id: 1 } } }))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Could not resolve to a PullRequest' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().getMergeProposal('o', 'r', 7)).rejects.toBeInstanceOf(GitHubError);
  });

  it('reports no message when the viewer-merge headline comes back null', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ number: 7, state: 'open', base: { repo: { id: 1 } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { repository: { pullRequest: { viewerMergeHeadlineText: null } } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await client().getMergeProposal('o', 'r', 7)).toEqual({
      method: 'merge',
      message: null,
    });
  });
});

describe('GitHubClient.listPullRequestFiles', () => {
  it('pages across two pages via Link, and reports truncated: false once the last has none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(pullRequestFilesPage1, 200, {
          link: '<https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(pullRequestFilesPage2, 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().listPullRequestFiles('acme', 'web', 7);

    expect(result.truncated).toBe(false);
    expect(result.files.map((f) => f.filename)).toEqual([
      'src/app.ts',
      'src/utils/format.ts',
      'assets/logo.png',
      'docs/old-notes.md',
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/pulls/7/files?per_page=100',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=2',
    );
  });

  it('reports truncated: true when the page cap stops it with a rel="next" still left', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(pullRequestFilesPage1, 200, {
          link: '<https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=2>; rel="next"',
        }),
      ),
    );

    const result = await client().listPullRequestFiles('acme', 'web', 7, 1);

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  it('carries a binary file through with patch === undefined and its other fields intact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(pullRequestFilesPage2, 200, {})));

    const result = await client().listPullRequestFiles('acme', 'web', 7);

    const binary = result.files.find((f) => f.filename === 'assets/logo.png');
    expect(binary?.patch).toBeUndefined();
    expect(binary).toMatchObject({
      sha: 'c3d4e5f60718293a4b5c6d7e8f901234567a1b2',
      status: 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
    });
  });

  it('carries a renamed file through with previous_filename', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(pullRequestFilesPage1, 200, {})));

    const result = await client().listPullRequestFiles('acme', 'web', 7);

    const renamed = result.files.find((f) => f.filename === 'src/utils/format.ts');
    expect(renamed?.previous_filename).toBe('src/format.ts');
    expect(renamed?.status).toBe('renamed');
  });
});

describe('GitHubClient.getRawFile', () => {
  it('encodes the path per segment, sends ?ref=, and asks for the raw media type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('export const x = 1;\n'));
    vi.stubGlobal('fetch', fetchMock);

    const text = await client().getRawFile('acme', 'web', 'src/app #1.ts', 'feature/x');

    expect(text).toBe('export const x = 1;\n');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      'https://api.github.com/repos/acme/web/contents/src/app%20%231.ts?ref=feature%2Fx',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github.raw+json');
  });

  it('keeps a literal / as a directory separator across segments', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('content'));
    vi.stubGlobal('fetch', fetchMock);

    await client().getRawFile('acme', 'web', 'src/components/Button.tsx', 'main');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/acme/web/contents/src/components/Button.tsx?ref=main',
    );
  });

  it('rejects a missing file at that ref with a GitHubError carrying status 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('{"message":"Not Found"}', 404)));

    await expect(client().getRawFile('acme', 'web', 'gone.ts', 'main')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client().getRawFile('acme', 'web', 'gone.ts', 'main')).rejects.toBeInstanceOf(
      GitHubError,
    );
  });
});

describe('GitHubClient.listReviewRequests', () => {
  it('sends the exact review-requested query with advanced_search=true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [], incomplete_results: false }));
    vi.stubGlobal('fetch', fetchMock);

    await client().listReviewRequests();

    const url = String(fetchMock.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain(
      'q=is:pr is:open review-requested:@me archived:false',
    );
    expect(url).toContain('advanced_search=true');
  });

  it('propagates truncated from incomplete_results: true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ items: [{ number: 1 }], incomplete_results: true })),
    );

    const result = await client().listReviewRequests();

    expect(result).toMatchObject({ incompleteResults: true, truncated: true });
  });

  it('propagates truncated from the page cap, even when GitHub says it was complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ items: [{ number: 1 }], incomplete_results: false }, 200, {
          link: '<https://api.github.com/search/issues?page=2>; rel="next"',
        }),
      ),
    );

    const result = await client().listReviewRequests(1);

    expect(result).toMatchObject({ incompleteResults: false, truncated: true });
  });
});
