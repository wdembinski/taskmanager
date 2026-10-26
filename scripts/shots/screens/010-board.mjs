/**
 * The board's own resting state, light and dark — see `ui-shots.mjs`'s header doc for the row
 * shape and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
export default [
  {
    name: 'board-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    // The card's one-row header (`boardLayout.ts`'s `header`) — proves the board, not a
    // loading pane, is what was shot.
    expect: '[data-board-header]',
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'board-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: null,
    // The card's one-row header (`boardLayout.ts`'s `header`) — proves the board, not a
    // loading pane, is what was shot.
    expect: '[data-board-header]',
    mockup: 'v9-7b-board-dark.svg',
  },
  {
    // The only row with full transparency: proves the CSS glass panes render translucent
    // (every other row stays on 'reduced' so its panes are opaque and deterministic).
    name: 'board-light-glass',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    transparency: 'full',
    setup: null,
    // The card's one-row header (`boardLayout.ts`'s `header`) — proves the board, not a
    // loading pane, is what was shot.
    expect: '[data-board-header]',
    mockup: 'v9-7-board-light.svg',
  },
];
