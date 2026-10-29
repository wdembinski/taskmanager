/**
 * The app/CLI, update/sync, and each tracker's connection status every screen's boot reaches
 * for — plus the board's own data (`TASKS`, `PROJECTS`, …) and the "nothing to say yet, don't
 * hang" fallbacks no screen below has its own opinion about. See `uiShotsFixture.mjs`'s own
 * header doc for how `CHANNELS` here is merged with every other file under this directory.
 */
import {
  ACTIVE_RUNS,
  CHAIN_LINKS,
  MERGE_REQUESTS,
  PEOPLE,
  PROJECTS,
  TASKS,
} from '../boardShotsFixture.mjs';
import { now } from '../shotsFixtureHelpers.mjs';

export const APP_INFO = {
  version: '0.0.0',
  electron: 'headless',
  node: 'headless',
  chrome: 'headless',
  platform: 'win32',
  // v9-1's Assignee reads "Agent on WD-DESKTOP" — the peek names the desktop by this.
  hostname: 'WD-DESKTOP',
};

export const CLAUDE_STATUS = {
  installed: true,
  version: '0.0.0',
  authenticated: true,
  apiKeyDetected: false,
  message: '',
};

export const UPDATE_STATE = { status: 'idle', mode: 'off' };

export const SYNC_STATE = { intervalMs: 0, lastSyncAt: now, syncing: false, services: [] };

export const EXEC_TARGETS_IN_USE = [{ kind: 'local' }];

/** Every tracker's Settings status, all answered "off, no token" — none of the five screens
 *  needs a live integration, only a Settings pane that renders instead of hanging. */
const OFF_STATUS = {
  enabled: false,
  hasToken: false,
  encryptionAvailable: true,
  plainTextStorage: false,
  deployment: 'cloud',
  baseUrl: '',
};
export const JIRA_STATUS = { ...OFF_STATUS };
export const GITLAB_STATUS = { ...OFF_STATUS };
export const GITHUB_STATUS = { ...OFF_STATUS };
export const CLOUD_STATUS = {
  hasToken: false,
  encryptionAvailable: true,
  plainTextStorage: false,
  authState: 'no-token',
  authError: null,
  lastAcceptedAt: null,
  legacySignInRetired: false,
};

/** `TASKS`, keyed by id — the table `jira:markRead`/`github:markRead` answer from below: both
 *  just hand back the task they marked read. */
const TASKS_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));

/** Claude's own `/usage` reading, so the status bar draws its 5h/7d pair — the mockups'
 *  proportions (v9-7: 25 of 40px session, 12 of 40px week). */
const USAGE_QUOTAS = {
  session: {
    id: 'session',
    windowStart: now - 2 * 60 * 60_000,
    windowEnd: now + 3 * 60 * 60_000,
    resetAt: now + 3 * 60 * 60_000,
    tokens: 0,
    limit: 0,
    pct: 62,
    pctSource: 'claude',
  },
  weekly: {
    id: 'weekly',
    windowStart: now - 2 * 24 * 60 * 60_000,
    windowEnd: now + 5 * 24 * 60 * 60_000,
    resetAt: now + 5 * 24 * 60 * 60_000,
    tokens: 0,
    limit: 0,
    pct: 30,
    pctSource: 'claude',
  },
};

export const CHANNELS = {
  'app:getInfo': APP_INFO,
  'claude:getStatus': CLAUDE_STATUS,
  'auth:current': null,
  'attention:list': 'list',
  'update:get': UPDATE_STATE,
  'sync:state': SYNC_STATE,
  'activity:getLastSeen': null,
  'limit:current': null,
  'usage:quotas': USAGE_QUOTAS,
  'window:isMaximized': false,
  'window:nativeMaterial': null,

  // The board's own `TASKS` — joined in file order with `40-archived.mjs`'s
  // `ARCHIVED_MILESTONE_TICKETS` and `50-sidebar.mjs`'s `SIDEBAR_TICKETS` (see `uiShotsFixture
  // .mjs`'s own header doc on why `board:tasks` is split three ways).
  'board:tasks': [...TASKS],
  'board:archived': 'list',
  'project:list': PROJECTS,
  'mr:mergeRequests': MERGE_REQUESTS,
  'chain:links': CHAIN_LINKS,
  'person:list': PEOPLE,
  'scheduler:activeRuns': ACTIVE_RUNS,
  'scheduler:states': 'list',
  'scheduler:integrating': 'list',
  'board:scopes': 'list',
  // `useTicketRegistries.ts` (`Projects.tsx`'s own registries hook, reached once `ui-shots.mjs`
  // clicks "Tickets") fetches these two alongside `person:list`/`milestone:list` — found
  // missing the first time this fixture drove the web target through `fakeRelay.mjs`, whose
  // own `handleIpcInvoke` (unlike `apiStub.mjs`'s) has no generic fallback for a channel absent
  // from this table: it answers `{ ok: false, error: … }` instead, which surfaces in `@tm/web`
  // as an uncaught rejection rather than a quietly empty list.
  'label:list': 'list',
  'ticketLink:list': 'list',

  // Found missing the same way `label:list`/`ticketLink:list` were (see their own comment
  // above): `Settings.tsx` calls `jira:statuses` unconditionally once its "board" section is
  // reached (`issue-peek`'s "Open full screen" step lands there via Settings too), and without
  // a row here the generic `[]` fallback answers in place of `{ statuses, error }` — `[].statuses`
  // is `undefined`, and `statusesByColumn(undefined, …)` throws `statuses is not iterable`. That
  // throw lands inside Settings' own error boundary, so it never reaches `collectExceptions` —
  // the shot still came back "ok", just showing the app's own crash screen instead of Settings.
  'jira:statuses': { statuses: [], error: null },
  // `TaskDetail.tsx`'s `ReviewPane` (`issue-peek`/`issue-full-screen`'s own pane) calls this on
  // mount; missing the same way, the `[]` fallback stands in for a `DiffSummaryResult`, so
  // `summaryTotals(([]).summary)` throws reading `files` off `undefined` — caught by the same
  // error boundary, same silent "ok". None of this plan's fixture tasks carry real branch data,
  // so `'no-branch'` is the state that is actually true of them, not a stand-in for a richer one.
  'task:diffSummary': { status: 'no-branch' },

  'github:fetchComments': 'list',
  'jira:markRead': { byArgTable: TASKS_BY_ID, fallback: null },
  'github:markRead': { byArgTable: TASKS_BY_ID, fallback: null },

  'exec:listDistros': 'list',
  'exec:targetsInUse': EXEC_TARGETS_IN_USE,
  // Settings' own `ReadinessPanel` probes this for whichever target is selected (the local one,
  // by default) — missing the same way `jira:statuses`/`task:diffSummary` were: the `[]`
  // fallback stands in for `TargetReadiness`, and `readiness?.checks.map(…)` only guards
  // `readiness` itself, not `.checks`, so it throws reading `map` off `undefined`. Caught by the
  // same error boundary as the other two, so this was the second crash hiding behind the first.
  'exec:readiness': { target: { kind: 'local' }, ok: true, checks: [] },
  'jira:getConfigStatus': JIRA_STATUS,
  'gitlab:getConfigStatus': GITLAB_STATUS,
  'github:getConfigStatus': GITHUB_STATUS,
  'cloud:getConfigStatus': CLOUD_STATUS,
};
