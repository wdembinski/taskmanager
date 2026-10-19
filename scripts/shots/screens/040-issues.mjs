/**
 * The Tickets list and a card's own detail, peek and full-screen — see `ui-shots.mjs`'s header
 * doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';

/**
 * The card `'issue-row:first'` opens (`'13a'`, see `30-attachments.mjs`'s own note on that
 * row order) carrying an open owner decision — handed to `issue-peek` alone through its
 * `channelOverrides`, so no other row's board, list or ready set changes.
 */
const DECISION_TASKS = BOOT_CHANNELS['board:tasks'].map((t) =>
  t.id === '13a'
    ? {
        ...t,
        decisionQuestion:
          'Which hosting plan do we pay for — the monthly one, or the yearly one at a discount?',
        decisionAskedAt: Date.now() - 2 * 86_400_000,
      }
    : t,
);
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
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    expect: '[data-decision-banner]',
    mockup: 'v9-2-issue-detail-light.svg',
    channelOverrides: {
      'board:tasks': DECISION_TASKS,
    },
  },
  {
    // Same pane as `issue-peek`, at the shorter 1100x800 viewport the give-way layout
    // (`TaskDetail.tsx`'s `headBand`/`cell`/`scrollWrap`) targets — proves the bands shrink
    // inside their own boxes rather than overlapping the conversation when the pane is too
    // short for both at their full caps.
    name: 'issue-peek-1100x800',
    app: 'client',
    viewport: { width: 1100, height: 800 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }],
    expect: 'button[aria-label="Open full screen"]',
    mockup: 'v9-2-issue-detail-light.svg',
  },
  {
    // From peek, "Open full screen" (IssueViewPanes.tsx) drives the same reducer to 'full'.
    name: 'issue-full-screen',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }, { click: 'Open full screen' }],
    mockup: 'v9-2-issue-detail-light.svg',
  },
];
