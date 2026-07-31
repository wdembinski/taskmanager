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
  /**
   * The map the app taught ITSELF, from status name to column — same shape and same
   * case-insensitive matching as `statusCategoryOverrides`, but written by the engine
   * rather than the user, and always losing to it.
   *
   * Filled when a drag successfully transitions an issue: the destination status is
   * now known to mean the column you dropped the card into, on the authority of your
   * own drag. Without it a workflow's review status resolved by name on the way out
   * and by category on the way back in, so the next sync undid the move.
   */
  learnedStatusColumns?: Record<string, BoardColumn>;
  /**
   * Optional exact transition name to use when moving a card back to To Do (else
   * auto-detected). The one target with no natural default name — workflows call it
   * "Reopen", "Back to To Do", "Stop Progress" — so it is the one most likely to need
   * saying out loud.
   */
  todoTransitionName?: string;
  /** Optional exact transition name to use for To Do → In Progress (else auto-detected). */
  inProgressTransitionName?: string;
  /** Optional exact transition name to use when moving into In Review (else auto-detected). */
  inReviewTransitionName?: string;
  /** Optional exact transition name to use when moving into Done (else auto-detected). */
  doneTransitionName?: string;
  /**
   * What the Add-task dialog last created a JIRA issue as, so the next one opens on the
   * same project and type. Written by the engine after a successful create and pushed on
   * `settings:changed`; a screen that saves the whole blob must not write over it.
   */
  lastCreateProjectKey?: string;
  lastCreateIssueTypeId?: string;
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

/**
 * GitLab integration config. Deliberately smaller than {@link JiraSettings}: there is
 * one auth mode (`PRIVATE-TOKEN`, which works on gitlab.com and self-hosted alike) and
 * one scope (`created_by_me`), so there is nothing else to configure.
 */
export interface GitLabSettings {
  /** Master switch — when off, nothing is fetched and no MR appears on any card. */
  enabled: boolean;
  /** Instance root, e.g. `https://gitlab.com` or `https://gitlab.acme.internal`. */
  baseUrl: string;
  /**
   * Minutes between background syncs; 0 = off. Faster than JIRA's default because a
   * pipeline turns red on a timescale of minutes, and a red pipeline you learn about
   * ten minutes later has already cost you the context you needed to fix it.
   */
  pollIntervalMinutes: number;
}

/** The out-of-the-box GitLab config: off, pointed at gitlab.com. */
export const DEFAULT_GITLAB_SETTINGS: GitLabSettings = {
  enabled: false,
  baseUrl: 'https://gitlab.com',
  pollIntervalMinutes: 2,
};

/**
 * Which of a card's optional context lines the board draws (Phase 17).
 *
 * All three are pure noise on a board where every card shares the same project, and
 * indispensable on one that doesn't — which is why they are switches rather than a
 * judgement call baked into the card. Mirrored by a Display menu on the board itself,
 * so the toggle is where you notice the noise.
 */
export interface BoardDisplaySettings {
  /** Every JIRA label on the issue, as chips. */
  showLabels: boolean;
  /** The `Project: <name>` line. */
  showProjectName: boolean;
  /**
   * The parent epic's NAME (not its key). Off by default: it is the newest of the
   * three, the longest string on the card, and the one most boards don't need.
   */
  showEpicName: boolean;
}

/** Labels and project name on, epic off — see {@link BoardDisplaySettings}. */
export const DEFAULT_BOARD_DISPLAY: BoardDisplaySettings = {
  showLabels: true,
  showProjectName: true,
  showEpicName: false,
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
  /**
   * Whether the My Tasks screen shows its right-hand detail pane. On by default — the
   * pane is the point of the screen — but on a narrow window the board wants the whole
   * width, so it can be folded away from the toolbar. Top-level rather than under
   * `jira` because the pane exists whether or not JIRA does.
   */
  showTaskDetail: boolean;
  /**
   * Leading segment of every branch an agent's worktree runs on, e.g. `wd` gives
   * `wd/feat/abc-123/add-sso`. Empty means no prefix AND no leading slash — a branch
   * called `/feat/…` is not a valid git ref, so this cannot be a naive concatenation.
   */
  branchPrefix: string;
  /**
   * Base UI font size in px; every Fluent typography token is scaled off it, and the
   * app's own hardcoded sizes follow via the `--app-font-scale` custom property.
   * 14 is Fluent's own base, so the default changes nothing.
   */
  fontSizePx: number;
  /** Whether transient toasts are shown at all. Everything they say is also on screen. */
  toastsEnabled: boolean;
  /**
   * Whether a finished run merges its own branch back into base (Phase 17).
   *
   * **Off by default**, which reverses the original behaviour. Auto-integration merges at
   * the moment the agent stops — the moment you have reviewed the work least — and when
   * the merge fails it parks an inbox item offering "Retry integration", which fails the
   * same way, parks again, and asks again. There was no way to say "leave it".
   *
   * With this off, a finished branch waits and the card offers a Merge button. Nothing is
   * lost either way: the branch and its worktree survive both paths.
   */
  autoIntegrate: boolean;
  /** Which optional context lines the board's cards draw. */
  board: BoardDisplaySettings;
  /** JIRA integration config for the Personal board (Phase B). */
  jira: JiraSettings;
  /** GitLab integration config — merge requests on the cards their ticket lives on. */
  gitlab: GitLabSettings;
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
  showTaskDetail: true,
  branchPrefix: '',
  fontSizePx: 14,
  toastsEnabled: true,
  autoIntegrate: false,
  board: DEFAULT_BOARD_DISPLAY,
  jira: DEFAULT_JIRA_SETTINGS,
  gitlab: DEFAULT_GITLAB_SETTINGS,
};
