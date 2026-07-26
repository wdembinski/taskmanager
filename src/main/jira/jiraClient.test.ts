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
