/*
 * Temporary: seed the DEMO profile DB with dummy data so every screen has content.
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe seed-demo.cjs
 * Targets %APPDATA%/claude-orchestrator-demo (never the real DB). Delete when done.
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath =
  process.argv[2] || path.join(process.env.APPDATA, 'claude-orchestrator-demo', 'orchestrator.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Fixed "now" so repeated seeds are deterministic-ish; close enough to real time.
const now = Date.now();

// ---------------------------------------------------------------- projects ---
const projects = [
  {
    id: 'demo-agent-repo',
    name: 'Demo Agent Repo',
    path: 'C:\\Repositories\\demo-agent-repo',
    planPath: '',
    defaultModel: 'sonnet',
    defaultPermissionMode: 'acceptEdits',
    concurrency: 1,
    useWorktrees: 1,
    writeBackPlan: 0,
    planAligned: 1,
    kind: 'agent',
    jiraEpicKeys: JSON.stringify(['DEMO-100', 'PLAT-1']),
    createdAt: now - 9 * DAY,
  },
  {
    id: 'demo-web-app',
    name: 'Demo Web App',
    path: 'C:\\Repositories\\demo-web-app',
    planPath: '',
    defaultModel: 'opus',
    defaultPermissionMode: 'plan',
    concurrency: 1,
    useWorktrees: 1,
    writeBackPlan: 0,
    planAligned: 1,
    kind: 'agent',
    jiraEpicKeys: JSON.stringify(['WEB-1']),
    createdAt: now - 6 * DAY,
  },
  {
    id: 'demo-plan',
    name: 'Demo Plan Project',
    path: 'C:\\Repositories\\demo-plan-project',
    planPath: 'C:\\Repositories\\demo-plan-project\\plan.md',
    defaultModel: 'sonnet',
    defaultPermissionMode: 'acceptEdits',
    concurrency: 2,
    useWorktrees: 1,
    writeBackPlan: 1,
    planAligned: 1,
    kind: 'plan',
    jiraEpicKeys: null,
    createdAt: now - 12 * DAY,
  },
];

const insProject = db.prepare(`
  INSERT INTO projects (id, name, path, planPath, defaultModel, defaultPermissionMode,
                        concurrency, useWorktrees, writeBackPlan, planAligned, kind,
                        jiraEpicKeys, createdAt)
  VALUES (@id, @name, @path, @planPath, @defaultModel, @defaultPermissionMode,
          @concurrency, @useWorktrees, @writeBackPlan, @planAligned, @kind,
          @jiraEpicKeys, @createdAt)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, path = excluded.path, planPath = excluded.planPath,
    kind = excluded.kind, jiraEpicKeys = excluded.jiraEpicKeys
`);

// ------------------------------------------------------------------- tasks ---
const TASK_COLS = [
  'id', 'projectId', 'phase', 'title', 'status', 'sessionId', 'order', 'source',
  'dependsOn', 'isContract', 'isScaffold', 'type', 'externalSource', 'externalKey',
  'externalId', 'externalUrl', 'externalStatus', 'externalStatusCategory',
  'externalPriority', 'externalType', 'externalLabel', 'externalParentKey',
  'externalDescription', 'preBlockStatus', 'lastReadCommentAt', 'latestCommentAt',
  'agentProjectId', 'agentMode', 'agentModel', 'parentTaskId', 'description', 'agentPlan',
];
const insTask = db.prepare(`
  INSERT INTO tasks (${TASK_COLS.map((c) => (c === 'order' ? '"order"' : c)).join(', ')})
  VALUES (${TASK_COLS.map((c) => '@' + c).join(', ')})
  ON CONFLICT(id) DO NOTHING
`);

/** Fill every column so the prepared statement always binds. */
function task(t) {
  const base = {
    sessionId: null, source: 'plan', dependsOn: null, isContract: 0, isScaffold: 0,
    type: null, externalSource: null, externalKey: null, externalId: null,
    externalUrl: null, externalStatus: null, externalStatusCategory: null,
    externalPriority: null, externalType: null, externalLabel: null,
    externalParentKey: null, externalDescription: null, preBlockStatus: null,
    lastReadCommentAt: null, latestCommentAt: null, agentProjectId: null,
    agentMode: null, agentModel: null, parentTaskId: null, description: null,
    agentPlan: null,
  };
  return { ...base, ...t };
}

const JIRA = 'https://jira.example.com/browse/';

/** A JIRA-mirrored card on the Personal board. */
function jira(o) {
  return task({
    projectId: 'personal',
    phase: 'JIRA',
    source: 'jira',
    externalSource: 'jira',
    externalId: String(10000 + o.order),
    externalUrl: JIRA + o.externalKey,
    ...o,
  });
}

/** An internal (ad-hoc) card on the Personal board. */
function adhoc(o) {
  return task({ projectId: 'personal', phase: 'Personal', source: 'adhoc', ...o });
}

/**
 * One step of a card (Phase 11). Mirrors `store.addSubtask`: same board as the
 * parent, `order` counted among siblings, inherits where the parent runs, and is
 * forced to `bypassPermissions` — an approved plan runs full-auto.
 */
function step(parent, o) {
  return task({
    projectId: 'personal',
    phase: parent.phase ?? 'Personal',
    source: 'adhoc',
    parentTaskId: parent.id,
    agentProjectId: parent.agentProjectId ?? null,
    agentModel: parent.agentModel ?? null,
    agentMode: parent.agentProjectId ? 'bypassPermissions' : null,
    ...o,
  });
}

/** The plan the agent produced for DEMO-101, as `ExitPlanMode` handed it over. */
const PLAN_101 = `# Fix the empty-board crash

## Context

\`BoardView\` assumes at least one column and indexes \`columns[0]\` while building the
drag context, so a project with no columns throws before the empty state can render.

## Reproduce it with a failing test

Add a render test for a project with zero columns. It should assert the empty state,
and today it throws a TypeError — that failing test is the contract for the fix.

## Guard the column access

Make the column lookup total: no columns means no drag context and no selection.
Return the empty state early rather than defending each access one by one.

## Render a real empty state

A white screen is the bug the user actually reported. Show the same empty-state
component the task list uses, with a "Add a column" call to action.

## Out of scope

Column creation itself, and the plan-project board — this is the personal board only.`;

/** DEMO-102's plan: the chain that is currently parked on a failed step. */
const PLAN_102 = `# Keyboard shortcuts for the task board

## Add a key-binding map

One module owning the bindings (j/k, Enter, 1-4) so the view stays declarative and
the bindings are unit-testable without rendering anything.

## Suppress shortcuts while typing

Ignore key events whose target is an input, textarea, or contenteditable — otherwise
typing "j" in the comment box moves the selection.

## Wire the bindings into BoardView

Selection state, Enter to open the card, and 1-4 to move a card between columns via
the existing status mutation.

## Document the shortcuts

A short table in the README plus a "?" overlay listing them.`;

const personalTasks = [
  jira({
    id: 'demo-t-101', order: 1, externalKey: 'DEMO-101',
    title: 'Fix crash when opening an empty board',
    // Planned, approved, and part-way through its chain (2 of 3 steps done).
    agentProjectId: 'demo-agent-repo', agentMode: 'plan', agentModel: 'sonnet',
    agentPlan: PLAN_101,
    status: 'in-progress', externalStatus: 'To Do', externalStatusCategory: 'To Do',
    externalPriority: 'High', externalType: 'Bug', externalLabel: 'ui',
    externalParentKey: 'DEMO-100',
    externalDescription:
      'Opening a project whose board has no columns throws a TypeError in BoardView.\n\n' +
      'Steps to reproduce:\n1. Create an empty project\n2. Open the Board tab\n\n' +
      'Expected: an empty state. Actual: white screen + console error.',
    // Newer comment than the last one read -> orange "unread" frame.
    latestCommentAt: now - 2 * HOUR, lastReadCommentAt: now - 2 * DAY,
  }),
  jira({
    id: 'demo-t-102', order: 2, externalKey: 'DEMO-102',
    title: 'Add keyboard shortcuts to the task board',
    status: 'in-progress', externalStatus: 'In Progress',
    externalStatusCategory: 'In Progress', externalPriority: 'Medium',
    externalType: 'Story', externalLabel: 'ux', externalParentKey: 'DEMO-100',
    externalDescription:
      'Support j/k to move the selection, Enter to open the card, and 1-4 to move a ' +
      'card between columns. Shortcuts must not fire while a text field has focus.',
    // Delegated to an agent -> bot glyph on the card. Its chain is parked on a
    // failed step: marking that step done resumes the rest.
    agentProjectId: 'demo-agent-repo', agentMode: 'plan', agentModel: 'sonnet',
    agentPlan: PLAN_102,
    latestCommentAt: now - 3 * DAY, lastReadCommentAt: now - 3 * DAY + 60_000,
  }),
  jira({
    id: 'demo-t-103', order: 3, externalKey: 'DEMO-103',
    title: 'Investigate slow JIRA sync on large boards',
    // Delegated and mid-flight. NOTE: 'waiting-input' (the orange "agent is asking
    // you something" frame) can't be seeded — reconcileInterruptedTasks resets any
    // waiting-input/running task to pending on boot. Only a live run shows it.
    status: 'in-progress', externalStatus: 'In Progress',
    externalStatusCategory: 'In Progress', externalPriority: 'High',
    externalType: 'Bug', externalLabel: 'perf', externalParentKey: 'DEMO-100',
    externalDescription:
      'A board with ~400 issues takes 40s to sync. Profile the search call and the ' +
      'per-issue comment fetch, then propose a fix.',
    agentProjectId: 'demo-agent-repo', agentMode: 'acceptEdits', agentModel: 'opus',
    sessionId: 'demo-session-103',
  }),
  jira({
    id: 'demo-t-104', order: 4, externalKey: 'WEB-14',
    title: 'Dark-mode contrast fixes on the settings pane',
    status: 'pending', externalStatus: 'Selected for Development',
    externalStatusCategory: 'To Do', externalPriority: 'Low', externalType: 'Task',
    externalLabel: 'a11y', externalParentKey: 'WEB-1',
    externalDescription:
      'Several labels fail WCAG AA in dark mode. Audit the settings pane and switch ' +
      'hardcoded greys to theme tokens.',
  }),
  jira({
    id: 'demo-t-105', order: 5, externalKey: 'PLAT-7',
    title: 'Upgrade Electron to 33 and re-test native modules',
    status: 'blocked', preBlockStatus: 'pending', externalStatus: 'To Do',
    externalStatusCategory: 'To Do', externalPriority: 'High', externalType: 'Task',
    externalLabel: 'platform', externalParentKey: 'PLAT-1',
    externalDescription:
      'better-sqlite3 must be rebuilt for the new ABI. Blocked until the release ' +
      'branch is cut.',
  }),
  jira({
    id: 'demo-t-106', order: 6, externalKey: 'DEMO-99',
    title: 'Rename the Attention tab to Inbox',
    status: 'done', externalStatus: 'Done', externalStatusCategory: 'Done',
    externalPriority: 'Low', externalType: 'Task', externalParentKey: 'DEMO-100',
    externalDescription: 'Pure rename, no behaviour change.',
  }),
  adhoc({
    id: 'demo-t-201', order: 7, title: 'Write the release notes for v0.22.0',
    status: 'pending', type: 'feature',
  }),
  adhoc({
    id: 'demo-t-202', order: 8, title: 'Reply to the design review comments',
    status: 'in-progress', type: 'feature',
  }),
  adhoc({
    id: 'demo-t-203', order: 9,
    title: 'Try delegating a ticket to an agent (end-to-end)',
    status: 'pending', type: 'feature',
  }),
  adhoc({
    id: 'demo-t-204', order: 10, title: 'Refactor the token-usage query',
    status: 'pending', type: 'bug',
    // Assigned but not started -> glyph without a run.
    agentProjectId: 'demo-web-app', agentMode: 'acceptEdits', agentModel: 'opus',
  }),
  adhoc({
    id: 'demo-t-205', order: 11, title: 'Renew the signing certificate',
    status: 'done', type: 'feature',
  }),
  adhoc({
    id: 'demo-t-206', order: 12, title: 'Chase the vendor about the SSO rollout',
    status: 'blocked', preBlockStatus: 'in-progress', type: 'feature',
  }),
  // A card whose transcript exercises the whole markdown grammar the chat renders:
  // headings, both list kinds, a quote, inline code, bold/italic, a link, and fenced
  // blocks in three languages (one wide enough to scroll inside its panel).
  adhoc({
    id: 'demo-t-207', order: 14, title: 'Write the upgrade guide for the storage layer',
    status: 'in-progress', type: 'feature',
    agentProjectId: 'demo-agent-repo', agentMode: 'acceptEdits', agentModel: 'opus',
    sessionId: 'demo-session-207',
    externalDescription:
      'The store moved from a single JSON file to SQLite. Write the guide an existing ' +
      'install needs: what changes, how to migrate, and how to roll back.',
  }),
  // Phase 12: the composer's "a usage limit is holding all work" refusal. Delegated,
  // has a session to resume, but parked behind the gate — so Chat is offered and off.
  jira({
    id: 'demo-t-107', order: 13, externalKey: 'DEMO-104',
    title: 'Batch the JIRA comment fetch',
    status: 'blocked-by-limit', externalStatus: 'In Progress',
    externalStatusCategory: 'In Progress', externalPriority: 'Medium',
    externalType: 'Task', externalLabel: 'perf', externalParentKey: 'DEMO-100',
    externalDescription:
      'One request per issue is what makes the sync slow. Batch the comment fetch and ' +
      'keep the unread marker honest.',
    agentProjectId: 'demo-agent-repo', agentMode: 'acceptEdits', agentModel: 'sonnet',
    sessionId: 'demo-session-107',
  }),
];

/** Look a parent up by id so a step can inherit from it. */
const byId = (id) => personalTasks.find((t) => t.id === id);

// ------------------------------------------------------------------- steps ---
// Three chains, each showing a different state of the Phase 11 feature:
//   demo-t-101 — an approved plan mid-flight (2/3 done, next step pending)
//   demo-t-102 — a chain parked on a FAILED step (the rest never started)
//   demo-t-201 — steps written by hand, no planning round and no agent
// A *running* step can't be seeded: reconcileInterruptedTasks resets it on boot.
const stepTasks = [
  step(byId('demo-t-101'), {
    id: 'demo-step-101-1', order: 1, status: 'done',
    title: 'Reproduce it with a failing test',
    description:
      'Add a render test for a project with zero columns. It should assert the empty ' +
      'state, and today it throws a TypeError — that failing test is the contract for ' +
      'the fix.',
  }),
  step(byId('demo-t-101'), {
    id: 'demo-step-101-2', order: 2, status: 'done',
    title: 'Guard the column access',
    description:
      'Make the column lookup total: no columns means no drag context and no ' +
      'selection. Return the empty state early rather than defending each access.',
  }),
  step(byId('demo-t-101'), {
    id: 'demo-step-101-3', order: 3, status: 'pending',
    title: 'Render a real empty state',
    description:
      'A white screen is the bug the user actually reported. Show the same empty-state ' +
      'component the task list uses, with a "Add a column" call to action.',
  }),

  step(byId('demo-t-102'), {
    id: 'demo-step-102-1', order: 1, status: 'done',
    title: 'Add a key-binding map',
    description:
      'One module owning the bindings (j/k, Enter, 1-4) so the view stays declarative ' +
      'and the bindings are unit-testable without rendering anything.',
  }),
  step(byId('demo-t-102'), {
    id: 'demo-step-102-2', order: 2, status: 'failed',
    title: 'Suppress shortcuts while typing',
    description:
      'Ignore key events whose target is an input, textarea, or contenteditable — ' +
      'otherwise typing "j" in the comment box moves the selection.',
  }),
  step(byId('demo-t-102'), {
    id: 'demo-step-102-3', order: 3, status: 'pending',
    title: 'Wire the bindings into BoardView',
    description:
      'Selection state, Enter to open the card, and 1-4 to move a card between ' +
      'columns via the existing status mutation.',
  }),
  step(byId('demo-t-102'), {
    id: 'demo-step-102-4', order: 4, status: 'pending',
    title: 'Document the shortcuts',
    description: 'A short table in the README plus a "?" overlay listing them.',
  }),

  step(byId('demo-t-201'), {
    id: 'demo-step-201-1', order: 1, status: 'pending',
    title: 'Collect the commits since v0.22.0',
    description: 'git log v0.22.0..HEAD, grouped by feature area.',
  }),
  step(byId('demo-t-201'), {
    id: 'demo-step-201-2', order: 2, status: 'pending',
    title: 'Draft the notes and screenshot the new board',
    description: 'One paragraph per feature, in the voice of the previous release notes.',
  }),
];

// Plan-driven tasks, mirroring C:\Repositories\demo-plan-project\plan.md.
const P1 = 'Phase 1 — Foundations';
const P2 = 'Phase 2 — CLI';
const planTasks = [
  task({ id: 'demo-p-1', projectId: 'demo-plan', phase: P1, order: 1, title: 'Scaffold the package and tooling', status: 'done' }),
  task({ id: 'demo-p-2', projectId: 'demo-plan', phase: P1, order: 2, title: 'Add a config loader', status: 'done' }),
  task({ id: 'demo-p-3', projectId: 'demo-plan', phase: P1, order: 3, title: 'Define the shared types module', status: 'done', isContract: 1 }),
  task({ id: 'demo-p-4', projectId: 'demo-plan', phase: P1, order: 4, title: 'Implement the CSV parser', status: 'pending', dependsOn: JSON.stringify(['Define the shared types module']) }),
  task({ id: 'demo-p-5', projectId: 'demo-plan', phase: P1, order: 5, title: 'Implement the JSON writer', status: 'failed', dependsOn: JSON.stringify(['Define the shared types module']) }),
  task({ id: 'demo-p-6', projectId: 'demo-plan', phase: P2, order: 6, title: 'Wire an argv parser', status: 'pending', dependsOn: JSON.stringify(['Implement the CSV parser']) }),
  task({ id: 'demo-p-7', projectId: 'demo-plan', phase: P2, order: 7, title: 'Add a --dry-run flag', status: 'pending' }),
  task({ id: 'demo-p-8', projectId: 'demo-plan', phase: P2, order: 8, title: 'Write the usage docs', status: 'pending' }),
];

// ---------------------------------------------------------------- activity ---
const insActivity = db.prepare(`
  INSERT INTO task_activity (projectId, taskId, kind, body, fromStatus, toStatus, createdAt)
  VALUES (@projectId, @taskId, @kind, @body, @fromStatus, @toStatus, @createdAt)
`);
const comment = (taskId, body, at, projectId = 'personal') => ({
  projectId, taskId, kind: 'comment', body, fromStatus: null, toStatus: null, createdAt: at,
});
const statusChange = (taskId, from, to, at, projectId = 'personal') => ({
  projectId, taskId, kind: 'status', body: null, fromStatus: from, toStatus: to, createdAt: at,
});
/** A message the human sent TO the agent (Phase 12) — the base-blue bubble. */
const chat = (taskId, body, at, projectId = 'personal') => ({
  projectId, taskId, kind: 'chat', body, fromStatus: null, toStatus: null, createdAt: at,
});

const activity = [
  comment('demo-t-101', 'Reproduced on 0.21.0 — only when the project has zero columns.', now - 2 * DAY),
  comment('demo-t-101', 'Probably the same root cause as the empty-plan crash we fixed last month.', now - 30 * HOUR),
  statusChange('demo-t-101', 'pending', 'in-progress', now - 26 * HOUR),
  comment('demo-t-101', 'Plan approved — 3 steps created, running one session each.', now - 26 * HOUR + 60_000),
  statusChange('demo-t-102', 'pending', 'in-progress', now - 4 * DAY),
  comment('demo-t-102', 'Step 2 failed (the shortcut test suite is red). The chain is parked until it is marked done.', now - 26 * HOUR),
  comment('demo-t-102', 'Delegated to the Demo Agent Repo in plan mode — reviewing the plan before letting it edit.', now - 3 * DAY),
  comment('demo-t-103', 'Assigned to an agent; the sync numbers below came out of its own profiling run.', now - 5 * HOUR - 60_000),
  // Phase 12: what the human said TO the agent, mid-run and after it ended.
  chat('demo-t-103', 'Before you go further — is the inline comment field capped per issue or per response?', now - 5 * HOUR + 12 * 60_000),
  chat('demo-t-103', 'Leave the test red for now, I want to see it fail in CI first.', now - 4 * HOUR),
  statusChange('demo-t-105', 'pending', 'blocked', now - 6 * DAY),
  comment('demo-t-105', 'Blocked on the release branch. Re-check on Monday.', now - 6 * DAY + HOUR),
  statusChange('demo-t-106', 'in-progress', 'done', now - 8 * DAY),
  comment('demo-t-202', 'Left three comments on the Figma file; waiting on the designer.', now - 20 * HOUR),
  statusChange('demo-t-205', 'in-progress', 'done', now - 11 * DAY),
  comment('demo-t-206', 'Vendor says the SSO tenant lands next sprint.', now - 2 * DAY),
  chat('demo-t-207', 'Write the upgrade guide as markdown — headings, the commands in fenced blocks, and a table of the row counts.', now - 3 * HOUR + 55_000),
  comment('demo-t-207', 'Ship this in docs/ once the numbers are checked against a real v0.9 profile.', now - 2 * HOUR),
];

// ------------------------------------------------- transcript (Phase 12) ---
// The Chat tab renders the timeline as TURNS, so the demo needs a real transcript:
// agent prose in markdown (headings, lists, inline code, a fenced block), a run of
// tool work to fold into one "Worked with N tools" line, a sub-agent to expand under
// it, a failed tool + stderr (which are never folded away), and a closing result.
const insEvent = db.prepare(`
  INSERT INTO task_events (projectId, taskId, runId, event, createdAt)
  VALUES (@projectId, @taskId, @runId, @event, @createdAt)
`);
const ev = (taskId, runId, event, at, projectId = 'demo-agent-repo') => ({
  projectId, taskId, runId, event: JSON.stringify(event), createdAt: at,
});

const MIN = 60_000;
/** DEMO-103's run, five hours ago: the card you can chat with (it has a session). */
const t0 = now - 5 * HOUR;
const ANSWER_103 = `## What the 40s is actually spent on

Two calls dominate, and only one of them is the search:

- \`GET /search\` with \`maxResults=100\` — **1.9s** for 400 issues across 4 pages.
- \`GET /issue/{key}/comment\`, **once per issue** — 400 sequential requests, ~95ms
  each. That is the other 38 seconds.

The comment fetch is the bug. \`jiraSync.ts\` asks for comments issue by issue because
the unread marker needs the newest comment date, but \`/search\` can return it inline:

\`\`\`ts
// one request instead of N: ask the search for the comment field
const fields = 'summary,status,priority,comment';
const issues = await client.search(jql, 100, [fields]);
\`\`\`

That drops the sync to roughly **2.5s**. See the
[JIRA search docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) for the
field list — \`comment\` is capped at the newest 20 per issue, which is more than the
unread marker needs.`;

/** Every construct the chat's markdown reader understands, in one answer. */
const ANSWER_207 = `# Upgrading the storage layer

The store used to be a single \`orchestrator.json\` rewritten on every change. It is now
SQLite, so a v0.9 install has to migrate **once** — after that nothing about the upgrade
path is special.

## What actually changes

1. Writes become transactional; a crash mid-write can no longer truncate the file.
2. Reads are indexed, so the board stops re-parsing the whole store to draw one column.
3. The file moves: \`%APPDATA%/claude-orchestrator/orchestrator.db\`.

> The old JSON file is **not** deleted. Keep it until you have run the new version once
> and seen your projects on the board — it is the only rollback you have.

## Migrating

\`\`\`bash
# from the repo root, with the app CLOSED
node scripts/migrate-json-to-sqlite.mjs \\
  --input "$APPDATA/claude-orchestrator/orchestrator.json" \\
  --output "$APPDATA/claude-orchestrator/orchestrator.db"
\`\`\`

The migration is *idempotent*: running it twice leaves one copy of every row, because
each table has a natural key and the writer upserts on it.

\`\`\`ts
const insertTask = db.prepare(
  \`INSERT INTO tasks (id, projectId, title, status) VALUES (@id, @projectId, @title, @status)
   ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status\`,
);
\`\`\`

### Verifying

Open the app and check the counts against the old file:

\`\`\`sql
SELECT status, COUNT(*) AS n FROM tasks GROUP BY status ORDER BY n DESC;
\`\`\`

| Table | Rows before | Rows after |
|---|---|---|
| projects | 4 | 4 |
| tasks | 128 | 128 |

If they differ, roll back by deleting the \`.db\` and reinstalling the previous version —
see [the release notes](https://example.com/releases/v0.10.0) for the download.

## Rolling back

Delete \`orchestrator.db\`, put the JSON file back where it was, and install the older
build. No data is lost, because *nothing* in the migration writes to the JSON.`;

const events = [
  ev('demo-t-207', 'demo-run-207', { kind: 'assistant', text: 'Reading the migration script and the old store shape before I write anything.' }, now - 3 * HOUR, 'demo-agent-repo'),
  ev('demo-t-207', 'demo-run-207', { kind: 'tool-use', name: 'Read', toolId: 'tg1', input: { file_path: 'scripts/migrate-json-to-sqlite.mjs' } }, now - 3 * HOUR + 30_000),
  ev('demo-t-207', 'demo-run-207', { kind: 'tool-result', toolId: 'tg1', isError: false }, now - 3 * HOUR + 35_000),
  ev('demo-t-207', 'demo-run-207', { kind: 'tool-use', name: 'Grep', toolId: 'tg2', input: { pattern: 'ON CONFLICT' } }, now - 3 * HOUR + 40_000),
  ev('demo-t-207', 'demo-run-207', { kind: 'tool-result', toolId: 'tg2', isError: false }, now - 3 * HOUR + 45_000),
  ev('demo-t-207', 'demo-run-207', { kind: 'assistant', text: ANSWER_207 }, now - 3 * HOUR + 60_000),
  ev('demo-t-207', 'demo-run-207', { kind: 'result', success: true, resultText: '', costUsd: 0.11, durationMs: 120_000, stopReason: null, terminalReason: null, usage: null }, now - 3 * HOUR + 65_000),

  ev('demo-t-103', 'demo-run-103', { kind: 'started', sessionId: 'demo-session-103', model: 'opus', cwd: 'C:/Repositories/demo-agent-repo', permissionMode: 'acceptEdits' }, t0),
  ev('demo-t-103', 'demo-run-103', { kind: 'assistant', text: 'Reading the sync path first — I want to see what runs per issue.' }, t0 + 1 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'thinking', text: 'start from jiraSync' }, t0 + 2 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-use', name: 'Grep', toolId: 'tu1', input: { pattern: 'getComments' } }, t0 + 2 * MIN + 5_000),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-result', toolId: 'tu1', isError: false }, t0 + 2 * MIN + 9_000),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-use', name: 'Read', toolId: 'tu2', input: { file_path: 'src/main/jira/jiraSync.ts' } }, t0 + 3 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-result', toolId: 'tu2', isError: false }, t0 + 3 * MIN + 4_000),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-use', name: 'Task', toolId: 'tu3', input: { description: 'time the comment fetch against a 400-issue board' } }, t0 + 4 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-result', toolId: 'tu3', isError: false }, t0 + 9 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'assistant', text: ANSWER_103 }, t0 + 10 * MIN),
  // The human interrupts mid-run (a `chat` activity row lands here, see below), and
  // the agent answers it.
  ev('demo-t-103', 'demo-run-103', { kind: 'assistant', text: 'Good question — the cap is per issue, not per response, so a busy ticket still gives us its newest 20. I checked one with 60 comments and the newest date matched.' }, t0 + 13 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-use', name: 'Bash', toolId: 'tu4', input: { command: 'pnpm test jiraSync' } }, t0 + 14 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'tool-result', toolId: 'tu4', isError: true }, t0 + 14 * MIN + 30_000),
  ev('demo-t-103', 'demo-run-103', { kind: 'stderr', text: 'jiraSync.test.ts: 1 failed — expected 400 requests, received 1' }, t0 + 14 * MIN + 31_000),
  ev('demo-t-103', 'demo-run-103', { kind: 'assistant', text: 'That failure is the old test asserting the per-issue fetch. I have left it red rather than rewriting the assertion behind your back — say the word and I will update it to expect the batched call.' }, t0 + 15 * MIN),
  ev('demo-t-103', 'demo-run-103', { kind: 'result', success: true, resultText: '', costUsd: 0.42, durationMs: 900_000, stopReason: null, terminalReason: null, usage: null }, t0 + 15 * MIN + 5_000),

  // The step that stopped DEMO-102's chain: opening it should explain itself, and the
  // parent's pane offers "Run this step again".
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'assistant', text: 'Adding the guard in `useBoardShortcuts` and a test for typing in a textarea.' }, now - 27 * HOUR),
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'tool-use', name: 'Edit', toolId: 'ts1', input: { file_path: 'src/hooks/useBoardShortcuts.ts' } }, now - 27 * HOUR + MIN),
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'tool-result', toolId: 'ts1', isError: false }, now - 27 * HOUR + MIN + 3_000),
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'tool-use', name: 'Bash', toolId: 'ts2', input: { command: 'pnpm test' } }, now - 27 * HOUR + 2 * MIN),
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'tool-result', toolId: 'ts2', isError: true }, now - 27 * HOUR + 3 * MIN),
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'result', success: false, resultText: '', costUsd: 0.08, durationMs: 210_000, stopReason: 'error', terminalReason: null, usage: null }, now - 26 * HOUR - 50 * MIN),
  ev('demo-step-102-2', 'demo-run-102-2', { kind: 'assistant', text: 'Task parked after failure: the shortcut suite is red (3 failing).' }, now - 26 * HOUR - 49 * MIN),
];

// ------------------------------------------------------------ token usage ---
const insUsage = db.prepare(`
  INSERT INTO token_usage (source, projectId, taskId, runId, inputTokens, outputTokens,
                           cacheCreationTokens, cacheReadTokens, totalTokens, costUsd, createdAt)
  VALUES (@source, @projectId, @taskId, @runId, @inputTokens, @outputTokens,
          @cacheCreationTokens, @cacheReadTokens, @totalTokens, @costUsd, @createdAt)
`);

/** Deterministic pseudo-random so re-seeding gives the same chart. */
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const usageRows = [];
const usageTargets = [
  { projectId: 'demo-agent-repo', taskId: 'demo-t-102' },
  { projectId: 'demo-agent-repo', taskId: 'demo-t-103' },
  { projectId: 'demo-web-app', taskId: 'demo-t-204' },
  { projectId: 'demo-plan', taskId: 'demo-p-4' },
  { projectId: 'demo-plan', taskId: 'demo-p-5' },
];
for (let d = 13; d >= 0; d--) {
  const perDay = 2 + Math.floor(rand() * 4);
  for (let i = 0; i < perDay; i++) {
    const t = usageTargets[Math.floor(rand() * usageTargets.length)];
    const input = 1200 + Math.floor(rand() * 9000);
    const output = 400 + Math.floor(rand() * 3500);
    const cacheCreate = Math.floor(rand() * 6000);
    const cacheRead = Math.floor(rand() * 40000);
    usageRows.push({
      source: 'task',
      projectId: t.projectId,
      taskId: t.taskId,
      runId: `demo-run-${d}-${i}`,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreate,
      cacheReadTokens: cacheRead,
      totalTokens: input + output + cacheCreate + cacheRead,
      costUsd: Number((((input + cacheCreate) * 3 + output * 15) / 1e6).toFixed(4)),
      createdAt: now - d * DAY - Math.floor(rand() * 12) * HOUR,
    });
  }
  // A couple of orchestrator-side (aux) calls per day.
  const input = 300 + Math.floor(rand() * 1200);
  const output = 100 + Math.floor(rand() * 600);
  usageRows.push({
    source: 'orchestrator', projectId: null, taskId: null, runId: `demo-aux-${d}`,
    inputTokens: input, outputTokens: output, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: input + output, costUsd: Number(((input * 3 + output * 15) / 1e6).toFixed(4)),
    createdAt: now - d * DAY - 2 * HOUR,
  });
}

// ------------------------------------------------------------------- write ---
db.transaction(() => {
  // Clear any previous seed (demo ids only — the Personal project row is left alone).
  db.prepare(`DELETE FROM task_activity WHERE taskId LIKE 'demo-%'`).run();
  db.prepare(`DELETE FROM task_events WHERE taskId LIKE 'demo-%'`).run();
  db.prepare(`DELETE FROM token_usage WHERE runId LIKE 'demo-%'`).run();
  db.prepare(`DELETE FROM tasks WHERE id LIKE 'demo-%'`).run();
  db.prepare(`DELETE FROM projects WHERE id LIKE 'demo-%'`).run();

  for (const p of projects) insProject.run(p);
  // Steps after their parents: `tasks.parentTaskId` is a foreign key.
  for (const t of [...personalTasks, ...planTasks, ...stepTasks]) insTask.run(t);
  for (const a of activity) insActivity.run(a);
  for (const e of events) insEvent.run(e);
  for (const u of usageRows) insUsage.run(u);
})();

console.log('projects :', db.prepare(`SELECT COUNT(*) n FROM projects`).get().n);
console.log('tasks    :', db.prepare(`SELECT COUNT(*) n FROM tasks`).get().n);
console.log('steps    :', db.prepare(`SELECT COUNT(*) n FROM tasks WHERE parentTaskId IS NOT NULL`).get().n);
console.log('activity :', db.prepare(`SELECT COUNT(*) n FROM task_activity`).get().n);
console.log('chat     :', db.prepare(`SELECT COUNT(*) n FROM task_activity WHERE kind='chat'`).get().n);
console.log('events   :', db.prepare(`SELECT COUNT(*) n FROM task_events`).get().n);
console.log('usage    :', db.prepare(`SELECT COUNT(*) n FROM token_usage`).get().n);
console.log(
  'personal by status:',
  JSON.stringify(
    db.prepare(`SELECT status, COUNT(*) n FROM tasks WHERE projectId='personal' GROUP BY status`).all(),
  ),
);
db.close();
