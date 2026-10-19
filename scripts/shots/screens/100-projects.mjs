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
  {
    // The "Move to Done when its PR lands" switch sits directly under "Merge on green", far
    // enough down the drawer to need scrolling into frame. Clicking its label (not the switch)
    // and seeing it ON proves the label is wired to the switch.
    name: 'project-form-auto-done-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Projects' },
      { click: 'Edit' },
      { scrollToSelector: '[data-auto-done-on-land]' },
      { click: 'Move to Done when its PR lands' },
    ],
    expect: '[data-auto-done-on-land]',
    mockup: 'v10-13-projects-light.svg',
  },
  {
    // No dark projects mockup exists, so this row has none.
    name: 'project-form-auto-done-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [
      { click: 'Projects' },
      { click: 'Edit' },
      { scrollToSelector: '[data-auto-done-on-land]' },
      { click: 'Move to Done when its PR lands' },
    ],
    expect: '[data-auto-done-on-land]',
    mockup: null,
  },
  {
    // The web cannot edit repo settings — Settings → Projects shows them as read-only facts,
    // "Move to Done when its PR lands" among them. No mockup draws the web's Settings screen.
    name: 'web-settings-projects-light',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }, { click: 'tab:Projects' }],
    expect: '[data-web-projects]',
    mockup: null,
  },
];
