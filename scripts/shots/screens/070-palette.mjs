/**
 * The command palette — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
export default [
  {
    // `useGlobalShortcut('mod+k', ...)` in App.tsx opens CommandPalette. Selecting a card first
    // (`board-card:1`, `boardShotsFixture.mjs`'s `plainBacklog` — the default board's first
    // Backlog card, ticketKey `FX-1`) sets `selectedTaskId`, so the palette's context chip ("on
    // FX-1") renders, matching the mockup.
    name: 'palette',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'board-card:1' }, { key: 'mod+k' }],
    expect: '[role="dialog"]',
    mockup: 'v10-20-palette-light.svg',
  },
];
