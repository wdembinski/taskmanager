/**
 * The Tickets list and a card's own detail, peek and full-screen — see `ui-shots.mjs`'s header
 * doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings.
 */
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
    // fixture's own title text; see `SCREENS`' own doc comment on that sentinel.
    name: 'issue-peek',
    app: 'client',
    viewport: { width: 1440, height: 900 },
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
