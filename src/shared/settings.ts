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
   * How long (in days) a finished card is kept on the board after its issue stops matching
   * the JQL. 0 keeps the old behaviour: it goes the moment it leaves the query.
   *
   * A Done column is only as useful as what it holds, and the commonest JQL there is
   * (`resolution = Unresolved`) stops matching an issue the instant you finish it — so the
   * card you had just dragged into DONE vanished out of it. The retained card is re-read by
   * key on every sync, so it still follows its ticket: move the issue back to In Progress in
   * JIRA and the card leaves Done, whether or not the query has caught up. See
   * `Task.retainedSince`.
   */
  doneRetentionDays: number;
  /**
   * @deprecated Superseded by {@link AppSettings.syncIntervalMinutes} — every integration
   * shares one timer now. Read once, on the way past, to migrate a settings blob written
   * before that; nothing else may consult it.
   */
  pollIntervalMinutes?: number;
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
  doneRetentionDays: 14,
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
   * @deprecated Superseded by {@link AppSettings.syncIntervalMinutes}. See the note on
   * `JiraSettings.pollIntervalMinutes`; kept only so an older blob can be migrated.
   */
  pollIntervalMinutes?: number;
}

/**
 * The one sync interval for a settings blob, migrating a pre-consolidation one.
 *
 * Takes the SMALLER of whatever the two integrations were separately set to, so a user who
 * had GitLab on 2 minutes does not silently drop to JIRA's 5 — nothing gets staler than it
 * already was, which is the only safe direction for a setting nobody asked to have changed.
 *
 * A `0` on one side means "that one was switched off", not "sync never", so it is skipped
 * rather than winning the minimum; two zeroes do mean off.
 */
export function resolveSyncInterval(saved: {
  syncIntervalMinutes?: number;
  jira?: { pollIntervalMinutes?: number };
  gitlab?: { pollIntervalMinutes?: number };
}): number {
  if (typeof saved.syncIntervalMinutes === 'number') return Math.max(0, saved.syncIntervalMinutes);
  const legacy = [saved.jira?.pollIntervalMinutes, saved.gitlab?.pollIntervalMinutes].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );
  if (legacy.length === 0) {
    // Both off, or a blob that predates either — but "both explicitly off" must stay off.
    const anyZero =
      saved.jira?.pollIntervalMinutes === 0 || saved.gitlab?.pollIntervalMinutes === 0;
    return anyZero ? 0 : DEFAULT_SETTINGS.syncIntervalMinutes;
  }
  return Math.min(...legacy);
}

/** The out-of-the-box GitLab config: off, pointed at gitlab.com. */
export const DEFAULT_GITLAB_SETTINGS: GitLabSettings = {
  enabled: false,
  baseUrl: 'https://gitlab.com',
};

/**
 * Which of a card's optional context lines the board draws (Phase 17).
 *
 * All three are pure noise on a board where every card shares the same project, and
 * indispensable on one that doesn't — which is why they are switches rather than a
 * judgement call baked into the card. Mirrored by a Display menu on the board itself,
 * so the toggle is where you notice the noise.
 */
/**
 * How a card shows its priority.
 *
 *  - `color` — the rounded colour square. Fastest to read, and the most ink on a board
 *    that already spends colour on step dots, pipeline dots and the running band.
 *  - `mono`  — JIRA's own priority chevrons (single for high/low, doubled for the extremes),
 *    so rank is read from direction and weight and colour is left to the things that are
 *    actually moving. **Medium draws nothing**: medium is normal, and only an abnormal
 *    priority is worth ink — see `priorityIndicatorShown`.
 *  - `off`   — not shown. The sort order still honours it; see `sortCards`.
 */
export type PriorityDisplay = 'color' | 'mono' | 'off';

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
  /**
   * Which priority indicator the cards wear. Defaults to `color`, which is what every
   * board looked like before this was a choice.
   */
  priorityDisplay: PriorityDisplay;
}

/** Labels and project name on, epic off — see {@link BoardDisplaySettings}. */
export const DEFAULT_BOARD_DISPLAY: BoardDisplaySettings = {
  showLabels: true,
  showProjectName: true,
  showEpicName: false,
  priorityDisplay: 'color',
};

export interface AppSettings {
  /** Model applied to a newly added project (its tasks run with this unless changed). */
  defaultModel: ClaudeModel;
  /**
   * Planning model applied to a newly added project. A seed only, exactly like
   * `defaultModel`: changing it never touches a project that already exists.
   *
   * `null` — the default — means a new project plans on whatever it executes on, so out of
   * the box nothing about any run changes. See `Project.planningModel`.
   */
  defaultPlanningModel: ClaudeModel | null;
  /** Permission mode applied to a newly added project. */
  defaultPermissionMode: PermissionMode;
  /** Max tasks a single project runs at once (scheduler concurrency; 1 = sequential). */
  concurrency: number;
  /**
   * **How often every integration is refreshed, in minutes.** 0 = off; the manual Sync
   * button always works.
   *
   * One interval for all of them, and one timer behind it. JIRA and GitLab used to carry
   * their own — 5 minutes and 2 — which meant two settings, two timers firing at unrelated
   * moments, and a status bar that could only answer "how fresh is this" one integration at
   * a time. There is no version of "the board is up to date" that is true of one tracker and
   * not the other, so there is no reason for the app to hold two answers.
   *
   * Migrated from the pair as the SMALLER of the two, so nothing an existing user relies on
   * gets staler than it already was.
   */
  syncIntervalMinutes: number;
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
   * Whether the My Tasks screen shows its commit-graph pane. **Off by default**, unlike
   * `showTaskDetail`: the detail pane is the point of the screen, whereas the graph answers
   * a question you only sometimes have ("what actually happened in the repo?"), and it costs
   * a `git log` on the project it is pointed at.
   *
   * Its own switch rather than a mode of the detail pane, because the two answer different
   * questions about different things — one card against one repository — and you often want
   * both on screen at once.
   */
  showGitGraph: boolean;
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
  // No planning model out of the box: a fresh install plans on what it executes on, which
  // is what every install did before there were two.
  defaultPlanningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  // Two minutes: the faster of the pair this replaced, so no integration polls less often
  // than it did before the two timers became one. Pipelines are the reason — a red one you
  // learn about ten minutes late has already cost you the context to fix it.
  syncIntervalMinutes: 2,
  limitJitterMs: 60_000,
  writeBackPlan: false,
  maxAutoRetries: 1,
  defaultExecTarget: LOCAL_TARGET,
  statusKeywords: [],
  showTaskDetail: true,
  showGitGraph: false,
  branchPrefix: '',
  fontSizePx: 14,
  toastsEnabled: true,
  autoIntegrate: false,
  board: DEFAULT_BOARD_DISPLAY,
  jira: DEFAULT_JIRA_SETTINGS,
  gitlab: DEFAULT_GITLAB_SETTINGS,
};
