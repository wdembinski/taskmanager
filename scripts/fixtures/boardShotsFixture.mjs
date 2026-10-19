/**
 * The one fixture `shots-board.mjs` stubs the desktop renderer's `window.api` with — every
 * channel `MyTasks` reads to draw the board (`board:tasks`, `project:list`,
 * `mr:mergeRequests`, `chain:links`, `person:list`, `scheduler:activeRuns`), built from the
 * same minimal `Task`/`Project` shapes `board.test.ts`/`agentProjects.test.ts` use, so a field
 * this fixture forgets is a field those suites would already be missing too.
 *
 * Covers every card state named in this step's own plan: a plain backlog card; a human
 * assignee; an agent running at step 2 of 4; waiting-input (the orange ring); stopped/parked;
 * an MR with changes requested; an approved MR; a merged MR in Done; a due date (today and a
 * future one — `dueDate` is not a real `Task` field yet, only carried here for the v9 rewrite
 * steps (F13.21+) to read once it is); an epic; an unread tracker comment; a chained card
 * both waiting on a predecessor and released and ready; a variants leader; and a shelved card.
 */
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

export const PROJECT_ID = 'proj-fx';

/** The one project every fixture task files under — both a ticket project (prefix `FX`) and,
 *  since it carries a `path`, a usable agent/repo project (`hasRepo`, `agentProjectsOf`). */
const project = (over = {}) => ({
  id: PROJECT_ID,
  name: 'Fixture',
  path: 'C:/repos/fixture',
  planPath: '',
  defaultModel: 'sonnet',
  planningModel: null,
  defaultPermissionMode: 'acceptEdits',
  concurrency: 1,
  useWorktrees: true,
  baseBranch: '',
  writeBackPlan: false,
  autoRelease: false,
  autoCreatePr: false,
  autoIntegrate: null,
  autoApprovePlans: false,
  autoApproveMaxSteps: 6,
  planAligned: true,
  jiraEpicKeys: [],
  ticketPrefix: 'FX',
  target: { kind: 'local' },
  instructions: '',
  color: '#0F6CBD',
  createdAt: now,
  ...over,
});

/** The minimal `Task` shape `board.test.ts`'s own `task()` helper uses, plus a native
 *  ticket's `ticketKey` — every fixture row is a native ticket unless it overrides `source`. */
const task = (over) => ({
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
});

export const PEOPLE = [
  {
    id: 'person-human',
    name: 'Wiktor Nowak',
    email: '',
    initials: 'WN',
    color: '#8763B8',
    isMe: false,
    createdAt: now,
  },
];

// --- Backlog ---------------------------------------------------------------------------
const plainBacklog = task({
  id: '1',
  title: 'Command palette actions for every issue field',
  order: 0,
});
const dueToday = task({
  id: '9',
  title: 'Renew the usage-limit banner copy',
  order: 1,
  dueDate: now,
});
const dueFuture = task({
  id: '10',
  title: 'Publish a local workspace to the cloud',
  order: 2,
  dueDate: now + 10 * DAY,
});
const trackerUnread = task({
  id: '12',
  title: 'Reconcile Linear identifiers on sync',
  order: 3,
  source: 'jira',
  ticketKey: undefined,
  externalSource: 'jira',
  externalKey: 'LIN-203',
  externalType: 'Bug',
  latestCommentAt: now - 60_000,
  lastReadCommentAt: now - 2 * DAY,
});
const epicCard = task({
  id: 'epic',
  title: 'M4 · Reach',
  order: 4,
  status: 'in-review',
  issueType: 'epic',
});
const epicChild = task({
  id: '11',
  title: 'Nordic theme tokens',
  order: 5,
  epicTaskId: epicCard.id,
});
const shelved = task({ id: '16', title: 'Audit the automation retry budget', order: 6 });

// --- Todo --------------------------------------------------------------------------------
const humanAssignee = task({
  id: '2',
  title: 'Settings with a probing connection test',
  order: 0,
  assigneeId: 'person-human',
});
const chainWaitingPredecessor = task({
  id: '13a',
  title: 'Wire the retry queue to the dashboard',
  order: 1,
  status: 'in-progress',
});
const chainWaitingSuccessor = task({
  id: '13b',
  title: 'Surface the retry queue in the detail pane',
  order: 2,
});
const chainReadyPredecessor = task({
  id: '14a',
  title: 'Draft the rollout checklist',
  order: 1,
  status: 'done',
});
const chainReadySuccessor = task({ id: '14b', title: 'Publish the release notes', order: 3 });
const variantsLeader = task({
  id: '15',
  title: 'Spike the GraphQL batching approach',
  order: 4,
  pickedVariantId: null,
});
const variantRowA = task({
  id: '15-a',
  title: 'Spike the GraphQL batching approach',
  variantOf: '15',
  variantLabel: 'A',
  status: 'in-progress',
  agentProjectId: PROJECT_ID,
});
const variantRowB = task({
  id: '15-b',
  title: 'Spike the GraphQL batching approach',
  variantOf: '15',
  variantLabel: 'B',
});

// --- In Progress ---------------------------------------------------------------------------
const agentRunningParent = task({
  id: '3',
  title: 'Show Linear identifiers and comments on cards',
  order: 0,
  status: 'in-progress',
  agentProjectId: PROJECT_ID,
  workedAt: now - 5 * 60_000,
});
const agentRunningSteps = [
  task({
    id: '3-s1',
    parentTaskId: '3',
    order: 0,
    title: 'Read the Linear API docs',
    status: 'done',
  }),
  task({
    id: '3-s2',
    parentTaskId: '3',
    order: 1,
    title: 'Add the identifier column',
    status: 'running',
  }),
  task({
    id: '3-s3',
    parentTaskId: '3',
    order: 2,
    title: 'Render it on the card footer',
    status: 'pending',
  }),
  task({
    id: '3-s4',
    parentTaskId: '3',
    order: 3,
    title: 'Backfill existing cards',
    status: 'pending',
  }),
];
const waitingInput = task({
  id: '4',
  title: 'Reconcile duplicate ticket sync',
  order: 1,
  status: 'waiting-input',
  agentProjectId: PROJECT_ID,
  workedAt: now - 60_000,
});
const stoppedParked = task({
  id: '5',
  title: 'Fix flaky worktree cleanup',
  order: 2,
  status: 'stopped',
  stoppedAt: now - 10 * 60_000,
  workedAt: now - 20 * 60_000,
  agentProjectId: PROJECT_ID,
});

// --- In Review -----------------------------------------------------------------------------
const mrChangesRequestedCard = task({
  id: '6',
  title: 'Send review comments back to the agent',
  order: 0,
  status: 'in-review',
});
const mrApprovedCard = task({
  id: '7',
  title: 'Approve the schema migration PR',
  order: 1,
  status: 'in-review',
});

// --- Done ------------------------------------------------------------------------------------
const mrMergedCard = task({
  id: '8',
  title: 'Reconcile Linear issues onto the board',
  order: 0,
  status: 'done',
});

export const TASKS = [
  plainBacklog,
  dueToday,
  dueFuture,
  trackerUnread,
  epicCard,
  epicChild,
  shelved,
  humanAssignee,
  chainWaitingPredecessor,
  chainWaitingSuccessor,
  chainReadyPredecessor,
  chainReadySuccessor,
  variantsLeader,
  variantRowA,
  variantRowB,
  agentRunningParent,
  ...agentRunningSteps,
  waitingInput,
  stoppedParked,
  mrChangesRequestedCard,
  mrApprovedCard,
  mrMergedCard,
];

// `project:list` answers `{ project, tasks }[]` (`apps/client/src/main/ipc.ts`'s own handler),
// not bare `Project[]` — `MyTasks.seed` unwraps it with `projects.map((p) => p.project)`.
export const PROJECTS = [{ project: project(), tasks: [] }];

const mergeRequest = (over) => ({
  id: over.id,
  taskId: over.taskId,
  openedForTaskId: over.taskId,
  provider: 'gitlab',
  repoId: 1,
  projectPath: 'fixture/repo',
  number: over.number,
  title: over.title,
  displayName: null,
  webUrl: `https://gitlab.example/fixture/repo/-/merge_requests/${over.number}`,
  sourceBranch: `fx-${over.number}`,
  targetBranch: 'main',
  state: over.state ?? 'opened',
  draft: false,
  pipelineStatus: over.pipelineStatus ?? 'success',
  pipelineUrl: null,
  headSha: 'abc123',
  lastActedSha: null,
  lastActedAction: null,
  pipelineStages: [],
  approvalsRequired: over.approvalsRequired ?? 1,
  approvalsGiven: over.approvalsGiven ?? 0,
  changesRequested: over.changesRequested ?? false,
  detailedMergeStatus: null,
  hasConflicts: false,
  issueKeys: [],
  latestNoteAt: null,
  lastReadAt: null,
  lastEventAt: null,
  lastEventSeenAt: null,
  updatedAt: now,
  syncedAt: now,
});

export const MERGE_REQUESTS = [
  mergeRequest({
    id: 'mr-6',
    taskId: mrChangesRequestedCard.id,
    number: 190,
    title: 'Send review comments back to the agent',
    changesRequested: true,
    approvalsGiven: 0,
  }),
  mergeRequest({
    id: 'mr-7',
    taskId: mrApprovedCard.id,
    number: 191,
    title: 'Approve the schema migration PR',
    changesRequested: false,
    approvalsRequired: 1,
    approvalsGiven: 1,
  }),
  mergeRequest({
    id: 'mr-8',
    taskId: mrMergedCard.id,
    number: 124,
    title: 'Reconcile Linear issues onto the board',
    state: 'merged',
  }),
];

export const CHAIN_LINKS = [
  {
    id: 'link-13',
    fromTaskId: chainWaitingPredecessor.id,
    toTaskId: chainWaitingSuccessor.id,
    gate: 'after-merge',
    createdAt: now,
  },
  {
    id: 'link-14',
    fromTaskId: chainReadyPredecessor.id,
    toTaskId: chainReadySuccessor.id,
    gate: 'after-merge',
    createdAt: now,
  },
];

export const ACTIVE_RUNS = [{ taskId: '3-s2', runId: 'run-3-s2' }];

// `board.hiddenColumns` is set by `shots-board.mjs` itself (it already imports
// `DEFAULT_SETTINGS` to merge against) to an explicit `[]` — absent means "legacy", which
// hides Done unless a tracker's own `showDoneColumn` is on (`hiddenBoardColumns` in
// `@tm/shared/settings`), and this fixture needs every column, including Done, visible.
export const SETTINGS_OVERRIDES = {
  boardScopeId: 'all',
  shelvedCardIds: [shelved.id],
};
