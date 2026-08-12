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
