/**
 * The Projects admin screen's merge-on-green setting (this ticket's step 1) — see
 * `ui-shots.mjs`'s header doc for the row shape.
 */
export default [
  {
    // "Projects" is the small icon-row link under the team header (`Sidebar.tsx`), not a
    // NavRail tile — see `@tm/ui/shell/shellNav`'s own doc on the F13.11 split. "Edit" opens
    // `ProjectForm` on the fixture's one project; the method dropdown and checks input only
    // render once "Merge on green" is switched on.
    name: 'projects-merge-on-green',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Projects' }, { click: 'Edit' }, { click: 'Merge on green' }],
    expect: '[aria-label="Merge method"]',
    mockup: 'v10-13-projects-light.svg',
  },
];
