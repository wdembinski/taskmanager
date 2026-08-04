import { afterEach, describe, expect, it, vi } from 'vitest';
import { JiraClient, JiraError, authHeader, commentBodyToText } from './jiraClient';
import { buildClientConfig } from './jiraConfig';
import { DEFAULT_JIRA_SETTINGS } from '@shared/settings';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const serverClient = () =>
  new JiraClient({
    baseUrl: 'https://jira.company.com',
    apiVersion: '2',
    auth: { mode: 'bearer', token: 'pat-123' },
  });

const cloudClient = () =>
  new JiraClient({
    baseUrl: 'https://acme.atlassian.net',
    apiVersion: '3',
    auth: { mode: 'basic', token: 'tok', email: 'me@x.com' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authHeader', () => {
  it('builds a Bearer header for server/DC PAT', () => {
    expect(authHeader({ mode: 'bearer', token: 'abc' })).toBe('Bearer abc');
  });
  it('builds a Basic header (base64 email:token) for cloud', () => {
    const expected = `Basic ${Buffer.from('me@x.com:tok').toString('base64')}`;
    expect(authHeader({ mode: 'basic', token: 'tok', email: 'me@x.com' })).toBe(expected);
  });
});

describe('buildClientConfig', () => {
  it('maps server settings to Bearer + v2', () => {
    const cfg = buildClientConfig(
      { ...DEFAULT_JIRA_SETTINGS, deployment: 'server', baseUrl: 'https://j' },
      'pat',
    );
    expect(cfg).toMatchObject({ apiVersion: '2', auth: { mode: 'bearer', token: 'pat' } });
  });
  it('maps cloud settings to Basic + v3 with email', () => {
    const cfg = buildClientConfig(
      { ...DEFAULT_JIRA_SETTINGS, deployment: 'cloud', baseUrl: 'https://j', cloudEmail: 'a@b' },
      'tok',
    );
    expect(cfg).toMatchObject({
      apiVersion: '3',
      auth: { mode: 'basic', token: 'tok', email: 'a@b' },
    });
  });

  it('normalizes the base URL, so a scheme-less paste still builds valid request URLs', () => {
    const cfg = buildClientConfig(
      {
        ...DEFAULT_JIRA_SETTINGS,
        deployment: 'cloud',
        baseUrl: 'acme.atlassian.net/jira/your-work',
        cloudEmail: ' a@b ',
      },
      'tok',
    );
    expect(cfg.baseUrl).toBe('https://acme.atlassian.net');
    // A stray space around the email would corrupt the base64 Basic credential.
    expect(cfg.auth).toMatchObject({ email: 'a@b' });
  });
});

describe('JiraClient.testConnection', () => {
  it('GETs /myself at the right version with the auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ displayName: 'Ada' }));
    vi.stubGlobal('fetch', fetchMock);

    const me = await serverClient().testConnection();
    expect(me.displayName).toBe('Ada');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://jira.company.com/rest/api/2/myself');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pat-123');
  });

  it('throws a JiraError with the status on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401)));
    await expect(serverClient().testConnection()).rejects.toBeInstanceOf(JiraError);
  });

  it("captures JIRA DC's X-Authentication-Denied-Reason, the only clue a 403 CAPTCHA gives", async () => {
    const res = {
      ...jsonResponse({}, 403),
      headers: { get: (n: string) => (n === 'x-authentication-denied-reason' ? 'CAPTCHA' : null) },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    await expect(serverClient().testConnection()).rejects.toMatchObject({
      status: 403,
      deniedReason: 'CAPTCHA',
    });
  });
});

describe('JiraClient.search', () => {
  it('sends the JQL + board fields and returns the issues array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ issues: [{ id: '1', key: 'AB-1', fields: {} }] }));
    vi.stubGlobal('fetch', fetchMock);

    const issues = await serverClient().search('assignee = currentUser()');
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe('AB-1');

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/rest/api/2/search?');
    expect(url).toContain('jql=assignee');
    expect(url).toContain('fields=summary');
    expect(url).toContain('status');
    expect(url).toContain('comment');
    // Needed for agent delegation: the ticket brief and the team-managed epic.
    expect(url).toContain('description');
    expect(url).toContain('parent');
  });

  it('appends runtime-discovered extra fields (the Epic Link custom field)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await serverClient().search('assignee = currentUser()', 50, ['customfield_10008', '  ']);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('maxResults')).toBe('50');
    const fields = (url.searchParams.get('fields') ?? '').split(',');
    expect(fields).toContain('customfield_10008');
    // Blank entries are dropped rather than sent as an empty field name.
    expect(fields).not.toContain('');
  });

  // Atlassian removed /rest/api/3/search from Cloud; it answers with a "migrate to
  // /rest/api/3/search/jql" error, which is what a Cloud user actually saw.
  it('uses the enhanced /search/jql endpoint on cloud', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ issues: [{ id: '1', key: 'AB-1', fields: {} }] }));
    vi.stubGlobal('fetch', fetchMock);

    const issues = await cloudClient().search('assignee = currentUser()');
    expect(issues).toHaveLength(1);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/rest/api/3/search/jql?');
    expect(url).toContain('fields=summary');
  });

  it('follows nextPageToken on cloud, because a page can come back short', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ issues: [{ id: '1', key: 'AB-1', fields: {} }], nextPageToken: 'tok-2' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ issues: [{ id: '2', key: 'AB-2', fields: {} }], isLast: true }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const issues = await cloudClient().search('assignee = currentUser()');
    expect(issues.map((i) => i.key)).toEqual(['AB-1', 'AB-2']);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('nextPageToken')).toBe(
      'tok-2',
    );
  });

  it('stops at maxResults rather than paging the whole backlog', async () => {
    const page = (key: string): Response =>
      jsonResponse({ issues: [{ id: key, key, fields: {} }], nextPageToken: `after-${key}` });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page('AB-1'))
      .mockResolvedValueOnce(page('AB-2'))
      .mockResolvedValue(page('AB-3'));
    vi.stubGlobal('fetch', fetchMock);

    const issues = await cloudClient().search('assignee = currentUser()', 2);
    expect(issues.map((i) => i.key)).toEqual(['AB-1', 'AB-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // An empty page that still carries a token is a documented quirk of this endpoint,
  // so "no issues" can't be the stop condition — only the page cap ends this.
  it('gives up after the page cap when the server keeps handing out tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [], nextPageToken: 'tok' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cloudClient().search('assignee = currentUser()')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });
});

describe('JiraClient.searchAll', () => {
  const issue = (key: string): { id: string; key: string; fields: object } => ({
    id: key,
    key,
    fields: {},
  });
  const issues = (
    from: number,
    count: number,
  ): Array<{ id: string; key: string; fields: object }> =>
    Array.from({ length: count }, (_, i) => issue(`AB-${from + i}`));
  const startAtOf = (call: unknown[]): string | null =>
    new URL(String(call[0])).searchParams.get('startAt');

  // The classic paging bug: the server caps the page below what we asked for, and an
  // offset advanced by the REQUESTED size skips every issue in the gap.
  it('v2 pages by startAt, advancing by what the server returned rather than what we asked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issues: issues(1, 50), total: 120 }))
      .mockResolvedValueOnce(jsonResponse({ issues: issues(51, 50), total: 120 }))
      .mockResolvedValueOnce(jsonResponse({ issues: issues(101, 20), total: 120 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverClient().searchAll('project = AB', { limit: 300 });
    expect(result.issues).toHaveLength(120);
    expect(result.issues[119].key).toBe('AB-120');
    expect(result.truncated).toBe(false);
    // Asked for 100, given 50 — the next window starts at 50, not at 100.
    expect(startAtOf(fetchMock.mock.calls[0])).toBe('0');
    expect(startAtOf(fetchMock.mock.calls[1])).toBe('50');
    expect(startAtOf(fetchMock.mock.calls[2])).toBe('100');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // Every pre-paging mock (and some proxies) answer without `total`. With no claim to
  // contradict it, one page IS the answer — otherwise every existing caller would start
  // making a second, pointless request.
  it('v2 stops after one call when the response carries no total', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: issues(1, 2) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverClient().searchAll('project = AB');
    expect(result).toEqual({ issues: [issue('AB-1'), issue('AB-2')], truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('v2 reports truncated when the limit cuts the answer short, and not when it just fits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ issues: issues(1, 50), total: 120 })),
    );
    const cut = await serverClient().searchAll('project = AB', { limit: 50 });
    expect(cut.issues).toHaveLength(50);
    expect(cut.truncated).toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ issues: issues(1, 50), total: 50 })),
    );
    const whole = await serverClient().searchAll('project = AB', { limit: 50 });
    expect(whole.issues).toHaveLength(50);
    expect(whole.truncated).toBe(false);
  });

  // An offset loop that trusts `total` over the issues in hand never terminates.
  it('v2 stops on an empty page even when total claims there is more', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issues: issues(1, 10), total: 500 }))
      .mockResolvedValue(jsonResponse({ issues: [], total: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverClient().searchAll('project = AB', { limit: 300 });
    expect(result.issues).toHaveLength(10);
    // The answer was short of what the server itself claimed — the caller must not read
    // the 490 missing issues as 490 deletions.
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('v3 follows tokens past the 100-issue page, up to the limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issues: issues(1, 100), nextPageToken: 'tok-2' }))
      .mockResolvedValueOnce(jsonResponse({ issues: issues(101, 100), nextPageToken: 'tok-3' }))
      .mockResolvedValueOnce(jsonResponse({ issues: issues(201, 20), isLast: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await cloudClient().searchAll('project = AB', { limit: 300 });
    expect(result.issues).toHaveLength(220);
    expect(result.truncated).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('nextPageToken')).toBe(
      'tok-2',
    );
  });

  it('v3 reports truncated when it stops at the limit with a token still in hand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ issues: issues(1, 100), nextPageToken: 'more' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await cloudClient().searchAll('project = AB', { limit: 100 });
    expect(result.issues).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The page cap is the only thing that ends this, and reaching it is a truncation:
  // there is a token in hand and no way to know what is behind it.
  it('v3 gives up at the page cap when the server hands out tokens forever', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [], nextPageToken: 'tok' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await cloudClient().searchAll('project = AB', { limit: 300 });
    expect(result.issues).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });

  it('carries the extra fields through, exactly as search does', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await serverClient().searchAll('project = AB', { extraFields: ['customfield_10008', ' '] });
    const fields = (
      new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('fields') ?? ''
    ).split(',');
    expect(fields).toContain('customfield_10008');
    expect(fields).not.toContain('');
  });
});

describe('JiraClient.listFields', () => {
  it('GETs /field and returns the array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: 'customfield_1', name: 'Epic Link' }]));
    vi.stubGlobal('fetch', fetchMock);

    const fields = await serverClient().listFields();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/api/2/field');
    expect(fields).toEqual([{ id: 'customfield_1', name: 'Epic Link' }]);
  });
});

describe('JiraClient.addComment', () => {
  it('posts a plain-string body on v2', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '10' }));
    vi.stubGlobal('fetch', fetchMock);
    await serverClient().addComment('AB-1', 'hello');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ body: 'hello' });
  });

  it('wraps the body in ADF on v3', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '10' }));
    vi.stubGlobal('fetch', fetchMock);
    const cloud = new JiraClient({
      baseUrl: 'https://x.atlassian.net',
      apiVersion: '3',
      auth: { mode: 'basic', token: 't', email: 'e' },
    });
    await cloud.addComment('AB-1', 'hello');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.body.type).toBe('doc');
    expect(body.body.content[0].content[0].text).toBe('hello');
  });
});

describe('commentBodyToText', () => {
  it('returns a plain string unchanged', () => {
    expect(commentBodyToText('just text')).toBe('just text');
  });
  it('flattens an ADF document to text', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'line one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'line two' }] },
      ],
    };
    expect(commentBodyToText(adf)).toContain('line one');
    expect(commentBodyToText(adf)).toContain('line two');
  });
});

describe('setPriority', () => {
  it('PUTs the issue with the priority name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 204));
    await serverClient().setPriority('AB-1', 'Highest');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://jira.company.com/rest/api/2/issue/AB-1');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      fields: { priority: { name: 'Highest' } },
    });
  });

  it('surfaces a rejection, so the caller can leave the card alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ errors: {} }, 400));
    await expect(serverClient().setPriority('AB-1', 'Nope')).rejects.toBeInstanceOf(JiraError);
  });
});

describe('listPriorities', () => {
  it('reads the plain array Server/DC returns', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([{ name: 'Highest' }, { name: 'Low' }]));
    expect(await serverClient().listPriorities()).toEqual(['Highest', 'Low']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://jira.company.com/rest/api/2/priority');
  });

  it('reads the paged shape Cloud returns', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ values: [{ name: 'High' }] }));
    expect(await cloudClient().listPriorities()).toEqual(['High']);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://acme.atlassian.net/rest/api/3/priority/search',
    );
  });

  it('is empty rather than broken when the payload is not what we expect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ nope: true }));
    expect(await serverClient().listPriorities()).toEqual([]);
  });
});

describe('listStatuses', () => {
  it('reads the classic flat array, whose category is an object', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        { name: 'To Do', statusCategory: { key: 'new' } },
        { name: 'Code Review', statusCategory: { key: 'indeterminate' } },
        { name: 'Closed', statusCategory: { key: 'done' } },
      ]),
    );
    expect(await serverClient().listStatuses()).toEqual([
      { name: 'To Do', categoryKey: 'new' },
      { name: 'Code Review', categoryKey: 'indeterminate' },
      { name: 'Closed', categoryKey: 'done' },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://jira.company.com/rest/api/2/status');
  });

  // Cloud's newer endpoint pages its results and flattens the category to a string
  // enum; both shapes have to normalise to the same key or the map would mis-bucket.
  it('falls back to the paged endpoint, whose category is a string enum', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ message: 'gone' }, 410))
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            { name: 'Backlog', statusCategory: 'TODO' },
            { name: 'In Review', statusCategory: 'IN_PROGRESS' },
            { name: 'Done', statusCategory: 'DONE' },
          ],
        }),
      );
    expect(await cloudClient().listStatuses()).toEqual([
      { name: 'Backlog', categoryKey: 'new' },
      { name: 'In Review', categoryKey: 'indeterminate' },
      { name: 'Done', categoryKey: 'done' },
    ]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/statuses/search');
  });

  it('drops entries with no usable name, and defaults an unknown category to To Do', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([{ name: '' }, { id: '9' }, { name: 'Odd', statusCategory: { key: 42 } }]),
    );
    expect(await serverClient().listStatuses()).toEqual([{ name: 'Odd', categoryKey: 'new' }]);
  });
});

describe('JiraClient.addComment — mentions and attachments', () => {
  it('sends a mention node on v3 and wiki markup on v2', async () => {
    const mentions = [{ start: 0, end: 6, accountId: 'acc-a', displayName: 'Alice' }];

    const cloudFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '10' }));
    vi.stubGlobal('fetch', cloudFetch);
    await cloudClient().addComment('AB-1', '@Alice look', mentions);
    const cloudBody = JSON.parse((cloudFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(cloudBody.body.content[0].content[0]).toEqual({
      type: 'mention',
      attrs: { id: 'acc-a', text: '@Alice' },
    });

    const serverFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '10' }));
    vi.stubGlobal('fetch', serverFetch);
    await serverClient().addComment('AB-1', '@Alice look', mentions);
    const serverBody = JSON.parse((serverFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(serverBody).toEqual({ body: '[~acc-a] look' });
  });
});

describe('JiraClient.searchUsers', () => {
  it('uses `query` on v3 and `username` on v2, and normalizes both shapes', async () => {
    const cloudFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ accountId: 'acc-a', displayName: 'Alice', emailAddress: 'a@x.com' }]),
      );
    vi.stubGlobal('fetch', cloudFetch);
    const cloud = await cloudClient().searchUsers('ali');
    expect(String(cloudFetch.mock.calls[0][0])).toContain('query=ali');
    expect(cloud[0]).toMatchObject({ accountId: 'acc-a', name: null, displayName: 'Alice' });

    const serverFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ name: 'alice', displayName: 'Alice' }]));
    vi.stubGlobal('fetch', serverFetch);
    const server = await serverClient().searchUsers('ali');
    expect(String(serverFetch.mock.calls[0][0])).toContain('username=ali');
    expect(server[0]).toMatchObject({ accountId: null, name: 'alice' });
  });

  it('asks the assignable endpoint when an issue key is known', async () => {
    // Global user search is permission-restricted on many Cloud sites; the per-issue
    // endpoint is the one an ordinary commenter can actually use.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await cloudClient().searchUsers('ali', 'AB-1');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/user/assignable/search');
    expect(url).toContain('issueKey=AB-1');
  });

  it('returns nothing for a blank query without calling out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await cloudClient().searchUsers('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JiraClient.uploadAttachments', () => {
  it('sends multipart with the XSRF header and NO hand-written Content-Type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: '5', filename: 'log.txt', size: 3 }]));
    vi.stubGlobal('fetch', fetchMock);

    const out = await cloudClient().uploadAttachments('AB-1', [
      { filename: 'log.txt', data: new Uint8Array([104, 105, 33]) },
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // fetch writes Content-Type itself, including the boundary; a hand-written one has
    // no boundary and JIRA rejects the body.
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['X-Atlassian-Token']).toBe('no-check');
    expect(init.body).toBeInstanceOf(FormData);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/issue/AB-1/attachments');
    expect(out[0]).toMatchObject({ id: '5', filename: 'log.txt', size: 3 });
  });

  it('does not call out at all when there is nothing to upload', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await cloudClient().uploadAttachments('AB-1', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JiraClient — creating an issue', () => {
  it('lists projects from the paged Cloud endpoint and the flat Server one', async () => {
    const cloudFetch = vi.fn().mockResolvedValue(jsonResponse({ values: [] }));
    vi.stubGlobal('fetch', cloudFetch);
    await cloudClient().listProjects('eng');
    const cloudUrl = String(cloudFetch.mock.calls[0][0]);
    expect(cloudUrl).toContain('/project/search');
    expect(cloudUrl).toContain('query=eng');

    const serverFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', serverFetch);
    await serverClient().listProjects('eng');
    expect(String(serverFetch.mock.calls[0][0])).toMatch(/\/project$/);
  });

  it('falls back to the legacy createmeta when the Cloud one 404s', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'gone' }, 404))
      .mockResolvedValueOnce(jsonResponse({ projects: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await cloudClient().listIssueTypes('ENG');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/issue/createmeta/ENG/issuetypes');
    expect(String(fetchMock.mock.calls[1][0])).toContain('expand=projects.issuetypes');
  });

  it('posts ADF for the description on v3 and plain text on v2', async () => {
    const input = {
      projectKey: 'ENG',
      issueTypeId: '1',
      summary: 'Fix it',
      description: 'Reproduce first.',
    };

    const cloudFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1', key: 'ENG-1' }));
    vi.stubGlobal('fetch', cloudFetch);
    await cloudClient().createIssue(input);
    const cloudBody = JSON.parse((cloudFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(cloudBody.fields.description.type).toBe('doc');
    expect(cloudBody.fields).toMatchObject({
      project: { key: 'ENG' },
      issuetype: { id: '1' },
      summary: 'Fix it',
    });

    const serverFetch = vi.fn().mockResolvedValue(jsonResponse({ id: '1', key: 'ENG-1' }));
    vi.stubGlobal('fetch', serverFetch);
    await serverClient().createIssue(input);
    const serverBody = JSON.parse((serverFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(serverBody.fields.description).toBe('Reproduce first.');
  });

  it('omits the description field entirely when there is none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '1', key: 'ENG-1' }));
    vi.stubGlobal('fetch', fetchMock);
    await cloudClient().createIssue({ projectKey: 'ENG', issueTypeId: '1', summary: 'x' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect('description' in body.fields).toBe(false);
  });

  it('reads an issue back with the same field list search uses', async () => {
    // This is what makes a created card indistinguishable from a synced one.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '1', key: 'ENG-1' }));
    vi.stubGlobal('fetch', fetchMock);
    await cloudClient().getIssue('ENG-1', ['customfield_7']);
    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
    expect(url).toContain('summary,status,priority,project,issuetype');
    expect(url).toContain('customfield_7');
  });
});
