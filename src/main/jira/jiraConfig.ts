/**
 * Bridges non-secret JIRA settings + a decrypted token into a concrete
 * `JiraClientConfig`. Kept Electron-free (the token is passed in already decrypted
 * by the IPC layer via `safeStorage`), so it and the client stay unit-testable.
 */
import type { JiraSettings } from '@shared/settings';
import { normalizeApiBaseUrl, normalizeBaseUrl } from '@shared/jiraUrl';
import { JiraClient, type JiraClientConfig } from './jiraClient';

/**
 * Derive the wire config from user settings + token. Cloud → Basic/v3, server → Bearer/v2.
 *
 * `apiBaseUrl` wins over `baseUrl` when it is set, and only the Test-connection probe ever
 * sets it (see `JiraSettings.apiBaseUrl`): a Cloud tenant whose token is scoped answers
 * 401 on its own hostname and 200 on `api.atlassian.com/ex/jira/<cloudId>`. It keeps its
 * path, so it goes through `normalizeApiBaseUrl` rather than the origin-taking one.
 */
export function buildClientConfig(jira: JiraSettings, token: string): JiraClientConfig {
  return {
    baseUrl: normalizeApiBaseUrl(jira.apiBaseUrl ?? '') || normalizeBaseUrl(jira.baseUrl),
    apiVersion: jira.deployment === 'cloud' ? '3' : '2',
    auth:
      jira.deployment === 'cloud'
        ? { mode: 'basic', token, email: jira.cloudEmail.trim() }
        : { mode: 'bearer', token },
  };
}

export function createJiraClient(jira: JiraSettings, token: string): JiraClient {
  return new JiraClient(buildClientConfig(jira, token));
}
