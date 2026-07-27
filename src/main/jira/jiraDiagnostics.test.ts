import { describe, expect, it } from 'vitest';
import { DEFAULT_JIRA_SETTINGS, type JiraSettings } from '@shared/settings';
import { JiraError } from './jiraClient';
import { explainJiraFailure } from './jiraDiagnostics';

const cloudSite = (over: Partial<JiraSettings> = {}): JiraSettings => ({
  ...DEFAULT_JIRA_SETTINGS,
  baseUrl: 'https://nextbase.atlassian.net',
  ...over,
});

/** How undici reports a transport failure: a bare message, the reason in `cause`. */
const fetchFailed = (code: string): Error =>
  Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('explainJiraFailure — the Cloud/Server mix-up', () => {
  it('names the Deployment dropdown when a Cloud site 401s in server mode', () => {
    const msg = explainJiraFailure(
      new JiraError('JIRA 401 Unauthorized', 401),
      cloudSite({ deployment: 'server' }),
    );
    expect(msg).toContain('JIRA 401 Unauthorized'); // the raw error is preserved
    expect(msg).toContain('Atlassian Cloud site');
    expect(msg).toContain('does not accept Bearer tokens');
  });

  it('points at the email/token pairing when Cloud mode 401s', () => {
    const msg = explainJiraFailure(
      new JiraError('JIRA 401 Unauthorized', 401),
      cloudSite({ deployment: 'cloud', cloudEmail: 'me@nextbase.com' }),
    );
    expect(msg).toContain('account email plus an API token');
    expect(msg).not.toContain('does not accept Bearer tokens');
  });

  it('does not claim Cloud for a self-hosted host', () => {
    const msg = explainJiraFailure(new JiraError('JIRA 401 Unauthorized', 401), {
      ...DEFAULT_JIRA_SETTINGS,
      baseUrl: 'https://jira.company.com',
      deployment: 'server',
    });
    expect(msg).toContain('Personal Access Token was rejected');
    expect(msg).not.toContain('Atlassian Cloud site');
  });
});

describe('explainJiraFailure — other statuses', () => {
  it('surfaces the CAPTCHA denial reason a 403 body never carries', () => {
    const msg = explainJiraFailure(
      new JiraError('JIRA 403 Forbidden', 403, 'CAPTCHA_CHALLENGE'),
      cloudSite({ deployment: 'server' }),
    );
    expect(msg).toContain('CAPTCHA_CHALLENGE');
  });

  it('falls back to a permissions explanation for a plain 403', () => {
    const msg = explainJiraFailure(new JiraError('JIRA 403 Forbidden', 403), cloudSite());
    expect(msg).toContain('lacks permission');
  });

  it('blames the base URL on a 404', () => {
    const msg = explainJiraFailure(new JiraError('JIRA 404 Not Found', 404), cloudSite());
    expect(msg).toContain('site root');
  });

  it('passes an unremarkable status through unchanged', () => {
    const msg = explainJiraFailure(new JiraError('JIRA 500 Server Error', 500), cloudSite());
    expect(msg).toBe('JIRA 500 Server Error');
  });
});

describe('explainJiraFailure — network failures hidden behind "fetch failed"', () => {
  it.each([
    ['ENOTFOUND', "Can't resolve"],
    ['ECONNREFUSED', 'refused the connection'],
    ['ETIMEDOUT', 'Timed out'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS certificate'],
  ])('explains %s instead of reporting "fetch failed"', (code, expected) => {
    const msg = explainJiraFailure(fetchFailed(code), cloudSite());
    expect(msg).toContain(expected);
    expect(msg).not.toBe('fetch failed');
  });

  it('still names an unrecognized transport code rather than swallowing it', () => {
    expect(explainJiraFailure(fetchFailed('ECONNRESET'), cloudSite())).toContain('ECONNRESET');
  });
});

describe('explainJiraFailure — anything else', () => {
  it('passes a plain Error through', () => {
    expect(explainJiraFailure(new Error('No JIRA token saved'), cloudSite())).toBe(
      'No JIRA token saved',
    );
  });

  it('stringifies a non-Error throw', () => {
    expect(explainJiraFailure('boom', cloudSite())).toBe('boom');
  });
});
