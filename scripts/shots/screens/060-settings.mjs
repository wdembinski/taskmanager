/**
 * The grouped Settings page (v10-19) and the panes it regroups — see `ui-shots.mjs`'s header
 * doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings. Every row reuses `v10-19-settings-light.svg`: it draws the chrome, the grouped nav
 * and the capped content column, but its selected pane is Members, which is not built — so a
 * comparison is about the page's layout, never that pane's content.
 */

/**
 * The settings nav, matched only while no sidebar tree is rendered anywhere in the page. A
 * plain `clear: ['nav[aria-label="Sidebar"]']` cannot prove the tree is gone: the tree sits
 * beside the nav, never over it, so it would pass with the tree still drawn. With `:has()` the
 * target itself never matches while the tree exists, and `layoutCheck` reports that as a
 * problem.
 */
const NAV_WITHOUT_SIDEBAR =
  'body:not(:has(nav[aria-label="Sidebar"])) [aria-label="Settings sections"]';

export default [
  {
    // The "Settings" tab is NavRail's foot group (apps/client/src/renderer/src/App.tsx).
    name: 'settings',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }],
    expect: '[aria-label="Settings sections"]',
    layoutCheck: { visible: NAV_WITHOUT_SIDEBAR, clear: ['nav[aria-label="Sidebar"]'] },
    mockup: 'v10-19-settings-light.svg',
  },
  {
    // The Updates pane, scrolled to the private-feed token field. The fixture's shared
    // `UPDATE_STATE` is `mode: 'off'` (no other row wants an updater to look live), so this row
    // overrides it to `auto` on its own via `channelOverrides` instead. "Clear token" is a
    // disabled button once the token field renders, but `clickText` still scrolls it into view
    // before the (no-op) click, which is all this row needs from it.
    name: 'settings-updates-token',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }, { click: 'tab:Updates' }, { click: 'Clear token' }],
    mockup: 'v10-19-settings-light.svg',
    channelOverrides: {
      'update:get': { status: 'idle', mode: 'auto', version: '1.40.0' },
      'update:getTokenStatus': {
        hasToken: false,
        encryptionAvailable: true,
        plainTextStorage: false,
        source: 'none',
      },
    },
  },
  {
    // Integrations → GitHub's Test connection result, once "Merge on green" is on for a project
    // whose base branch is missing the prerequisites it needs — `ipc.ts`'s `github:testConnection`
    // now fills `JiraTestResult.prerequisites` with one entry per such project
    // (`forge/autoMerge.ts`'s `collectAutoMergePrerequisites`).
    name: 'settings-github-automerge-prereqs',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Settings' },
      { click: 'tab:Integrations' },
      { click: 'tab:GitHub' },
      { click: 'Test connection' },
      // The GitHub pane is already tall (every field down through the token input), so the
      // result bars this click adds land past the 900px fold — bring the first one (the
      // success bar) into frame, which also brings the warning bar right below it.
      { scrollToSelector: '.fui-MessageBar' },
    ],
    expect: '.fui-MessageBar',
    mockup: 'v10-19-settings-light.svg',
    channelOverrides: {
      'github:testConnection': {
        ok: true,
        displayName: 'wdembinski',
        message: 'Connected as wdembinski.',
        prerequisites: [
          {
            project: 'Task Manager',
            missing: [
              "Switch on 'Allow auto-merge' (Settings → General → Pull Requests).",
              'Required checks are missing: docker, package.',
            ],
          },
        ],
      },
    },
  },
  {
    // The Connections group's Agents and models pane: the model, permission and concurrency
    // defaults moved out of General, above the agent profiles.
    name: 'settings-agents-models',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }, { click: 'tab:Agents and models' }],
    expect: '[aria-label="Settings sections"]',
    mockup: 'v10-19-settings-light.svg',
  },
  {
    // The Features pane, scrolled to F16.13's "Review in the background when I open a PR"
    // switch — the last of the list, and off by default: each review costs money.
    name: 'settings-features-ai-review',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Settings' },
      { click: 'tab:Features' },
      { scrollToSelector: '[data-feature="aiReviewOnOpen"]' },
    ],
    expect: '[data-feature="aiReviewOnOpen"] input[role="switch"]:not(:checked)',
    mockup: 'v10-19-settings-light.svg',
  },
  {
    // The same switch on the web's Features pane, which mirrors the desktop's list.
    name: 'web-settings-features-ai-review-light',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Settings' },
      { click: 'tab:Features' },
      { scrollToSelector: '[data-feature="aiReviewOnOpen"]' },
    ],
    expect: '[data-feature="aiReviewOnOpen"] input[role="switch"]:not(:checked)',
    mockup: 'v10-19-settings-light.svg',
  },
  {
    // The web's grouped Settings page — the same shared page as the desktop's, with the web's
    // own items (Projects, Tokens, Desktop only).
    name: 'web-settings-light',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Settings' }],
    expect: '[aria-label="Settings sections"]',
    layoutCheck: { visible: NAV_WITHOUT_SIDEBAR, clear: ['nav[aria-label="Sidebar"]'] },
    mockup: 'v10-19-settings-light.svg',
  },
];
