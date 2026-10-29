/**
 * The board column-width floor and header-cluster split, with the detail pane closed and open,
 * at both 1440 and 1100 — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
export default [
  {
    // Opens the detail pane on `agentRunningParent` (fixture task id '3') — the longest
    // title among the fixture's board cards, agent-owned, running (one of its own steps is in
    // `ACTIVE_RUNS`), and so drawing both the Stop and More buttons in the header's trailing
    // group: exactly the cluster `boardLayout.ts`'s column-width floor and `TaskCard.tsx`'s
    // header split exist to keep clear of the title. No mockup draws the detail pane open —
    // v9-7-board-light.svg (sidebar open, no detail pane) is the nearest available, kept only
    // as an orientation reference.
    name: 'board-sidebar-open-detail-open',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'board-card:3' }],
    allowPersistentSpinner: true,
    mockup: 'v9-7-board-light.svg',
  },
  {
    // `board-light` above is the 1440/closed member of this foursome; this is the 1100/closed
    // one, checking the column floor still holds at a smaller viewport — no mockup was ever
    // drawn at this size.
    name: 'board-sidebar-open-detail-closed-1100x800',
    app: 'client',
    viewport: { width: 1100, height: 800 },
    scheme: 'light',
    setup: null,
    mockup: null,
  },
  {
    // Same state and target card as `board-sidebar-open-detail-open` above, narrowed to 1100 —
    // this is where the fixed column width (260px) forces the columns grid to scroll sideways rather
    // than crush further, which is exactly what this row exists to check holds together with
    // the detail pane open too.
    name: 'board-sidebar-open-detail-open-1100x800',
    app: 'client',
    viewport: { width: 1100, height: 800 },
    scheme: 'light',
    setup: [{ click: 'board-card:3' }],
    allowPersistentSpinner: true,
    mockup: null,
  },
];
