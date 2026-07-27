/**
 * Bridges non-secret JIRA settings + a decrypted token into a concrete
 * `JiraClientConfig`. Kept Electron-free (the token is passed in already decrypted
 * by the IPC layer via `safeStorage`), so it and the client stay unit-testable.
 */
import type { JiraSettings } from '@shared/settings';
import { normalizeBaseUrl } from '@shared/jiraUrl';
import { JiraClient, type JiraClientConfig } from './jiraClient';

/** Derive the wire config from user settings + token. Cloud → Basic/v3, server → Bearer/v2. */
export function buildClientConfig(jira: JiraSettings, token: string): JiraClientConfig {
  return {
    baseUrl: normalizeBaseUrl(jira.baseUrl),
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
