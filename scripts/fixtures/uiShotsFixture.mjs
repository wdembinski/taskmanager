/**
 * The one fixture `ui-shots.mjs` (step 4 of "screenshot the real UI headlessly") seeds every
 * screen in its `SCREENS` map from — board, issue list, a card's detail, Settings, and the
 * command palette, for both the desktop (`'client'`) and web (`'web'`) targets.
 *
 * `boardShotsFixture.mjs` already built the board's own data (tasks, projects, merge requests,
 * chain links, people, active runs) with fixed timestamps so shots are deterministic; this file
 * re-exports all of it unchanged — `shots-board.mjs` keeps importing that module directly — and
 * adds everything the OTHER screens' boot sequences read that the board never touched: app/CLI
 * info, the update/sync/auth/limit snapshots, each tracker's connection status, and per-task
 * activity/comments for the one card `issue-peek`/`issue-full-screen` opens.
 *
 * `BOOT_CHANNELS` is the single map both `scripts/lib/apiStub.mjs` (the desktop's `window.api`)
 * and `scripts/lib/fakeRelay.mjs` (the web build's HTTP relay) read every channel reached on
 * boot of those five screens from — enumerated by grepping `window.api.invoke(`/`transport.invoke(`
 * across `apps/client/src/renderer`, `packages/ui/src` and `apps/web/src` for what `App.tsx`,
 * `MyTasks.tsx`, `Settings.tsx`, `TaskDetail.tsx` and `IssuesScreen.tsx` call while mounting —
 * not literally every one of `@tm/shared/ipc`'s ~180 channels, only the ones a boot actually
 * reaches for. A channel missing from here that a later screen needs is a gap to add a row for,
 * not a reason to invent a generic fallback that could hide it.
 */
export * from './boardShotsFixture.mjs';
import {
  ACTIVE_RUNS,
  CHAIN_LINKS,
  MERGE_REQUESTS,
  PEOPLE,
  PROJECTS,
  TASKS,
} from './boardShotsFixture.mjs';

const now = Date.UTC(2026, 0, 15, 12, 0, 0);

export const APP_INFO = {
  version: '0.0.0',
  electron: 'headless',
  node: 'headless',
  chrome: 'headless',
  platform: 'win32',
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
export const LINEAR_STATUS = { ...OFF_STATUS };
export const CLOUD_STATUS = {
  hasToken: false,
  encryptionAvailable: true,
  plainTextStorage: false,
  authState: 'no-token',
  authError: null,
  lastAcceptedAt: null,
  legacySignInRetired: false,
};

/**
 * `task:activity`, by task id — read when `issue-peek`/`issue-full-screen` open a card
 * (`TaskDetail.tsx`'s `loadActivity`). Keyed on the fixture's own task ids (`boardShotsFixture
 * .mjs`'s `agentRunningParent`/`mrChangesRequestedCard`), rather than exporting those tasks
 * individually just to attach activity to them.
 */
export const TASK_ACTIVITY = {
  3: [
    {
      kind: 'chat',
      id: 1,
      body: 'Use the existing Linear client, not a new fetch.',
      createdAt: now - 4 * 60_000,
    },
    { kind: 'status', id: 2, from: 'pending', to: 'in-progress', createdAt: now - 5 * 60_000 },
  ],
  6: [
    {
      kind: 'comment',
      id: 3,
      body: 'Left two inline notes on the diff.',
      createdAt: now - 30 * 60_000,
    },
  ],
};

/** The jira-sourced `trackerUnread` card's (`boardShotsFixture.mjs` id `'12'`) live comment
 *  thread — `ticketChannels('jira').fetchComments`, merged into the same timeline. */
export const TICKET_COMMENTS = {
  12: [
    {
      kind: 'jira-comment',
      id: 'c1',
      author: 'Wiktor Nowak',
      body: 'Can we also dedupe on externalKey while we are in here?',
      createdAt: now - 3 * 60 * 60 * 1000,
      mine: false,
    },
  ],
};

/** `TASKS`, keyed by id — the table `jira:markRead`/`github:markRead`/`linear:markRead` answer
 *  from below: all three just hand back the task they marked read. */
const TASKS_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));

/**
 * Every IPC channel a boot of board/issue-list/detail/settings/palette reaches for, mapped to
 * how to answer it — read identically by `apiStub.mjs` (direct `window.api`) and
 * `fakeRelay.mjs` (the same channels, relayed over HTTP for the web build). Every entry here is
 * plain, JSON-serializable data, never a function: both consumers cross into a freshly started
 * page/process, where a closure's captured variables would not come along for the ride — only
 * its source text would, which is why "keyed by argument" is a DATA table (`byArgTable`) rather
 * than a lookup function.
 *
 *   - a literal value answers every call to that channel the same way;
 *   - `{ byArgTable, fallback }` answers keyed on the call's first argument — every per-task
 *     channel here (`task:activity`, each tracker's `fetchComments`/`markRead`) — falling back
 *     to `fallback` for an argument the table has no row for;
 *   - `'list'` / `'null'` name the two fallback buckets for a channel this fixture has no
 *     opinion about but a boot must not hang on — an empty array or `null`, whichever the
 *     channel's own return type tolerates.
 */
export const BOOT_CHANNELS = {
  'app:getInfo': APP_INFO,
  'claude:getStatus': CLAUDE_STATUS,
  'auth:current': null,
  'attention:list': 'list',
  'update:get': UPDATE_STATE,
  'sync:state': SYNC_STATE,
  'activity:getLastSeen': null,
  'limit:current': null,
  'usage:quotas': null,
  'window:isMaximized': false,
  'window:nativeMaterial': null,

  'board:tasks': TASKS,
  'board:archived': 'list',
  'project:list': PROJECTS,
  'mr:mergeRequests': MERGE_REQUESTS,
  'chain:links': CHAIN_LINKS,
  'person:list': PEOPLE,
  'scheduler:activeRuns': ACTIVE_RUNS,
  'scheduler:states': 'list',
  'scheduler:integrating': 'list',
  'attachment:list': 'list',
  'board:scopes': 'list',
  'milestone:list': 'list',
  // `useTicketRegistries.ts` (`Projects.tsx`'s own registries hook, reached once `ui-shots.mjs`
  // clicks "Tickets") fetches these two alongside `person:list`/`milestone:list` above — found
  // missing the first time this fixture drove the web target through `fakeRelay.mjs`, whose
  // own `handleIpcInvoke` (unlike `apiStub.mjs`'s) has no generic fallback for a channel absent
  // from this table: it answers `{ ok: false, error: … }` instead, which surfaces in `@tm/web`
  // as an uncaught rejection rather than a quietly empty list.
  'label:list': 'list',
  'ticketLink:list': 'list',

  'task:activity': { byArgTable: TASK_ACTIVITY, fallback: [] },
  'jira:fetchComments': { byArgTable: TICKET_COMMENTS, fallback: [] },
  'github:fetchComments': 'list',
  'linear:fetchComments': 'list',
  'jira:markRead': { byArgTable: TASKS_BY_ID, fallback: null },
  'github:markRead': { byArgTable: TASKS_BY_ID, fallback: null },
  'linear:markRead': { byArgTable: TASKS_BY_ID, fallback: null },

  'exec:listDistros': 'list',
  'exec:targetsInUse': EXEC_TARGETS_IN_USE,
  'jira:getConfigStatus': JIRA_STATUS,
  'gitlab:getConfigStatus': GITLAB_STATUS,
  'github:getConfigStatus': GITHUB_STATUS,
  'linear:getConfigStatus': LINEAR_STATUS,
  'cloud:getConfigStatus': CLOUD_STATUS,
};
