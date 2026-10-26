/**
 * The Tickets list and a card's own detail, peek and full-screen — see `ui-shots.mjs`'s header
 * doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';

/** `'13a'`'s ticket text — the peek reads it under the title, the full page in its main column. */
const DESCRIPTION_13A =
  'The retry queue drains in the background, but nobody can see it. Show its depth and ' +
  'the last failure on the dashboard, refreshed every minute.\n\n' +
  'Done means: the dashboard card shows the queue depth and the newest failure.';

/**
 * The card `'issue-row:first'` opens (`'13a'`, see `30-attachments.mjs`'s own note on that
 * row order) carrying an open owner decision, a milestone and an epic — handed to `issue-peek` alone through its
 * `channelOverrides`, so no other row's board, list or ready set changes.
 */
const DECISION_TASKS = BOOT_CHANNELS['board:tasks'].map((t) =>
  t.id === '13a'
    ? {
        ...t,
        decisionQuestion:
          'Which hosting plan do we pay for — the monthly one, or the yearly one at a discount?',
        decisionAskedAt: Date.now() - 2 * 86_400_000,
        // Filed under a milestone and an epic (both from `50-sidebar.mjs`), so the peek's
        // header breadcrumb draws the full `Project › Milestone › Epic` after the key.
        milestoneId: 'ms-mixed',
        epicTaskId: 'sb-7',
        externalDescription: DESCRIPTION_13A,
      }
    : // Landed, so the "Blocked by" row below reads Done + "merged" (an `after-merge` arrow
      // is satisfied by `landedAt`, not by the column).
      t.id === '14a'
      ? { ...t, landedAt: Date.now() - 86_400_000 }
      : t,
);

/**
 * Two order arrows INTO `'13a'` on top of the fixture's own `13a → 13b`, so the Links
 * section's "Blocked by" group draws both statuses — `'14a'` (Done, merged) and `'2'` (To Do,
 * not merged) — and its "Blocks" group draws `'13b'`. Row-local, like `DECISION_TASKS`.
 */
const PEEK_CHAIN_LINKS = [
  ...BOOT_CHANNELS['chain:links'],
  { id: 'link-peek-1', fromTaskId: '14a', toTaskId: '13a', gate: 'after-merge' },
  { id: 'link-peek-2', fromTaskId: '2', toTaskId: '13a', gate: 'after-merge' },
];

/**
 * `'13a'` as the full-screen issue rows want it, after `v9-2-issue-detail-light.svg`: STAGED
 * (an agent assigned, `pending`, never run — `canStartWork`), so the header's Run button
 * draws; a description, so the main column opens on text; and a branch, so Built has
 * something to say. Row-local, like `DECISION_TASKS`.
 */
const FULL_TASKS = BOOT_CHANNELS['board:tasks'].map((t) =>
  t.id === '13a'
    ? {
        ...t,
        status: 'pending',
        agentProjectId: t.projectId,
        workedAt: null,
        sessionId: null,
        agentBranch: 'fx-13a-retry-queue',
        externalDescription: DESCRIPTION_13A,
        milestoneId: 'ms-mixed',
        epicTaskId: 'sb-7',
        assigneeId: 'person-human',
      }
    : t,
);

/** An open MR on `'13a'`'s branch with a staged pipeline, so Built and Tested both draw. */
const FULL_MERGE_REQUESTS = [
  ...BOOT_CHANNELS['mr:mergeRequests'],
  {
    ...BOOT_CHANNELS['mr:mergeRequests'][0],
    id: 'mr-13a',
    taskId: '13a',
    openedForTaskId: '13a',
    number: 201,
    title: 'Wire the retry queue to the dashboard',
    sourceBranch: 'fx-13a-retry-queue',
    changesRequested: false,
    pipelineStatus: 'success',
    pipelineStages: [
      { name: 'typecheck', status: 'success' },
      { name: 'test', status: 'success' },
      { name: 'build', status: 'success' },
    ],
  },
];

/**
 * `PEEK_CHAIN_LINKS` too, so the property column's Blocked by row has `14a` and `2` to name —
 * and an assignee on the card, so every row the mockup prints that this card has data for
 * draws: Status, Assignee, Model, Milestone, Blocked by.
 */
const FULL_OVERRIDES = {
  'board:tasks': FULL_TASKS,
  'mr:mergeRequests': FULL_MERGE_REQUESTS,
  'chain:links': PEEK_CHAIN_LINKS,
};

/**
 * The list rows' data, after `v9-1-issues-list-light.svg`: a plain due date on `'3'` (the
 * mockup's TM-71, the row the list shots select) and "Today" plus an assignee on `'4'` — both
 * In Progress, so at the top of the list, above the fold. Row-local, so no board shot changes.
 * The dates come from the real `Date.now()`, not the fixture's fixed `now`: `BacklogTable`
 * reads "today" off the browser's own clock, so a date taken from the fixture's 2026-01-15
 * would always draw as overdue.
 *
 * The run pill and the PR refs need nothing extra here: the base `board:tasks` already carries
 * FX-3's four steps (`3-s1`…`3-s4`, step 2 running — "Step 2 of 4"), and the base
 * `mr:mergeRequests` already holds `!190`/`!191` on the In Review rows `'6'`/`'7'`.
 */
const LIST_TASKS = BOOT_CHANNELS['board:tasks'].map((t) =>
  t.id === '3'
    ? { ...t, dueAt: Date.now() + 3 * 86_400_000 }
    : t.id === '4'
      ? { ...t, dueAt: Date.now(), assigneeId: 'person-human' }
      : t,
);

export default [
  {
    // The desktop's own default tab is `'mytasks'` (the Board, `App.tsx`'s own
    // `useState<TabId>('mytasks')`) — every row below that wants the Tickets screen instead
    // (`shellNav.ts`'s `{ id: 'tickets', label: 'Tickets' }`) has to click there first; driving
    // this row with `setup: null` landed on the Board and found no issue rows to screenshot,
    // which is how this got caught.
    //
    // The mockup's state is TM-71 selected with the peek open, so the row clicks `FX-3` (the
    // fixture's TM-71, the only key containing it once steps are dropped) and the run fails
    // if nothing ends up selected. `'3'` is the fixture's card frozen mid-run, so its peek's
    // running band spins forever — `allowPersistentSpinner`, as `030-board-columns.mjs` does.
    name: 'issue-list-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:has:FX-3' }],
    expect: '[role="option"][aria-selected="true"]',
    allowPersistentSpinner: true,
    mockup: 'v9-1-issues-list-light.svg',
    channelOverrides: { 'board:tasks': LIST_TASKS },
  },
  {
    name: 'issue-list-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:has:FX-3' }],
    expect: '[role="option"][aria-selected="true"]',
    allowPersistentSpinner: true,
    mockup: 'v9-3-issues-list-dark.svg',
    channelOverrides: { 'board:tasks': LIST_TASKS },
  },
  {
    // `IssueViewLayout` (packages/ui/src/issues/issueView.ts) opens 'closed' -> 'peek' on the
    // first click of an issue row — addressed by position (`'issue-row:first'`), not by the
    // fixture's own title text; see `SCREENS`' own doc comment on that sentinel. The card it
    // opens carries an open decision (`DECISION_TASKS`), so the shot proves `DecisionBanner`
    // still draws in the read-only peek (`IssuePeekBody`) — the question, the answer box,
    // Answer and Withdraw — under the ticket's label/value rows.
    name: 'issue-peek',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    // The pane as it opens, not scrolled. `layoutCheck` holds the Status/Assignee/Milestone/
    // Due rows in full, clear of the decision banner below them and of the Reply box pinned
    // to the pane's foot.
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    expect: '[data-decision-banner]',
    layoutCheck: {
      visible: '[data-peek-props]',
      clear: ['[data-decision-banner]', 'textarea[aria-label="Reply"]'],
    },
    mockup: 'v9-1-issues-list-light.svg',
    channelOverrides: {
      'board:tasks': DECISION_TASKS,
      'chain:links': PEEK_CHAIN_LINKS,
    },
  },
  {
    // Same peek as `issue-peek`, at the shorter 1100x800 viewport where the peek is ~300px
    // wide — proves the label/value rows still lay out in full above the Reply box, which
    // stays pinned to the pane's foot while the rest scrolls.
    name: 'issue-peek-1100x800',
    app: 'client',
    viewport: { width: 1100, height: 800 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    expect: 'button[aria-label="Open full screen"]',
    layoutCheck: {
      visible: '[data-peek-props]',
      clear: ['textarea[aria-label="Reply"]'],
    },
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    // From peek, "Open full screen" (IssueViewPanes.tsx) drives the same reducer to 'full' —
    // `TaskDetail`'s two-column `layout="full"`: key above a large title, Run top right (the
    // card is staged, `FULL_TASKS`), the description as text, the steps, Built and Tested;
    // and the property column, label over value, with Blocked by naming `14a` and `2`.
    name: 'issue-full-screen',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    // By key, not position: `FULL_TASKS` moves the card to the To Do group.
    setup: [{ click: 'Tickets' }, { click: 'issue-row:has:FX-13a' }, { click: 'Open full screen' }],
    expect: '[data-issue-breadcrumb]',
    mockup: 'v9-2-issue-detail-light.svg',
    channelOverrides: FULL_OVERRIDES,
  },
  {
    // The same full-screen issue in the dark scheme. There is no dark issue-detail mockup, so
    // the light one is the closest stand-in to compare against.
    name: 'issue-full-screen-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    // By key, not position: `FULL_TASKS` moves the card to the To Do group.
    setup: [{ click: 'Tickets' }, { click: 'issue-row:has:FX-13a' }, { click: 'Open full screen' }],
    expect: '[data-issue-breadcrumb]',
    mockup: 'v9-2-issue-detail-light.svg',
    channelOverrides: FULL_OVERRIDES,
  },
];
