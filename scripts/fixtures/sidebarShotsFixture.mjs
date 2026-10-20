/**
 * The fixture `shots-sidebar.mjs` stubs the desktop renderer's `window.api` with — three
 * ticket projects, shaped to exercise `resolveSidebarProject` (F13.17) the way the old
 * `.find(ownsTickets)` order never could:
 *
 *   - **Travelbook** is created first and owns zero tickets — the project the OLD "whichever
 *     ticket project is oldest" rule would have shown forever, empty, regardless of where the
 *     actual open work was.
 *   - **TM** is second, with a milestone (`M5`), two epics and a handful of tickets carrying
 *     `epicTaskId`/`milestoneId` — the project with the most open tickets.
 *   - **EM** is third, with some open tickets of its own, but fewer than TM's — enough to prove
 *     the resolver is comparing counts, not just "has any ticket at all".
 *
 * With `localStorage` empty (no remembered device choice), `resolveSidebarProject` picks TM —
 * the most-open-tickets fallback this step's shots are here to prove.
 */
const now = Date.now();

export const TRAVELBOOK_ID = 'proj-travelbook';
export const TM_ID = 'proj-tm';
export const EM_ID = 'proj-em';

const project = (id, name, ticketPrefix, over = {}) => ({
  id,
  name,
  path: '',
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
  readyLanes: 3,
  autoDoneOnLand: false,
  autoVisualSignOff: false,
  autoVisualSignOffMaxRounds: 2,
  autoMergeBy: 'forge',
  planAligned: true,
  jiraEpicKeys: [],
  ticketPrefix,
  target: { kind: 'local' },
  instructions: '',
  color: '',
  createdAt: now,
  ...over,
});

const TRAVELBOOK = project(TRAVELBOOK_ID, 'Travelbook', 'TRAVEL', {
  createdAt: now - 3 * 86_400_000,
});
const TM = project(TM_ID, 'TM', 'TM', { createdAt: now - 2 * 86_400_000 });
const EM = project(EM_ID, 'EM', 'EM', { createdAt: now - 86_400_000 });

/** The minimal `Task` shape `board.test.ts`'s own `task()` helper uses, plus a native
 *  ticket's `ticketKey` — every fixture row is a native ticket unless it overrides `source`. */
const ticket = (projectId, prefix, num, over) => ({
  id: over.id,
  projectId,
  phase: '',
  title: over.title ?? 'Untitled',
  status: over.status ?? 'pending',
  sessionId: null,
  order: over.order ?? 0,
  dependsOn: [],
  source: 'ticket',
  isContract: false,
  isScaffold: false,
  ticketKey: `${prefix}-${num}`,
  ...over,
});

export const M5_ID = 'tm-milestone-m5';

const tmEpic1 = ticket(TM_ID, 'TM', 10, {
  id: 'tm-epic-1',
  title: 'Design system rollout',
  order: 0,
  issueType: 'epic',
  milestoneId: M5_ID,
});
const tmEpic2 = ticket(TM_ID, 'TM', 11, {
  id: 'tm-epic-2',
  title: 'Sync reliability',
  order: 1,
  issueType: 'epic',
  milestoneId: M5_ID,
});
const tmChild1 = ticket(TM_ID, 'TM', 101, {
  id: 'tm-t1',
  title: 'Port TaskCard to the v9 anatomy',
  order: 0,
  issueType: 'task',
  milestoneId: M5_ID,
  epicTaskId: tmEpic1.id,
});
const tmChild2 = ticket(TM_ID, 'TM', 102, {
  id: 'tm-t2',
  title: 'Retheme the board columns',
  order: 1,
  status: 'in-progress',
  issueType: 'task',
  milestoneId: M5_ID,
  epicTaskId: tmEpic1.id,
});
const tmChild3 = ticket(TM_ID, 'TM', 103, {
  id: 'tm-t3',
  title: 'Retry the JIRA sync outbox on 429',
  order: 2,
  issueType: 'bug',
  milestoneId: M5_ID,
  epicTaskId: tmEpic2.id,
});
const tmChild4 = ticket(TM_ID, 'TM', 104, {
  id: 'tm-t4',
  title: 'Surface a stalled sync in the status bar',
  order: 3,
  issueType: 'task',
  milestoneId: M5_ID,
  epicTaskId: tmEpic2.id,
});
const tmOrphan = ticket(TM_ID, 'TM', 105, {
  id: 'tm-t5',
  title: 'Audit the milestone archive sweep',
  order: 4,
  issueType: 'task',
  milestoneId: M5_ID,
});
const tmUnmilestoned = ticket(TM_ID, 'TM', 106, {
  id: 'tm-t6',
  title: 'Draft the Q3 roadmap doc',
  order: 5,
  issueType: 'story',
});

export const TM_MILESTONES = [
  {
    id: M5_ID,
    projectId: TM_ID,
    name: 'M5',
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: now - 2 * 86_400_000,
  },
];

export const TM_TICKETS = [
  tmEpic1,
  tmEpic2,
  tmChild1,
  tmChild2,
  tmChild3,
  tmChild4,
  tmOrphan,
  tmUnmilestoned,
];

const emTicket1 = ticket(EM_ID, 'EM', 201, {
  id: 'em-t1',
  title: 'Rotate the deploy key',
  order: 0,
});
const emTicket2 = ticket(EM_ID, 'EM', 202, {
  id: 'em-t2',
  title: 'Document the rollback runbook',
  order: 1,
  status: 'in-progress',
});
const emTicket3 = ticket(EM_ID, 'EM', 203, {
  id: 'em-t3',
  title: 'Trim the stale feature flags',
  order: 2,
});

export const EM_TICKETS = [emTicket1, emTicket2, emTicket3];

export const TASKS_BY_PROJECT = {
  [TRAVELBOOK_ID]: [],
  [TM_ID]: TM_TICKETS,
  [EM_ID]: EM_TICKETS,
};

export const MILESTONES_BY_PROJECT = {
  [TRAVELBOOK_ID]: [],
  [TM_ID]: TM_MILESTONES,
  [EM_ID]: [],
};

// `project:list` answers `{ project, tasks }[]` (`apps/client/src/main/ipc.ts`'s own handler),
// not bare `Project[]` — `App`'s boot effect unwraps it with `projects.map((p) => p.project)`
// and tallies `openCounts` from `projects.flatMap((p) => p.tasks)`.
export const PROJECTS = [
  { project: TRAVELBOOK, tasks: TASKS_BY_PROJECT[TRAVELBOOK_ID] },
  { project: TM, tasks: TASKS_BY_PROJECT[TM_ID] },
  { project: EM, tasks: TASKS_BY_PROJECT[EM_ID] },
];

export const SETTINGS_OVERRIDES = {
  boardScopeId: 'all',
};
