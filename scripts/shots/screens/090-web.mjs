/**
 * The `@tm/web` target's own screens — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
/** v9-4's own Inbox, one item per narrower chip, so the phone rows show real rows and the tab
 *  bar's orange count, and the filter row proves "Questions" drops the other two.
 *
 *  Each item is parked on a real fixture task (`boardShotsFixture.mjs`), so its card prints that
 *  task's own mono key (`FX-6`, …) from the `board:tasks` read `CompactInbox` makes — an
 *  `AttentionItem` carries no key of its own. The plan item carries `plan`/`steps` (its card's
 *  "4 steps" summary) and the failed item the engine's real option labels (`FAILURE_ACTION`,
 *  `scheduler.ts`), so the cards show Approve/Read plan and Retry/Open. */
const minutesAgo = (m) => Date.now() - m * 60_000;
const PHONE_ATTENTION = [
  {
    id: 'phone-q',
    runId: 'run-phone-q',
    taskId: '6',
    projectId: 'proj-fx',
    taskTitle: 'Send review comments back to the agent',
    kind: 'agent-question',
    prompt: 'Which base branch should the review compare against?',
    options: [],
    toolName: null,
    reason: null,
    createdAt: minutesAgo(2),
    questions: [
      {
        header: 'Base',
        question: 'Which base branch should the review compare against?',
        multiSelect: false,
        options: [{ label: 'development' }, { label: 'main' }],
      },
    ],
  },
  {
    id: 'phone-plan',
    runId: 'run-phone-plan',
    taskId: '10',
    projectId: 'proj-fx',
    taskTitle: 'Publish a local workspace to the cloud',
    kind: 'plan-approval',
    prompt: 'Approve the plan?',
    options: [],
    toolName: null,
    reason: null,
    createdAt: minutesAgo(14),
    plan: [
      'Publish a local workspace to the cloud.',
      '',
      '1. Add the publish command',
      '2. Upload the workspace snapshot',
      '3. Link the cloud copy back to the local one',
      '4. Show the published state in Settings',
    ].join('\n'),
    steps: [
      'Add the publish command',
      'Upload the workspace snapshot',
      'Link the cloud copy back to the local one',
      'Show the published state in Settings',
    ],
  },
  {
    id: 'phone-failed',
    runId: 'run-phone-failed',
    taskId: '5',
    projectId: 'proj-fx',
    taskTitle: 'Fix flaky worktree cleanup',
    kind: 'task-failed',
    prompt: 'The run failed: 2 tests still fail after 3 attempts.',
    options: ['Retry', 'Retry fresh (discard branch)', 'AI fix & retry'],
    toolName: null,
    reason: null,
    createdAt: minutesAgo(60),
  },
];

export default [
  {
    // The web mirrors the desktop's own Tickets screen (see `web-mirrors-the-desktop` plan
    // notes) — same mockup as `issue-list-light`, no separate "web board" mockup exists. Both
    // hosts default to the Board (`apps/web/src/App.tsx`'s `useState<Screen>('mytasks')`,
    // `apps/client`'s own `useState<TabId>('mytasks')`), so this needs the same "Tickets" click
    // `issue-list-light` does.
    name: 'web-desktop',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }],
    expect: '[role="option"]',
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    // The web shell wires the same sidebar "Archived" row onto the same `ArchivedPane`
    // (`apps/web/src/App.tsx`'s own `handleSidebarNavigate`'s `'archived'` case) — no separate
    // mockup of its own, reusing `archived-light`'s.
    name: 'web-archived',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Archived' }],
    mockup: 'v10-21-archived-light.svg',
  },
  {
    // Same Tickets screen as `web-desktop`, one issue row deeper — the Projects pane's web
    // notice (F12.10) lives on this peek, not on the bare list.
    name: 'web-issue-peek',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    // The web renders the desktop's own `TaskDetail` peek, so the same check holds: the
    // label/value rows in full, clear of the Reply box.
    layoutCheck: {
      visible: '[data-peek-props]',
      clear: ['input[aria-label="Reply"]'],
    },
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    // 390x844 matches the phone frame drawn inside v9-4-mobile-light.svg/v9-5-mobile-dark.svg,
    // not that SVG's own 1330x940 canvas — see verify-mobile.mjs's own SIZES for the closest
    // real device sizes this repo already drives (375x667, 414x896); 390x844 is the mockup's.
    name: 'web-phone-light',
    app: 'web',
    viewport: { width: 390, height: 844 },
    scheme: 'light',
    setup: null,
    attention: PHONE_ATTENTION,
    mockup: 'v9-4-mobile-light.svg',
  },
  {
    name: 'web-phone-dark',
    app: 'web',
    viewport: { width: 390, height: 844 },
    scheme: 'dark',
    setup: null,
    attention: PHONE_ATTENTION,
    mockup: 'v9-5-mobile-dark.svg',
  },
  {
    // The Inbox's chip row filters: "Questions" checked instead of the default "Needs you".
    // Seeded with all three `PHONE_ATTENTION` items, the list keeps only the question.
    name: 'web-phone-inbox-filter-light',
    app: 'web',
    viewport: { width: 390, height: 844 },
    scheme: 'light',
    setup: [{ click: 'Questions' }],
    attention: PHONE_ATTENTION,
    expect: '[role="radio"][aria-checked="true"]',
    mockup: 'v9-4-mobile-light.svg',
  },
];
