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
import { DEFAULT_SESSION_TOKEN_BUDGET, DEFAULT_WEEKLY_TOKEN_BUDGET } from './usage';

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
   * Where REST calls go, when that is NOT the site URL. Empty for every ordinary install.
   *
   * Atlassian's scoped API tokens (the kind id.atlassian.com now offers by default) are
   * rejected with a bare `401` against `https://<site>.atlassian.net/rest/...` and only
   * work through the tenant gateway, `https://api.atlassian.com/ex/jira/<cloudId>`. That
   * is a transport detail, not a choice anyone should have to know about, so it is
   * discovered and written here by the "Test connection" probe rather than typed — and
   * cleared the moment the site or the deployment changes, since it belongs to neither
   * any more. `baseUrl` stays the SITE, because that is what issue links are built from.
   */
  apiBaseUrl?: string;
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
   * this. Unmapped statuses still land by category, exactly as before.
   *
   * `blocked` **is** a valid target. It was internal-only until a workflow's "Blocked"
   * status was found resolving to whatever the category said (To Do or In Progress) while
   * a drag happily transitioned issues INTO it — so the one column that could not be
   * mapped was the one a tracker most needed to say. The name heuristic reaches it now
   * (`isBlockedishStatus`); this map is how you correct it when the heuristic is wrong.
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
   * Optional exact transition name to use when moving a card into BLOCKED (else
   * auto-detected from a blocked-ish destination status).
   *
   * The one target whose transition may legitimately not exist: a workflow with no blocked
   * status simply cannot say "stuck", and the card blocks locally instead. Worth naming when
   * yours expresses it as something the blocked-name heuristic will not read — "Impediment
   * raised", "Send to triage" — or when several steps qualify and you want a particular one.
   */
  blockedTransitionName?: string;
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
 * GitHub integration config.
 *
 * Bigger than {@link GitLabSettings} because GitHub is asked to do two jobs rather than
 * one: it carries pull requests onto cards the way GitLab does, AND it can be the board's
 * *source* of cards the way JIRA is. The two are separately switchable — plenty of people
 * track work in JIRA and merge it on GitHub, and plenty track everything in GitHub Issues
 * — so neither is allowed to drag the other along with it.
 *
 * One auth mode, like GitLab: a personal access token, which works identically on
 * github.com and GitHub Enterprise Server.
 */
export interface GitHubSettings {
  /** Master switch — when off, nothing is fetched and no PR or issue appears anywhere. */
  enabled: boolean;
  /**
   * The API root. `https://api.github.com` for github.com; for GitHub Enterprise Server
   * give the instance root (`https://github.acme.internal`) and the client appends
   * `/api/v3` — see `main/github/githubClient.ts`, which is the only place that rule lives.
   */
  baseUrl: string;
  /** Mirror issues matching {@link issueQuery} onto the board as cards. */
  syncIssues: boolean;
  /** Put your open pull requests on the cards they belong to. */
  syncPullRequests: boolean;
  /**
   * The GitHub search query selecting the issues to mirror — the analogue of
   * {@link JiraSettings.jql}, in GitHub's own search syntax. `is:issue` is part of the
   * default rather than forced at fetch time, so a user who wants their own PRs on the
   * board as cards can say so.
   */
  issueQuery: string;
  /**
   * The user's map from an issue LABEL to a board column, matched case-insensitively
   * (`{ "in review": "in-review" }`).
   *
   * GitHub issues have no workflow: an issue is open or it is closed, and everything
   * between those two is a convention the repository invented — almost always a label.
   * So unlike JIRA, where the mapping corrects a status the tracker already knows, this
   * map is the *only* way a GitHub issue can land anywhere but To Do or Done.
   */
  labelColumnOverrides: Record<string, BoardColumn>;
  /**
   * The map the app taught ITSELF, label → column, written when a drag successfully
   * applies a label. Same shape and matching as {@link labelColumnOverrides}, and always
   * losing to it — see `JiraSettings.learnedStatusColumns`, which exists for exactly the
   * same reason: a column resolved one way on the way out and another on the way back in
   * undoes the move on the next sync.
   */
  learnedLabelColumns?: Record<string, BoardColumn>;
  /** Whether the board shows the Done column for GitHub's cards. */
  showDoneColumn: boolean;
  /**
   * How long (in days) a closed card is kept on the board after its issue stops matching
   * {@link issueQuery}. 0 = it goes the moment it leaves the query. Same trap as JIRA's:
   * the commonest query there is says `is:open`, which stops matching an issue the instant
   * you close it — so the card you had just dragged into DONE would vanish out of it.
   */
  doneRetentionDays: number;
}

/**
 * The out-of-the-box GitHub config: off, pointed at github.com, both features on so that
 * switching `enabled` is the only decision a github.com user has to make.
 */
export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = {
  enabled: false,
  baseUrl: 'https://api.github.com',
  syncIssues: true,
  syncPullRequests: true,
  issueQuery: 'is:issue is:open assignee:@me',
  labelColumnOverrides: {},
  showDoneColumn: false,
  doneRetentionDays: 14,
};

/**
 * The desktop client's own cloud-mirror config (Phase 25). Deliberately separate from
 * `syncIntervalMinutes`: JIRA and GitLab share one minutes-scale timer (`syncPoller.ts`),
 * but the cloud mirror polls on a seconds-scale, server-directed cadence of its own
 * (`cloudPoller.ts`) — putting it on the same clock as the trackers would either starve
 * it behind their far slower interval or drag them down to match it.
 */
export interface CloudSettings {
  /** Master switch — when off, the poller never runs and nothing is sent or received. */
  enabled: boolean;
  /** The `@tm/server` root, e.g. `https://taskmanager-api.example.com` (no trailing slash). */
  baseUrl: string;
  /**
   * The interval assumed for the FIRST poll, before any server directive has been heard
   * back — after that, `SyncResponse.cadence.intervalMs` from the previous tick is what
   * `nextPollDelayMs` actually mins against; this is only ever the seed. Matches
   * `@tm/protocol/cadence`'s own `CADENCE_MS.active` out of the box.
   */
  activeIntervalMs: number;
  /** Same seed, for when this window is not the focused one. Matches `CADENCE_MS.idle`. */
  idleIntervalMs: number;
  /** How much random jitter `nextPollDelayMs` adds to the idle tier — see its own docstring. */
  jitterRatio: number;
}

/** Off, with the seed intervals matching `@tm/protocol/cadence`'s `CADENCE_MS`. */
export const DEFAULT_CLOUD_SETTINGS: CloudSettings = {
  enabled: false,
  baseUrl: '',
  activeIntervalMs: 2_500,
  idleIntervalMs: 25_000,
  jitterRatio: 0.1,
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
  /**
   * The assignee's avatar (Phase 24: native tickets). **Off by default** — a board with no
   * ticket project has nobody to assign a card to, and turning this on would draw nothing
   * for anybody, so the acceptance bar is that a database with no ticket project renders a
   * board byte-identical to before this setting existed.
   */
  showAssignee: boolean;
  /** Story points, as a chip. Off by default — see {@link showAssignee}. */
  showPoints: boolean;
}

/** Labels and project name on, epic/assignee/points off — see {@link BoardDisplaySettings}. */
export const DEFAULT_BOARD_DISPLAY: BoardDisplaySettings = {
  showLabels: true,
  showProjectName: true,
  showEpicName: false,
  priorityDisplay: 'color',
  showAssignee: false,
  showPoints: false,
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
  /**
   * The token budget one **session** — the rolling 5-hour window — is measured against,
   * for the Performance screen's usage bars and the status bar's pair. Purely a
   * denominator: nothing refuses to start a run when it is passed, because the app has
   * no authority over the account's real cap (see `UsageQuota`). 0 turns the bar off.
   */
  sessionTokenBudget: number;
  /** The same, for the rolling 7-day window Claude's weekly cap covers. 0 = off. */
  weeklyTokenBudget: number;
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
  /**
   * Which board My Tasks (and the web board) is scoped to — a `kind: 'ticket'` project's
   * id, or `null` for the built-in Personal board. See `@shared/boardScope`'s
   * `resolveBoardScope`, which is what actually reads this: a dangling id (its project was
   * removed) or `null` both resolve to Personal, so this field never has to be validated on
   * the way in.
   *
   * `null` rather than defaulting to `PERSONAL_PROJECT_ID` itself, so a settings blob
   * written before Phase 24 needs no migration — the field is simply absent, and every
   * reader (`DEFAULT_SETTINGS`'s spread, `mergeAppSettings`) already treats a missing field
   * as its default.
   */
  boardScopeId: string | null;
  /**
   * The board cards whose **Steps** section is folded away, by task id.
   *
   * A fold is a fact about one card rather than a preference about all of them — a plan of
   * nine steps is worth folding on the card you have already read and worth leaving open on
   * the one you are watching — so this is a list of ids and not a switch. It is persisted
   * for the reason the fold exists at all: the board is unmounted every time you leave the
   * screen, so component state would put every card back open on the way back, and a fold
   * you have to redo on every visit is not a fold.
   *
   * Ids that have left the board are dropped as the list is written (see `foldedSteps.ts`),
   * so it stays the size of the board rather than the size of everything ever folded.
   */
  foldedStepCards: string[];
  /**
   * The cards showing the steps from their **earlier planning rounds**, by task id.
   *
   * The exception rather than the rule, which is why the list records what is OPEN and not
   * what is shut. A card that is re-planned folds its earlier rounds away by itself: the
   * point of asking for more steps is the steps you just asked for, and a card that kept
   * every round it has ever had on screen would grow without limit exactly when it is
   * getting the most attention. This list is where that default is overridden, one card at
   * a time — and it is saved for the same reason the other one is, since the board is
   * unmounted the moment you look at anything else.
   *
   * A card planned only once has no earlier rounds, so it is never in here.
   */
  shownEarlierStepCards: string[];
  /** JIRA integration config for the Personal board (Phase B). */
  jira: JiraSettings;
  /** GitLab integration config — merge requests on the cards their ticket lives on. */
  gitlab: GitLabSettings;
  /** GitHub integration config — issues as cards, pull requests on them. */
  github: GitHubSettings;
  /** The cloud mirror's own config — see {@link CloudSettings}. */
  cloud: CloudSettings;
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
  sessionTokenBudget: DEFAULT_SESSION_TOKEN_BUDGET,
  weeklyTokenBudget: DEFAULT_WEEKLY_TOKEN_BUDGET,
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
  boardScopeId: null,
  // Nothing folded out of the box: a card that hid its own steps before you had asked it to
  // would read as steps that had gone missing.
  foldedStepCards: [],
  // Empty means every re-planned card shows its newest bunch of steps and folds the rounds
  // before it away — the behaviour, not the exception. See the field.
  shownEarlierStepCards: [],
  jira: DEFAULT_JIRA_SETTINGS,
  gitlab: DEFAULT_GITLAB_SETTINGS,
  github: DEFAULT_GITHUB_SETTINGS,
  cloud: DEFAULT_CLOUD_SETTINGS,
};

/**
 * Fold an incoming settings blob over the CURRENT one, one level of nesting deep.
 *
 * Both Settings screens load the whole blob at mount and save it back whole, which makes
 * every save a full overwrite — including of whatever the engine learned in between. The
 * desktop keeps that window narrow by pushing `settings:changed` back at the open screen.
 * A browser tab does not get that push (there is no event channel over the mirror), and a
 * relayed `settings:save` can be carrying a blob that was read an hour ago.
 *
 * So a relayed save MERGES: fields the caller sent win, fields it did not send keep whatever
 * the engine has now. `incoming` is `unknown` because it arrived over HTTP as JSON; anything
 * that is not an object is ignored entirely rather than partially applied.
 *
 * One level, not deep: the nested groups (`jira`, `gitlab`, `cloud`, `board`) are merged
 * field-by-field, and the arrays (`statusKeywords`, `foldedStepCards`, …) are REPLACED
 * wholesale when present. That is the right rule for both — an array's whole content is the
 * value being edited, and merging two lists element-wise would resurrect entries the human
 * had just removed.
 */
export function mergeAppSettings(current: AppSettings, incoming: unknown): AppSettings {
  if (!isPlainObject(incoming)) return current;

  const merged = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
  return merged as unknown as AppSettings;
}

/** An object literal — not an array, not null, not a class instance from a JSON parse. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
