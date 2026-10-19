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
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'board-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: null,
    mockup: 'v9-7b-board-dark.svg',
  },
];
