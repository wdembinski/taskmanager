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
  PROJECT_ID,
  PROJECTS,
  TASKS,
} from './boardShotsFixture.mjs';

const now = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** A milestone-tracker ticket, the same minimal `Task` fields `boardShotsFixture.mjs`'s own
 *  private `task()` helper settles on (not reused directly — it is not exported). */
function sidebarTicket(over) {
  return {
    id: over.id,
    projectId: PROJECT_ID,
    phase: '',
    title: over.title ?? 'Untitled',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ticketKey: `FX-${over.id}`,
    ...over,
  };
}

/** A milestone fixture, the same minimal `Milestone` fields `sidebarModel.test.ts`'s own
 *  `milestone()` helper settles on. */
function sidebarMilestone(over) {
  return {
    id: over.id,
    projectId: PROJECT_ID,
    name: over.name,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: now,
    ...over,
  };
}

/**
 * The sidebar tree's own "owner's shape" (`sidebarModel.test.ts`'s own describe block, mirrored
 * here): a fully-done milestone that folds by default, a mixed milestone with both open and
 * finished tickets (plus a step under one of them, proving steps never reach the tree, and an
 * epic whose own tickets are all done, proving an epic group folds on its own even while its
 * milestone still has open work) and a running ticket (proving the brand-coloured glyph), a
 * milestone with only open work (plus a needs-input ticket, proving the colour cue), and a
 * milestone whose only content is a fully-done epic (proving "no open work" folds a milestone
 * even when nothing but an epic group drives that, with no loose tickets of its own).
 */
const shippedMilestone = sidebarMilestone({
  id: 'ms-shipped',
  name: 'Nordic rollout',
  createdAt: now - 3 * DAY,
});
const mixedMilestone = sidebarMilestone({
  id: 'ms-mixed',
  name: 'Reach the mobile build',
  createdAt: now - 2 * DAY,
});
const pendingMilestone = sidebarMilestone({
  id: 'ms-pending',
  name: 'Early access',
  createdAt: now - DAY,
});
const epicDoneMilestone = sidebarMilestone({
  id: 'ms-epic-done',
  name: 'Platform hardening',
  createdAt: now - 4 * DAY,
});
export const MILESTONES = [shippedMilestone, mixedMilestone, pendingMilestone, epicDoneMilestone];

const sidebarShippedTicket = sidebarTicket({
  id: 'sb-1',
  title: 'Ship the Nordic locale pack',
  status: 'done',
  milestoneId: shippedMilestone.id,
});
const sidebarMixedPending = sidebarTicket({
  id: 'sb-2',
  title: 'Wire the mobile build pipeline',
  status: 'pending',
  milestoneId: mixedMilestone.id,
});
const sidebarMixedDone = sidebarTicket({
  id: 'sb-3',
  title: 'Audit the mobile bundle size',
  status: 'done',
  milestoneId: mixedMilestone.id,
});
const sidebarMixedRunning = sidebarTicket({
  id: 'sb-4',
  title: 'Localize the onboarding tour',
  status: 'running',
  agentProjectId: PROJECT_ID,
  workedAt: now - 2 * 60_000,
  milestoneId: mixedMilestone.id,
});
const sidebarMixedStep = sidebarTicket({
  id: 'sb-2-s1',
  title: 'Draft the pipeline config',
  status: 'done',
  parentTaskId: sidebarMixedPending.id,
  milestoneId: null,
});
const sidebarMixedEpic = sidebarTicket({
  id: 'sb-7',
  title: 'Nordic theming epic',
  status: 'in-review',
  issueType: 'epic',
  milestoneId: mixedMilestone.id,
});
const sidebarMixedEpicChildA = sidebarTicket({
  id: 'sb-7-a',
  title: 'Ship the dark palette',
  status: 'done',
  epicTaskId: sidebarMixedEpic.id,
  milestoneId: mixedMilestone.id,
});
const sidebarMixedEpicChildB = sidebarTicket({
  id: 'sb-7-b',
  title: 'Retire the legacy tokens',
  status: 'done',
  epicTaskId: sidebarMixedEpic.id,
  milestoneId: mixedMilestone.id,
});
const sidebarPendingA = sidebarTicket({
  id: 'sb-5',
  title: 'Draft the early-access invite flow',
  status: 'pending',
  milestoneId: pendingMilestone.id,
});
const sidebarPendingB = sidebarTicket({
  id: 'sb-6',
  title: 'Spec the invite quota limits',
  status: 'pending',
  milestoneId: pendingMilestone.id,
});
const sidebarPendingNeedsInput = sidebarTicket({
  id: 'sb-9',
  title: 'Resolve the invite-quota ambiguity',
  status: 'waiting-input',
  agentProjectId: PROJECT_ID,
  workedAt: now - 10 * 60_000,
  milestoneId: pendingMilestone.id,
});
const sidebarEpicDoneEpic = sidebarTicket({
  id: 'sb-8',
  title: 'Harden the sync protocol',
  status: 'done',
  issueType: 'epic',
  milestoneId: epicDoneMilestone.id,
});
const sidebarEpicDoneChildA = sidebarTicket({
  id: 'sb-8-a',
  title: 'Encrypt the sync payload',
  status: 'done',
  epicTaskId: sidebarEpicDoneEpic.id,
  milestoneId: epicDoneMilestone.id,
});
const sidebarEpicDoneChildB = sidebarTicket({
  id: 'sb-8-b',
  title: 'Rotate the sync keys automatically',
  status: 'done',
  epicTaskId: sidebarEpicDoneEpic.id,
  milestoneId: epicDoneMilestone.id,
});

export const SIDEBAR_TICKETS = [
  sidebarShippedTicket,
  sidebarMixedPending,
  sidebarMixedDone,
  sidebarMixedRunning,
  sidebarMixedStep,
  sidebarMixedEpic,
  sidebarMixedEpicChildA,
  sidebarMixedEpicChildB,
  sidebarPendingA,
  sidebarPendingB,
  sidebarPendingNeedsInput,
  sidebarEpicDoneEpic,
  sidebarEpicDoneChildA,
  sidebarEpicDoneChildB,
];

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
 * The three archived milestones `archived-light`'s own screen seeds (F14.8 step 4) — named
 * after the mockup's own rows (`v10-21-archived-light.svg`) so the shot reads the same way the
 * mockup does, on the fixture's one ticket project (`boardShotsFixture.mjs`'s `PROJECT_ID`).
 * Sorted newest-archived-first by `archivedViewModel` itself, so listing them in that same
 * order here is only for a human reading this file top to bottom, not load-bearing.
 */
export const ARCHIVED_MILESTONES = [
  {
    id: 'arch-m1',
    projectId: PROJECT_ID,
    name: 'M1 · Work while away',
    description: '',
    dueAt: now - 40 * DAY,
    color: '',
    closed: true,
    archivedAt: now - 10 * DAY,
    createdAt: now - 70 * DAY,
  },
  {
    id: 'arch-phase24',
    projectId: PROJECT_ID,
    name: 'Phase 24 · Native tickets',
    description: '',
    dueAt: now - 55 * DAY,
    color: '',
    closed: true,
    archivedAt: now - 17 * DAY,
    createdAt: now - 85 * DAY,
  },
  {
    id: 'arch-phase19',
    projectId: PROJECT_ID,
    name: 'Phase 19 · Chains',
    description: '',
    dueAt: now - 75 * DAY,
    color: '',
    closed: true,
    archivedAt: now - 45 * DAY,
    createdAt: now - 100 * DAY,
  },
];

/** A minimal native ticket filed under one of `ARCHIVED_MILESTONES` — the same shape
 *  `boardShotsFixture.mjs`'s own (private) `task()` helper builds. */
function archivedMilestoneTicket(over) {
  return {
    id: over.id,
    projectId: PROJECT_ID,
    phase: '',
    title: over.title,
    status: over.status,
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ticketKey: `FX-${over.id}`,
    milestoneId: over.milestoneId,
  };
}

/** Two of the three archived milestones' own tickets, all done but one — the open one is what
 *  makes `arch-phase24`'s row read "done · open" instead of a flat "done", the same way the
 *  mockup's own "41 done · 2 moved to Backlog" is not an all-done row either. */
export const ARCHIVED_MILESTONE_TICKETS = [
  archivedMilestoneTicket({
    id: '101',
    title: 'Ship the weekly digest email',
    status: 'done',
    milestoneId: 'arch-m1',
  }),
  archivedMilestoneTicket({
    id: '102',
    title: 'Queue agent runs while offline',
    status: 'done',
    milestoneId: 'arch-m1',
  }),
  archivedMilestoneTicket({
    id: '103',
    title: 'Reconcile native ticket ids on import',
    status: 'done',
    milestoneId: 'arch-phase24',
  }),
  archivedMilestoneTicket({
    id: '104',
    title: 'Backfill ticket numbers for pre-F24 rows',
    status: 'pending',
    milestoneId: 'arch-phase24',
  }),
  archivedMilestoneTicket({
    id: '105',
    title: 'Release the chain-link gate picker',
    status: 'done',
    milestoneId: 'arch-phase19',
  }),
];

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

  // Includes `ARCHIVED_MILESTONE_TICKETS` alongside the board's own `TASKS` — `archived-light`
  // (and any other screen that reaches `board:tasks`) needs to resolve them by id, and
  // `milestone:list` below marks their milestone archived so `visibleTickets` keeps them off
  // every ordinary board/backlog/timeline screen's own shot. `SIDEBAR_TICKETS`/`MILESTONES`
  // are the tree's own owner's-shape fixture (see their own comment above), folded into the
  // same answer since `ui-shots.mjs` drives every row off this one shared table.
  'board:tasks': [...TASKS, ...ARCHIVED_MILESTONE_TICKETS, ...SIDEBAR_TICKETS],
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
  // `ArchivedPane.tsx` and `useSidebarData.ts`'s own count both read this unscoped — an
  // `ArchivedListing`, not the bare `[]` the `'list'` fallback would answer with (that shape
  // mismatch is exactly the gap this step's plan calls out: an unlisted channel reads as an
  // empty listing instead of failing loudly).
  'archive:list': { projects: [], milestones: ARCHIVED_MILESTONES, epics: [] },
  // The sidebar's own `MILESTONES` plus `ARCHIVED_MILESTONES` — `sidebarModel.ts`'s
  // `buildSidebar` already drops an archived milestone from the tree, and
  // `visibleTickets`/`pickableMilestones` drop them (and their tickets) from every other screen
  // the same way, so listing them here does not leak into `board-light`/`issue-list-light`/etc.
  'milestone:list': [...MILESTONES, ...ARCHIVED_MILESTONES],
  // `useTicketRegistries.ts` (`Projects.tsx`'s own registries hook, reached once `ui-shots.mjs`
  // clicks "Tickets") fetches these two alongside `person:list`/`milestone:list` above — found
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

  'task:activity': { byArgTable: TASK_ACTIVITY, fallback: [] },
  'jira:fetchComments': { byArgTable: TICKET_COMMENTS, fallback: [] },
  'github:fetchComments': 'list',
  'linear:fetchComments': 'list',
  'jira:markRead': { byArgTable: TASKS_BY_ID, fallback: null },
  'github:markRead': { byArgTable: TASKS_BY_ID, fallback: null },
  'linear:markRead': { byArgTable: TASKS_BY_ID, fallback: null },

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
  'linear:getConfigStatus': LINEAR_STATUS,
  'cloud:getConfigStatus': CLOUD_STATUS,
};
