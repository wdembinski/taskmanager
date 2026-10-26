/**
 * The `@tm/web` target's own board, light and dark — the browser renders the desktop's board
 * frame (`boardLayout.ts`) and header (`BoardHeader.tsx`) through its own fork of the toolbar
 * (`apps/web/src/board/BoardToolbar.tsx`), so the desktop's `board-light`/`board-dark` rows
 * cannot prove the web landed too. See `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 *
 * `setup: null`: the web opens on the board (`apps/web/src/App.tsx`'s
 * `useState<Screen>('mytasks')`). `expect` proves it is the board's header that rendered,
 * not a sync curtain left over from boot.
 */
export default [
  {
    name: 'web-board-light',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    expect: '[data-board-header]',
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'web-board-dark',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: null,
    expect: '[data-board-header]',
    mockup: 'v9-7b-board-dark.svg',
  },
];
