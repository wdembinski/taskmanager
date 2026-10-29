/**
 * Settings → Integrations on both apps, in both schemes — the pane whose provider tabs lost
 * Linear: the desktop's read JIRA · GitLab · GitHub · Cloud, the web's JIRA alone. See
 * `ui-shots.mjs`'s header doc for the row shape. Every row reuses `v10-19-settings-light.svg`
 * (there is no dark variant, and its selected pane is the unbuilt Members), so a comparison is
 * about the page's layout — the grouped nav and the capped content column — never the pane.
 */

const SETUP = [{ click: 'Settings' }, { click: 'tab:Integrations' }];

const row = (name, app, scheme) => ({
  name,
  app,
  viewport: { width: 1440, height: 900 },
  scheme,
  setup: SETUP,
  expect: '[aria-label="Settings sections"]',
  mockup: 'v10-19-settings-light.svg',
});

export default [
  row('settings-integrations-light', 'client', 'light'),
  row('settings-integrations-dark', 'client', 'dark'),
  row('web-settings-integrations-light', 'web', 'light'),
  row('web-settings-integrations-dark', 'web', 'dark'),
];
