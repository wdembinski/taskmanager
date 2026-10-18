/**
 * The milestone/epic/ticket tree, framed on its own (`clip: 'sidebar'`) — see `ui-shots.mjs`'s
 * header doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged
 * with its siblings.
 */
export default [
  {
    // Frames the milestone/epic/ticket tree on its own (`clip: 'sidebar'`), scrolled to its
    // bottom so the folded-by-default tail (a fully-done milestone, an epic whose tickets are
    // all done, a milestone with no open work of its own) is actually in frame rather than
    // scrolled past — `board-light`/`-dark` happen to show the same sidebar unscrolled, which
    // is why these two used to come out byte-identical to them before this row had its own
    // `setup`/`clip`. No mockup draws the tree's folded/status-glyph states on their own, so
    // `board-light`'s own reference is the nearest available.
    name: 'sidebar-tree-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ scroll: 'sidebar-bottom' }],
    clip: 'sidebar',
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'sidebar-tree-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [{ scroll: 'sidebar-bottom' }],
    clip: 'sidebar',
    mockup: 'v9-7b-board-dark.svg',
  },
];
