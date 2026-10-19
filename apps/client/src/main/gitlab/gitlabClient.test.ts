import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient, GitLabError, toMergeRequestState, toPipelineStatus } from './gitlabClient';
import { mergeRequestChangesBody, mergeRequestDiffsPage1 } from './__fixtures__/mergeRequestDiffs';

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

function bytesResponse(
  bytes: Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    json: async () => JSON.parse(Buffer.from(bytes).toString('utf8')),
    text: async () => Buffer.from(bytes).toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
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

  it('lists a project’s issues at the URL-encoded path, following x-next-page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ iid: 1 }], 200, { 'x-next-page': '2' }));
    vi.stubGlobal('fetch', fetchMock);

    const { issues, nextPage } = await client().listIssues('acme/web', {
      state: 'opened',
      labels: ['bug', 'urgent'],
      search: 'crash',
      page: 1,
      perPage: 50,
    });

    expect(issues.map((i) => i.iid)).toEqual([1]);
    expect(nextPage).toBe('2');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/projects/acme%2Fweb/issues?');
    expect(url).toContain('state=opened');
    expect(url).toContain('labels=bug%2Curgent');
    expect(url).toContain('search=crash');
    expect(url).toContain('page=1');
    expect(url).toContain('per_page=50');
  });

  it('lists issues assigned to the signed-in user across the instance when there is no project', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([], 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await client().listIssues(null, { state: 'opened', page: 1, perPage: 50 });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v4/issues?scope=assigned_to_me&');
  });

  it('treats an empty x-next-page header the same as a missing one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([], 200, { 'x-next-page': '' }));
    vi.stubGlobal('fetch', fetchMock);

    const { nextPage } = await client().listIssues(null, { state: 'opened', page: 1, perPage: 50 });
    expect(nextPage).toBeNull();
  });

  it('lists a project’s labels at the URL-encoded path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ name: 'bug' }]));
    vi.stubGlobal('fetch', fetchMock);

    const labels = await client().listProjectLabels('acme/web');
    expect(labels).toEqual([{ name: 'bug' }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fweb/labels?per_page=100',
    );
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

  it('sends should_remove_source_branch when asked to delete the source branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12, 'deadbeef', {
      squash: true,
      shouldRemoveSourceBranch: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/42/merge_requests/12/merge');
    expect(JSON.parse(String(init.body))).toEqual({
      sha: 'deadbeef',
      should_remove_source_branch: true,
      squash: true,
    });
  });

  it('leaves should_remove_source_branch out when not asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'merged' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().mergeMergeRequest(42, 12, 'deadbeef', { shouldRemoveSourceBranch: false });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ sha: 'deadbeef' });
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

describe('GitLabClient.getMergeRequest', () => {
  it('surfaces diff_refs from a recorded detail body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 1,
          iid: 7,
          project_id: 42,
          title: 't',
          state: 'opened',
          web_url: 'u',
          source_branch: 'feat',
          target_branch: 'main',
          updated_at: 'x',
          diff_refs: {
            base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            start_sha: 'cccccccccccccccccccccccccccccccccccccccc',
          },
        }),
      ),
    );

    const mr = await client().getMergeRequest(42, 7);

    expect(mr.diff_refs).toEqual({
      base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      start_sha: 'cccccccccccccccccccccccccccccccccccccccc',
    });
  });
});

describe('GitLabClient.listMergeRequestDiffs', () => {
  it('pages /diffs via x-next-page and reports truncated: false once the last page has none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(mergeRequestDiffsPage1, 200, { 'x-next-page': '2' }))
      .mockResolvedValueOnce(jsonResponse([], 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().listMergeRequestDiffs(42, 7);

    expect(result.endpoint).toBe('diffs');
    expect(result.truncated).toBe(false);
    expect(result.diffs.map((d) => d.new_path)).toEqual(['src/app.ts', 'src/utils/format.ts']);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/diffs?per_page=100&page=1',
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/diffs?per_page=100&page=2',
    );
  });

  it('reports truncated: true when the page cap stops it with a next page still on offer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(mergeRequestDiffsPage1, 200, { 'x-next-page': '2' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().listMergeRequestDiffs(42, 7, 1);

    expect(result.truncated).toBe(true);
    expect(result.diffs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to /changes on a 404 from the first page, mapping changes to diffs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: '404 Merge Request Not Found' }, 404))
      .mockResolvedValueOnce(jsonResponse(mergeRequestChangesBody));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().listMergeRequestDiffs(42, 7);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.endpoint).toBe('changes');
    expect(result.truncated).toBe(true);
    expect(result.diffs.map((d) => d.new_path)).toEqual(['assets/logo.png', 'docs/old-notes.md']);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/changes',
    );
  });

  it('does not fall back to /changes on a non-404 error from /diffs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().listMergeRequestDiffs(42, 7)).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a 404 from /changes too, rather than swallowing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().listMergeRequestDiffs(42, 7)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a 404 on a LATER page rather than falling back — only the first page does', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(mergeRequestDiffsPage1, 200, { 'x-next-page': '2' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().listMergeRequestDiffs(42, 7)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes a too_large entry with an empty diff through untouched', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: '404' }, 404))
      .mockResolvedValueOnce(jsonResponse(mergeRequestChangesBody));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().listMergeRequestDiffs(42, 7);

    const tooLarge = result.diffs.find((d) => d.new_path === 'assets/logo.png');
    expect(tooLarge).toMatchObject({ too_large: true, diff: '' });
  });
});

describe('GitLabClient.getRawFile', () => {
  it('URL-encodes the whole path as one %2F-joined segment and carries ?ref=', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('export const x = 1;\n'));
    vi.stubGlobal('fetch', fetchMock);

    const text = await client().getRawFile(42, 'src/components/Button.tsx', 'feature/x');

    expect(text).toBe('export const x = 1;\n');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/42/repository/files/src%2Fcomponents%2FButton.tsx/raw?ref=feature%2Fx',
    );
  });

  it('accepts a URL-encoded project path as well as a numeric id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('content'));
    vi.stubGlobal('fetch', fetchMock);

    await client().getRawFile('g/s/p', 'README.md', 'main');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/g%2Fs%2Fp/repository/files/README.md/raw?ref=main',
    );
  });

  it('rejects a missing file at that ref with a GitLabError carrying status 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse('{"message":"404 File Not Found"}', 404)),
    );

    await expect(client().getRawFile(42, 'gone.ts', 'main')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client().getRawFile(42, 'gone.ts', 'main')).rejects.toBeInstanceOf(GitLabError);
  });
});

describe('GitLabClient.getRawFileBytes', () => {
  it('round-trips non-UTF-8 bytes (a PNG header) unchanged', async () => {
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn().mockResolvedValue(bytesResponse(pngHeader));
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await client().getRawFileBytes(42, 'assets/logo.png', 'main');

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(Uint8Array.from(bytes)).toEqual(pngHeader);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://gitlab.com/api/v4/projects/42/repository/files/assets%2Flogo.png/raw?ref=main',
    );
  });

  it('rejects a missing file at that ref with a GitLabError carrying status 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          bytesResponse(new TextEncoder().encode('{"message":"404 File Not Found"}'), 404),
        ),
    );

    await expect(client().getRawFileBytes(42, 'gone.png', 'main')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client().getRawFileBytes(42, 'gone.png', 'main')).rejects.toBeInstanceOf(
      GitLabError,
    );
  });
});

describe('GitLabClient.listReviewerMergeRequests', () => {
  it('sends reviewer_username, scope=all (the default would hide them) and state=opened', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ iid: 1 }], 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await client().listReviewerMergeRequests('wd');

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/merge_requests?reviewer_username=wd');
    expect(url).toContain('scope=all');
    expect(url).toContain('state=opened');
  });

  it('pages via x-next-page and reports truncated at the cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ iid: 1 }], 200, { 'x-next-page': '2' }));
    vi.stubGlobal('fetch', fetchMock);

    const { mergeRequests, truncated } = await client().listReviewerMergeRequests('wd', 1);

    expect(mergeRequests).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('reports truncated: false once the last page has no next-page header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ iid: 1 }], 200, { 'x-next-page': '2' }))
      .mockResolvedValueOnce(jsonResponse([{ iid: 2 }], 200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const { mergeRequests, truncated } = await client().listReviewerMergeRequests('wd');

    expect(mergeRequests.map((m) => m.iid)).toEqual([1, 2]);
    expect(truncated).toBe(false);
  });
});

describe('GitLabClient.enableAutoMerge', () => {
  it('PUTs merge_when_pipeline_succeeds, auto_merge and squash to :iid/merge', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ iid: 12, state: 'opened' }))
      .mockResolvedValueOnce(jsonResponse({ iid: 12, state: 'opened' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().enableAutoMerge('g/p', 12, { squash: true });

    expect(result).toBe('enabled');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/12/merge');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      merge_when_pipeline_succeeds: true,
      auto_merge: true,
      squash: true,
    });
  });

  it('omits squash when it was not given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ iid: 12, state: 'opened' }))
      .mockResolvedValueOnce(jsonResponse({ iid: 12, state: 'opened' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().enableAutoMerge('g/p', 12);

    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      merge_when_pipeline_succeeds: true,
      auto_merge: true,
    });
  });

  it('skips the PUT and reports already when the MR is already flagged', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ iid: 12, state: 'opened', merge_when_pipeline_succeeds: true }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().enableAutoMerge('g/p', 12, { squash: true });

    expect(result).toBe('already');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GitLabClient.cancelAutoMerge', () => {
  it('POSTs to cancel_merge_when_pipeline_succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ iid: 12, state: 'opened' }));
    vi.stubGlobal('fetch', fetchMock);

    await client().cancelAutoMerge('g/p', 12);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      'https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/12/cancel_merge_when_pipeline_succeeds',
    );
    expect(init.method).toBe('POST');
  });
});

describe('GitLabClient.getAutoMergeFacts', () => {
  it('reads only_allow_merge_if_pipeline_succeeds off GET /projects/:id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 42, only_allow_merge_if_pipeline_succeeds: true }));
    vi.stubGlobal('fetch', fetchMock);

    const facts = await client().getAutoMergeFacts('g/p');

    expect(facts).toEqual({ onlyAllowMergeIfPipelineSucceeds: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gitlab.com/api/v4/projects/g%2Fp');
  });

  it('reports null on an instance too old to send the field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 42 })));

    const facts = await client().getAutoMergeFacts('g/p');

    expect(facts).toEqual({ onlyAllowMergeIfPipelineSucceeds: null });
  });
});

describe('GitLabClient.getProjectMergeSettings', () => {
  it('reads remove_source_branch_after_merge off GET /projects/:id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 42, remove_source_branch_after_merge: true }));
    vi.stubGlobal('fetch', fetchMock);

    const settings = await client().getProjectMergeSettings('g/p');

    expect(settings).toEqual({ removeSourceBranchAfterMerge: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gitlab.com/api/v4/projects/g%2Fp');
  });

  it('reports null on an instance too old to send the field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 42 })));

    const settings = await client().getProjectMergeSettings('g/p');

    expect(settings).toEqual({ removeSourceBranchAfterMerge: null });
  });
});
