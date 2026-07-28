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
    expect(fetchMock).toHaveBeenCalledTimes(20);
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
