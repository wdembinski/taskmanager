/**
 * The Projects admin screen's merge-on-green setting (this ticket's step 1) — see
 * `ui-shots.mjs`'s header doc for the row shape.
 */
import { PROJECTS } from '../../fixtures/boardShotsFixture.mjs';

/**
 * The fixture's projects with the first one — the one "Edit" opens — set to Merge on green
 * AND Visual sign-off by AI reviewer, on the default 2 rounds: both controls render only
 * while merge on green is on, and the rounds field only while the switch is.
 */
const AI_SIGN_OFF_PROJECTS = PROJECTS.map((entry, i) =>
  i === 0
    ? {
        ...entry,
        project: {
          ...entry.project,
          autoMergeOnGreen: true,
          autoVisualSignOff: true,
          autoVisualSignOffMaxRounds: 2,
        },
      }
    : entry,
);

/** The "Visual sign-off by AI reviewer" switch and its "Max automatic fix rounds" field. */
const aiSignOffRow = (scheme, mockup) => ({
  name: `project-form-ai-signoff-${scheme}`,
  app: 'client',
  viewport: { width: 1280, height: 900 },
  scheme,
  setup: [
    { click: 'Projects' },
    { click: 'Edit' },
    { scrollToSelector: '[data-auto-visual-sign-off]' },
  ],
  expect: '[data-auto-visual-sign-off] input[role="switch"]:checked',
  mockup,
  channelOverrides: { 'project:list': AI_SIGN_OFF_PROJECTS },
});

/** This repo's own screenshot command, the value the "UI verification command" rows show. */
const UI_VERIFY_COMMAND = 'node scripts/ui-shots.mjs --attach';

/** The fixture's projects with the first one — the one "Edit" opens — carrying that command. */
const UI_VERIFY_PROJECTS = PROJECTS.map((entry, i) =>
  i === 0 ? { ...entry, project: { ...entry.project, uiVerifyCommand: UI_VERIFY_COMMAND } } : entry,
);

/** The "UI verification command" field, directly under "Standing instructions". */
const uiVerifyRow = (scheme, mockup) => ({
  name: `project-form-ui-verify-${scheme}`,
  app: 'client',
  viewport: { width: 1280, height: 900 },
  scheme,
  setup: [
    { click: 'Projects' },
    { click: 'Edit' },
    { scrollToSelector: '[data-ui-verify-command]' },
  ],
  expect: `[data-ui-verify-command][value=${JSON.stringify(UI_VERIFY_COMMAND)}]`,
  mockup,
  channelOverrides: { 'project:list': UI_VERIFY_PROJECTS },
});

/** The fixture's projects with the first one — the one "Edit" opens — reviewing on Opus. */
const REVIEW_MODEL_PROJECTS = PROJECTS.map((entry, i) =>
  i === 0 ? { ...entry, project: { ...entry.project, reviewModel: 'opus' } } : entry,
);

/** The "Review model" field (F16.13), directly under the planning/execution model row. */
const reviewModelRow = (scheme, mockup) => ({
  name: `project-form-review-model-${scheme}`,
  app: 'client',
  viewport: { width: 1280, height: 900 },
  scheme,
  setup: [{ click: 'Projects' }, { click: 'Edit' }, { scrollToSelector: '[data-review-model]' }],
  expect: '[data-review-model] [role="combobox"]',
  mockup,
  channelOverrides: { 'project:list': REVIEW_MODEL_PROJECTS },
});

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
  aiSignOffRow('light', 'v10-13-projects-light.svg'),
  // No dark projects mockup exists, so this row has none.
  aiSignOffRow('dark', null),
  uiVerifyRow('light', 'v10-13-projects-light.svg'),
  // No dark projects mockup exists, so this row has none.
  uiVerifyRow('dark', null),
  reviewModelRow('light', 'v10-13-projects-light.svg'),
  // No dark projects mockup exists, so this row has none.
  reviewModelRow('dark', null),
  {
    // "Who merges on green" only renders once "Merge on green" is ON, in the row beside
    // "Merge method" and "Required checks". Picking "Task Manager" proves the dropdown's
    // options and its read-back label; the hint under the row explains when to pick it.
    name: 'project-form-merge-by-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Projects' },
      { click: 'Edit' },
      { click: 'Merge on green' },
      { scrollToSelector: '[data-auto-merge-by]' },
      { click: 'Who merges on green' },
      { click: 'Task Manager' },
    ],
    expect: '[data-auto-merge-by]',
    mockup: 'v10-13-projects-light.svg',
  },
  {
    // No dark projects mockup exists, so this row has none.
    name: 'project-form-merge-by-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [
      { click: 'Projects' },
      { click: 'Edit' },
      { click: 'Merge on green' },
      { scrollToSelector: '[data-auto-merge-by]' },
      { click: 'Who merges on green' },
      { click: 'Task Manager' },
    ],
    expect: '[data-auto-merge-by]',
    mockup: null,
  },
  {
    // The web cannot edit repo settings — Settings → Projects shows them as read-only facts,
    // "Move to Done when its PR lands" and "UI verification command" among them. The grouped
    // Settings mockup draws the page's chrome and nav, not this pane.
    name: 'web-settings-projects-light',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }, { click: 'tab:Projects' }],
    expect: '[data-web-projects]',
    mockup: 'v10-19-settings-light.svg',
  },
];
