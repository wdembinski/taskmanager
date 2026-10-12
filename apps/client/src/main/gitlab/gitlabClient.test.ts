import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient, GitLabError, toMergeRequestState, toPipelineStatus } from './gitlabClient';

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

const client = (): GitLabClient =>
  new GitLabClient({ baseUrl: 'https://gitlab.com/', token: 'glpat-x' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitLabClient', () => {
  it('authenticates with PRIVATE-TOKEN and builds /api/v4 URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, username: 'wd' }));
    vi.stubGlobal('fetch', fetchMock);
    await client().getMe();
    // Trailing slash on the base URL must not double up.
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gitlab.com/api/v4/user');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('glpat-x');
  });

  it('throws a GitLabError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: '401' }, 401)));
    await expect(client().getMe()).rejects.toBeInstanceOf(GitLabError);
    await expect(client().getMe()).rejects.toMatchObject({ status: 401 });
  });

  it('asks only for MRs it created, and follows x-next-page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ iid: 1 }], 200, { 'x-next-page': '2' }))
      .mockResolvedValueOnce(jsonResponse([{ iid: 2 }], 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const all = await client().listMyMergeRequests();
    expect(all.map((m) => m.iid)).toEqual([1, 2]);
    const first = String(fetchMock.mock.calls[0][0]);
    expect(first).toContain('scope=created_by_me');
    expect(first).toContain('state=opened');
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it('stops paging at the cap rather than trusting the server’s headers forever', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ iid: 1 }], 200, { 'x-next-page': '2' }));
    vi.stubGlobal('fetch', fetchMock);
    await client().listMyMergeRequests(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('drops system notes — the tool talking to itself is not a comment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 1, body: 'looks good', created_at: 'x', system: false },
        { id: 2, body: 'changed title', created_at: 'x', system: true },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const notes = await client().listNotes(9, 1);
    expect(notes.map((n) => n.id)).toEqual([1]);
  });

  it('returns an empty reviewer list rather than throwing on an old instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' })));
    expect(await client().getReviewers(9, 1)).toEqual([]);
  });

  it('rebases with a PUT to /merge_requests/:iid/rebase', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rebase_in_progress: true }, 202));
    vi.stubGlobal('fetch', fetchMock);
    await client().rebaseMergeRequest(42, 12);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/42/merge_requests/12/rebase',
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
  });

  it('merges with a PUT to /merge_requests/:iid/merge, sending the sha when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12, 'deadbeef');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/42/merge_requests/12/merge');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ sha: 'deadbeef' });
  });

  it('merges with no body at all when no sha is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it('surfaces a refused merge as a GitLabError carrying GitLab’s own message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Method Not Allowed' }, 405)),
    );
    await expect(client().mergeMergeRequest(42, 12)).rejects.toMatchObject({
      status: 405,
    });
    await expect(client().mergeMergeRequest(42, 12)).rejects.toBeInstanceOf(GitLabError);
  });

  it('sends merge_commit_message when a message is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12, undefined, { message: 'Add SSO\n\nCloses #3' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ merge_commit_message: 'Add SSO\n\nCloses #3' });
  });

  it('sends squash plus squash_commit_message when squashing with a message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12, 'deadbeef', { message: 'Add SSO', squash: true });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      sha: 'deadbeef',
      squash: true,
      squash_commit_message: 'Add SSO',
    });
  });

  it('sends squash with no squash_commit_message when the message is blank', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12, undefined, { squash: true, message: '  ' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ squash: true });
  });

  it('updates only the description — the refresh-on-push never touches the title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, description: 'new' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().updateMergeRequest('g/s/p', 12, { description: 'new' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/g%2Fs%2Fp/merge_requests/12');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ description: 'new' });
  });
});

describe('state and pipeline narrowing', () => {
  it('keeps the states GitLab really reports and treats anything else as closed', () => {
    expect(toMergeRequestState('opened')).toBe('opened');
    expect(toMergeRequestState('merged')).toBe('merged');
    expect(toMergeRequestState('locked')).toBe('locked');
    expect(toMergeRequestState('closed')).toBe('closed');
    expect(toMergeRequestState(undefined)).toBe('closed');
  });

  it('normalises both spellings of cancelled, and is honest about unknown', () => {
    expect(toPipelineStatus('cancelled')).toBe('canceled');
    expect(toPipelineStatus('canceled')).toBe('canceled');
    expect(toPipelineStatus('failed')).toBe('failed');
    expect(toPipelineStatus(null)).toBe('unknown');
    expect(toPipelineStatus('who-knows')).toBe('unknown');
  });
});

describe('GitLabClient.createMergeRequest', () => {
  it('POSTs to the URL-ENCODED project path, so no id lookup is needed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 90,
        iid: 12,
        project_id: 42,
        title: 'Add SSO',
        state: 'opened',
        web_url: 'https://gitlab.com/g/s/p/-/merge_requests/12',
        source_branch: 'feat/sso',
        target_branch: 'main',
        updated_at: '2026-08-15T00:00:00Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const created = await client().createMergeRequest('g/s/p', {
      source_branch: 'feat/sso',
      target_branch: 'main',
      title: 'Add SSO',
      description: 'body',
    });

    expect(created.existed).toBe(false);
    expect(created.mergeRequest.iid).toBe(12);
    expect(created.mergeRequest.project_id).toBe(42);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/g%2Fs%2Fp/merge_requests',
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      source_branch: 'feat/sso',
      target_branch: 'main',
      title: 'Add SSO',
      description: 'body',
      remove_source_branch: false,
    });
  });

  it('treats a 409 "already exists" as a success and hands back the open one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { message: ['Another open merge request already exists for this source branch: !5'] },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1, iid: 5, project_id: 42, state: 'opened', web_url: 'u' }]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const created = await client().createMergeRequest('g/p', {
      source_branch: 'feat/sso',
      target_branch: 'main',
      title: 'Add SSO',
    });

    expect(created.existed).toBe(true);
    expect(created.mergeRequest.iid).toBe(5);
    expect(String(fetchMock.mock.calls[1][0])).toContain('source_branch=feat%2Fsso');
  });

  it('re-throws a 409 that is not a duplicate merge request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Base branch is protected' }, 409));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client().createMergeRequest('g/p', {
        source_branch: 'x',
        target_branch: 'main',
        title: 't',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps every read a read — a create failure never falls back to a GET of the list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'forbidden' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      client().createMergeRequest('g/p', { source_branch: 'x', target_branch: 'y', title: 't' }),
    ).rejects.toBeInstanceOf(GitLabError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GitLabClient.getMergeProposal', () => {
  it('POSTs to /api/graphql, not /api/v4, with PRIVATE-TOKEN auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          project: {
            mergeMethod: 'MERGE',
            mergeRequest: {
              defaultMergeCommitMessage: 'Add SSO\n\nCloses #3',
              defaultSquashCommitMessage: null,
              squashOnMerge: false,
            },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const proposal = await client().getMergeProposal('g/s/p', 12);

    expect(proposal).toEqual({ method: 'merge', message: 'Add SSO\n\nCloses #3' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://gitlab.com/api/graphql');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('glpat-x');
    const sent = JSON.parse(String(init.body));
    expect(sent.variables).toEqual({ fullPath: 'g/s/p', iid: '12' });
    expect(sent.query).toContain('defaultMergeCommitMessage');
  });

  it('reports squash when the project squashes on merge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            project: {
              mergeMethod: 'MERGE',
              mergeRequest: {
                defaultMergeCommitMessage: 'merge msg',
                defaultSquashCommitMessage: 'squash msg',
                squashOnMerge: true,
              },
            },
          },
        }),
      ),
    );

    expect(await client().getMergeProposal('g/p', 12)).toEqual({
      method: 'squash',
      message: 'squash msg',
    });
  });

  it('reports ff with no message for a fast-forward-only project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            project: {
              mergeMethod: 'FF',
              mergeRequest: { defaultMergeCommitMessage: 'merge msg', squashOnMerge: false },
            },
          },
        }),
      ),
    );

    expect(await client().getMergeProposal('g/p', 12)).toEqual({ method: 'ff', message: null });
  });

  it('throws a GitLabError when GraphQL answers 200 with an errors array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'not found' }] })),
    );
    await expect(client().getMergeProposal('g/p', 12)).rejects.toBeInstanceOf(GitLabError);
  });
});
