/**
 * The Tickets list and a card's own detail, peek and full-screen — see `ui-shots.mjs`'s header
 * doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';

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
        externalDescription:
          'The retry queue drains in the background, but nobody can see it. Show its depth and ' +
          'the last failure on the dashboard, refreshed every minute.\n\n' +
          'Done means: the dashboard card shows the queue depth and the newest failure.',
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
export default [
  {
    // The desktop's own default tab is `'mytasks'` (the Board, `App.tsx`'s own
    // `useState<TabId>('mytasks')`) — every row below that wants the Tickets screen instead
    // (`shellNav.ts`'s `{ id: 'tickets', label: 'Tickets' }`) has to click there first; driving
    // this row with `setup: null` landed on the Board and found no issue rows to screenshot,
    // which is how this got caught.
    name: 'issue-list-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }],
    expect: '[role="option"]',
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    name: 'issue-list-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [{ click: 'Tickets' }],
    expect: '[role="option"]',
    mockup: 'v9-3-issues-list-dark.svg',
  },
  {
    // `IssueViewLayout` (packages/ui/src/issues/issueView.ts) opens 'closed' -> 'peek' on the
    // first click of an issue row — addressed by position (`'issue-row:first'`), not by the
    // fixture's own title text; see `SCREENS`' own doc comment on that sentinel. The card it
    // opens carries an open decision (`DECISION_TASKS`), so the shot proves `DecisionBanner`
    // draws at the top of the pane — the question, the answer box, Answer and Withdraw.
    name: 'issue-peek',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    // The Links section sits below the visual sign-off band, past the pane's fold; the scroll
    // targets the section's own box (the parent of its "Blocked by" group) rather than the
    // group itself, so `block: 'start'` keeps the "Links" heading in frame. That band
    // (`TaskDetail.tsx`'s `cell`) never shrinks: once it and `headBand` outgrow the pane
    // the region above the composer scrolls instead, so the heading and its rows show in
    // full.
    setup: [
      { click: 'Tickets' },
      { click: 'issue-row:first' },
      { scrollToSelector: 'div:has(> [data-links-blocked-by])' },
    ],
    expect: '[data-decision-banner]',
    mockup: 'v9-2-issue-detail-light.svg',
    channelOverrides: {
      'board:tasks': DECISION_TASKS,
      'chain:links': PEEK_CHAIN_LINKS,
    },
  },
  {
    // Same pane as `issue-peek`, at the shorter 1100x800 viewport where band + the
    // conversation's floor outgrow the pane — proves `TaskDetail.tsx`'s `body` scrolls
    // rather than squeezing `headBand`/`cell`, so the Links heading lays out in full and
    // clear of the conversation.
    name: 'issue-peek-1100x800',
    app: 'client',
    viewport: { width: 1100, height: 800 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    expect: 'button[aria-label="Open full screen"]',
    layoutCheck: {
      visible: '[data-links-heading]',
      clear: ['[role="log"][aria-label="Conversation"]'],
    },
    mockup: 'v9-2-issue-detail-light.svg',
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
