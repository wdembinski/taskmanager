/**
 * The `@tm/web` target's own screens — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
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
    mockup: 'v9-2-issue-detail-light.svg',
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
    mockup: 'v9-4-mobile-light.svg',
  },
  {
    name: 'web-phone-dark',
    app: 'web',
    viewport: { width: 390, height: 844 },
    scheme: 'dark',
    setup: null,
    mockup: 'v9-5-mobile-dark.svg',
  },
];
