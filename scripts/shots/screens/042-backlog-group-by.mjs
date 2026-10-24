/**
 * The Backlog's "Group by" menu (TM-450) in its three modes, both schemes — see
 * `ui-shots.mjs`'s header doc for the row shape and `scripts/lib/shotModules.mjs` for how this
 * file is merged with its siblings.
 *
 * No fixture of its own: `50-sidebar.mjs` already files tickets under four milestones, two
 * epics (`sb-7`, `sb-8`) and none, all in the Tickets project. There is no mockup for the epic
 * or milestone modes (an owner-approved addition to the v9 list), so every row compares against
 * the v9 list mockup — status closely, the other two for header and row styling only.
 *
 * A non-default mode is picked the way a person would: open the toolbar's menu button (named
 * only by its `title`, since its text is the current mode) and choose the `MenuItemRadio` —
 * both by exact-match sentinels, so a row title containing "Epic" can never take the click.
 */

/** The Tickets screen in one grouping mode, after `040-issues.mjs`'s `issue-list-*` rows. */
function groupRow(mode, scheme, extraExpect = '') {
  // Status is the default: no click, so the shot proves nothing else has to pick it. The
  // `driver` clears the origin's storage before every row (`cdp.mjs`'s `freshLoad`), so a mode
  // chosen by an earlier row never leaks into this one.
  const pick =
    mode === 'status'
      ? []
      : [
          { click: 'title:Group by' },
          { click: mode === 'epic' ? 'menuitemradio:Epic' : 'menuitemradio:Milestone' },
        ];
  return {
    name: `backlog-group-${mode}-${scheme}`,
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme,
    setup: [{ click: 'Tickets' }, ...pick],
    expect: `[data-backlog-group-mode="${mode}"]${extraExpect}`,
    // The fixture's `'3'` and `sb-4` are frozen mid-run, so their glyphs spin forever.
    allowPersistentSpinner: true,
    mockup: scheme === 'light' ? 'v9-1-issues-list-light.svg' : 'v9-3-issues-list-dark.svg',
  };
}

export default [
  groupRow('status', 'light'),
  groupRow('status', 'dark'),
  groupRow('epic', 'light'),
  groupRow('epic', 'dark'),
  // A level-2 header proves the milestone › epic nesting actually rendered.
  groupRow('milestone', 'light', ' [data-backlog-section-level="2"]'),
  groupRow('milestone', 'dark', ' [data-backlog-section-level="2"]'),
];
