import { describe, expect, it } from 'vitest';
import { isCloudHost, normalizeBaseUrl } from './jiraUrl';

describe('normalizeBaseUrl', () => {
  it('leaves a clean origin alone', () => {
    expect(normalizeBaseUrl('https://acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });

  it('assumes https for a scheme-less host — otherwise new URL() throws', () => {
    expect(normalizeBaseUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://jira.company.com///')).toBe('https://jira.company.com');
  });

  it('reduces a pasted deep link to the site root', () => {
    expect(normalizeBaseUrl('https://acme.atlassian.net/jira/your-work')).toBe(
      'https://acme.atlassian.net',
    );
    expect(normalizeBaseUrl('https://jira.company.com/browse/ABC-123')).toBe(
      'https://jira.company.com',
    );
  });

  it('keeps an explicit port and http scheme (internal hosts use both)', () => {
    expect(normalizeBaseUrl('http://jira.internal:8080/secure/Dashboard.jspa')).toBe(
      'http://jira.internal:8080',
    );
  });

  it('trims whitespace and maps empty input to empty output', () => {
    expect(normalizeBaseUrl('  https://jira.company.com  ')).toBe('https://jira.company.com');
    expect(normalizeBaseUrl('   ')).toBe('');
  });

  it('returns unparseable input untouched, so the caller reports it', () => {
    expect(normalizeBaseUrl('https://')).toBe('https://');
  });
});

describe('isCloudHost', () => {
  it('recognizes an atlassian.net site', () => {
    expect(isCloudHost('https://nextbase.atlassian.net')).toBe(true);
  });

  it('recognizes one even without a scheme or with a deep path', () => {
    expect(isCloudHost('nextbase.atlassian.net')).toBe(true);
    expect(isCloudHost('https://nextbase.atlassian.net/jira/your-work')).toBe(true);
  });

  it('treats a self-hosted host as not-Cloud', () => {
    expect(isCloudHost('https://jira.company.com')).toBe(false);
  });

  it('is not fooled by atlassian.net appearing elsewhere in the URL', () => {
    expect(isCloudHost('https://jira.evil.com/atlassian.net')).toBe(false);
    expect(isCloudHost('https://notatlassian.net')).toBe(false);
  });

  it('is false for empty or unparseable input', () => {
    expect(isCloudHost('')).toBe(false);
    expect(isCloudHost('https://')).toBe(false);
  });
});
