/**
 * Shared app settings (Phase 6).
 *
 * A small bag of global preferences the user can edit on the Settings screen and
 * that the engine reads at runtime: the defaults applied to newly added projects,
 * plus two scheduler knobs (how many tasks run at once, and how much random jitter
 * to add before resuming after a usage limit resets). Persisted as one JSON blob
 * in the store's `app_state` table; it crosses the UI↔engine boundary, so it lives
 * in `shared`.
 */
import type { ClaudeModel, PermissionMode } from './session';
import type { BoardColumn } from './model';

/**
 * Non-secret JIRA connection config (the PAT itself is stored separately, encrypted
 * via Electron `safeStorage`). Persisted inside `AppSettings`; `getSettings` merges
 * over the defaults, so an older settings blob without a `jira` field loads fine.
 */
export interface JiraSettings {
  /** Master switch — when off, the board shows no JIRA cards and never calls out. */
  enabled: boolean;
  /**
   * `server` = self-hosted JIRA Server/Data Center (PAT via `Bearer`, REST v2).
   * `cloud`  = Atlassian Cloud (email + API token via `Basic`, REST v3).
   */
  deployment: 'server' | 'cloud';
  /** Base URL of the JIRA instance, e.g. `https://jira.company.com` (no trailing slash). */
  baseUrl: string;
  /** Account email — required only for `cloud` (Basic auth); ignored for `server`. */
  cloudEmail: string;
  /** REST API version: `2` for server, `3` for cloud. Derived from `deployment`. */
  apiVersion: '2' | '3';
  /** JQL selecting the user's issues to mirror onto the board. */
  jql: string;
  /** Whether the board shows the Done column. */
  showDoneColumn: boolean;
  /**
   * How often (in minutes) the app polls JIRA in the background to fetch new/changed
   * issues onto the board. 0 = off (the manual "Sync JIRA" button still works).
   */
  pollIntervalMinutes: number;
  /** Optional per-raw-status-name overrides mapping a status to a board column. */
  statusCategoryOverrides?: Record<string, BoardColumn>;
  /** Optional exact transition name to use for To Do → In Progress (else auto-detected). */
  inProgressTransitionName?: string;
  /** Optional exact transition name to use when moving into Done (else auto-detected). */
  doneTransitionName?: string;
}

/** The out-of-the-box JIRA config: disabled, self-hosted defaults. */
export const DEFAULT_JIRA_SETTINGS: JiraSettings = {
  enabled: false,
  deployment: 'server',
  baseUrl: '',
  cloudEmail: '',
  apiVersion: '2',
  jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
  showDoneColumn: false,
  pollIntervalMinutes: 5,
};

export interface AppSettings {
  /** Model applied to a newly added project (its tasks run with this unless changed). */
  defaultModel: ClaudeModel;
  /** Permission mode applied to a newly added project. */
  defaultPermissionMode: PermissionMode;
  /** Max tasks a single project runs at once (scheduler concurrency; 1 = sequential). */
  concurrency: number;
  /**
   * Upper bound on the random jitter (ms) added to a usage limit's reset time
   * before resuming, so many parked apps don't all retry the same instant (Phase 5).
   */
  limitJitterMs: number;
  /** Whether newly added projects tick completed checkboxes back into their plan file. */
  writeBackPlan: boolean;
  /**
   * How many times the scheduler auto-retries a task whose agent run failed before
   * parking it for the human to resolve (team orchestrator). 0 = never auto-retry
   * (park on the first failure). Integration/merge failures are never auto-retried —
   * they always park, since the fix is human-side (commit/stash the base, etc.).
   */
  maxAutoRetries: number;
  /** JIRA integration config for the Personal board (Phase B). */
  jira: JiraSettings;
}

/** The out-of-the-box settings, also used to fill any field missing from storage. */
export const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'sonnet',
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  limitJitterMs: 60_000,
  writeBackPlan: false,
  maxAutoRetries: 1,
  jira: DEFAULT_JIRA_SETTINGS,
};
