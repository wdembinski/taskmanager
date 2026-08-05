import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JIRA_SETTINGS, type JiraSettings } from '@shared/settings';
import { probeJiraAuth } from './jiraAuthProbe';

const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

/**
 * A JIRA site that accepts exactly ONE credential, at exactly one URL — which is what
 * makes the probe's answer meaningful. Everything else is the 401 the user is staring at.
 */
function site(accept: { url: string; auth: string; status?: number }) {
  const fetchMock = vi.fn(async (raw: unknown, init?: RequestInit) => {
    const url = String(raw);
    if (url.endsWith('/_edge/tenant_info')) return response({ cloudId: CLOUD_ID });
    const sent = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (url === accept.url && sent === accept.auth) {
      const status = accept.status ?? 200;
      return response(status === 200 ? { displayName: 'Ada' } : {}, status);
    }
    return response({}, 401);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const basic = (email: string, token: string): string =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

const settings = (over: Partial<JiraSettings>): JiraSettings => ({
  ...DEFAULT_JIRA_SETTINGS,
  baseUrl: 'https://acme.atlassian.net',
  cloudEmail: 'ada@acme.com',
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('probeJiraAuth — the Deployment dropdown', () => {
  it('finds that a Cloud site takes the same token as email + API token', async () => {
    site({
      url: 'https://acme.atlassian.net/rest/api/3/myself',
      auth: basic('ada@acme.com', 'tok'),
    });

    const result = await probeJiraAuth(settings({ deployment: 'server' }), 'tok');
    expect(result).toMatchObject({
      outcome: 'connected',
      displayName: 'Ada',
      patch: { deployment: 'cloud', apiBaseUrl: '' },
    });
    expect(result?.message).toContain('Your token is fine');
  });

  it('finds the reverse: a self-hosted instance that wanted the Bearer PAT', async () => {
    site({ url: 'https://jira.company.com/rest/api/2/myself', auth: 'Bearer pat' });

    const result = await probeJiraAuth(
      settings({ deployment: 'cloud', baseUrl: 'https://jira.company.com' }),
      'pat',
    );
    expect(result).toMatchObject({ outcome: 'connected', patch: { deployment: 'server' } });
  });
});

describe('probeJiraAuth — the scoped-token gateway', () => {
  it('routes through api.atlassian.com when only the gateway accepts the token', async () => {
    site({ url: `${GATEWAY}/rest/api/3/myself`, auth: basic('ada@acme.com', 'scoped') });

    const result = await probeJiraAuth(settings({ deployment: 'cloud' }), 'scoped');
    expect(result).toMatchObject({
      outcome: 'connected',
      patch: { deployment: 'cloud', apiBaseUrl: GATEWAY },
    });
    expect(result?.message).toContain('SCOPED');
  });

  it('reports a gateway 403 as too-narrow scopes and does NOT call it connected', async () => {
    site({
      url: `${GATEWAY}/rest/api/3/myself`,
      auth: basic('ada@acme.com', 'scoped'),
      status: 403,
    });

    const result = await probeJiraAuth(settings({ deployment: 'cloud' }), 'scoped');
    expect(result?.outcome).toBe('scoped-too-narrowly');
    expect(result?.message).toContain('scopes');
  });

  it('does not reach for the gateway without an email — it speaks Basic too', async () => {
    const fetchMock = site({ url: `${GATEWAY}/rest/api/3/myself`, auth: basic('', 'scoped') });

    expect(await probeJiraAuth(settings({ deployment: 'server', cloudEmail: '' }), 'scoped')).toBe(
      null,
    );
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('api.atlassian.com'))).toBe(
      true,
    );
  });
});

describe('probeJiraAuth — when the token really is the problem', () => {
  it('answers null, leaving the last word to explainJiraFailure', async () => {
    site({
      url: 'https://acme.atlassian.net/rest/api/3/myself',
      auth: basic('ada@acme.com', 'good'),
    });

    expect(await probeJiraAuth(settings({ deployment: 'cloud' }), 'stale')).toBe(null);
  });

  it('says nothing when there is no token or no site to probe', async () => {
    const fetchMock = site({ url: 'https://x/rest/api/3/myself', auth: 'Basic x' });
    expect(await probeJiraAuth(settings({ deployment: 'cloud' }), '  ')).toBe(null);
    expect(await probeJiraAuth(settings({ deployment: 'cloud', baseUrl: '' }), 'tok')).toBe(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
