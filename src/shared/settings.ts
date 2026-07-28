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
import { LOCAL_TARGET, type ExecTarget } from './execTarget';
import type { ClaudeModel, PermissionMode } from './session';
import type { BoardColumn } from './model';
import type { StatusKeyword } from './statusKeywords';

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
  /**
   * REST API version: `2` for server, `3` for cloud.
   *
   * DERIVED, not authoritative — `jira/jiraConfig.ts` computes it from `deployment` on
   * every request and never reads this. Kept only so older persisted settings blobs
   * still parse; nothing should write it.
   */
  apiVersion: '2' | '3';
  /** JQL selecting the user's issues to mirror onto the board. */
  jql: string;
  /**
   * Narrow the board to issues in a running sprint. Composed onto `jql` at sync time
   * (`sprint in openSprints()`) rather than written into it, so toggling this off
   * restores the user's own query untouched.
   */
  currentSprintOnly: boolean;
  /** Whether the board shows the Done column. */
  showDoneColumn: boolean;
  /**
   * How often (in minutes) the app polls JIRA in the background to fetch new/changed
   * issues onto the board. 0 = off (the manual "Sync JIRA" button still works).
   */
  pollIntervalMinutes: number;
  /**
   * The user's map from a JIRA workflow status NAME to a board column, matched
   * case-insensitively (`{ "Code Review": "in-review" }`).
   *
   * Names rather than categories, because JIRA has only three categories and every
   * review-ish status ("Review", "In Review", "Code Review") shares `In Progress`
   * with the status that means "being written" — so IN REVIEW is unreachable without
   * this. Unmapped statuses still land by category, exactly as before. `blocked` is
   * internal-only and is never a valid target.
   */
  statusCategoryOverrides?: Record<string, BoardColumn>;
  /** Optional exact transition name to use for To Do → In Progress (else auto-detected). */
  inProgressTransitionName?: string;
  /** Optional exact transition name to use when moving into In Review (else auto-detected). */
  inReviewTransitionName?: string;
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
  currentSprintOnly: false,
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
  /**
   * Which machine a NEWLY ADDED project runs on. Purely a seed, like `defaultModel`:
   * changing it never moves an existing project, because a project's path only makes
   * sense on the machine it was picked from.
   */
  defaultExecTarget: ExecTarget;
  /**
   * The vocabulary that colours a card's status note: a keyword and the colour a note
   * containing it takes. Order is the priority — the first match wins. Empty by
   * default, in which case every status note reads in the card's ordinary muted
   * colour, which is a working board rather than a degraded one.
   */
  statusKeywords: StatusKeyword[];
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
  defaultExecTarget: LOCAL_TARGET,
  statusKeywords: [],
  jira: DEFAULT_JIRA_SETTINGS,
};
