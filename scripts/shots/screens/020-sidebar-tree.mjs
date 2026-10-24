/**
 * The milestone/epic/ticket tree, framed on its own (`clip: 'sidebar'`) — see `ui-shots.mjs`'s
 * header doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged
 * with its siblings.
 */

// Scrolled to the sidebar's bottom so the folded-by-default tail (a fully-done milestone, an
// epic whose tickets are all done, a milestone with no open work of its own) and the pinned
// "This machine" / "New issue" footer are actually in frame rather than scrolled past. One tree
// ticket is opened in between, so the shot shows the selected-row treatment too: row 29 is
// "FX-16 Audit the automation retry budget" (No milestone → No epic), a few rows above the tail
// and so still in frame after the scroll. It is addressed by position (`'treeitem:N'`) because
// its title also renders on the board, which plain text matching reaches first. The second
// scroll undoes the click's own `scrollIntoView`.
const SETUP = [
  { scroll: 'sidebar-bottom' },
  { click: 'treeitem:29' },
  { scroll: 'sidebar-bottom' },
];

export default [
  {
    // The v9 issues list draws the sidebar column (x≈44–330) this row is compared against: the
    // quiet project label, weight-600 milestone rows, the tint + accent-bar selected row, the
    // "This machine" section with its trailing "local", and the brand "New issue" footer. It
    // draws an unfolded tree, not the folded/status-glyph tail framed here — those parts have
    // no mockup of their own.
    name: 'sidebar-tree-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: SETUP,
    expect: '[role="treeitem"][aria-selected="true"]',
    clip: 'sidebar',
    mockup: 'v9-1-issues-list-light.svg',
  },
  {
    name: 'sidebar-tree-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: SETUP,
    expect: '[role="treeitem"][aria-selected="true"]',
    clip: 'sidebar',
    mockup: 'v9-3-issues-list-dark.svg',
  },
];
