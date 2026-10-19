/**
 * The Archived view and its restore banner — see `ui-shots.mjs`'s header doc for the row shape
 * and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
export default [
  {
    // Sidebar's own "Archived" row (`Sidebar.tsx`) lands directly on the Archived view
    // (F14.8) from wherever the app was — `App.tsx`'s own `handleSidebarNavigate` sets both
    // the tab and `ticketsView` together, so this needs no separate "Tickets" click first,
    // unlike `issue-list-light`'s own `'Tickets'` setup.
    name: 'archived-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Archived' }],
    mockup: 'v10-21-archived-light.svg',
  },
  {
    // The ticket panel's own restore banner (F14.9) — opens one of the Archived view's own
    // seeded tickets (`uiShotsFixture.mjs`'s `ARCHIVED_MILESTONE_TICKETS`, filed under
    // `ARCHIVED_MILESTONES`) by expanding its milestone row and clicking the ticket, the
    // same two steps a human would take. No mockup draws this exact bar — `v10-21-archived
    // -light.svg` is the nearest (same screen, before the ticket is opened), needing human
    // visual sign-off rather than a pixel diff.
    name: 'ticket-archived-banner',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Archived' }, { click: 'Expand' }, { click: 'issue-row:first' }],
    mockup: 'v10-21-archived-light.svg',
  },
  {
    // Same setup as `ticket-archived-banner` above, but at a narrower laptop width —
    // the harder case for the metadata columns' new shrink behaviour (TM's "keep the
    // Archived table's Milestone column when the side panel is open" fix). The smaller
    // viewport is also what keeps this shot from being a byte-for-byte DUPLICATE of
    // `ticket-archived-banner`. No mockup draws the Archived view with the panel open;
    // `v10-21-archived-light.svg` is the nearest, so this needs human visual sign-off
    // rather than a pixel diff.
    name: 'archived-light-peek',
    app: 'client',
    viewport: { width: 1280, height: 800 },
    scheme: 'light',
    setup: [{ click: 'Archived' }, { click: 'Expand' }, { click: 'issue-row:first' }],
    expect: '[role="table"]',
    mockup: 'v10-21-archived-light.svg',
  },
];
