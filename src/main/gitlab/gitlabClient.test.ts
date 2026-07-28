import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitLabClient,
  GitLabError,
  toMergeRequestState,
  toPipelineStatus,
} from './gitlabClient';

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
