/**
 * The glass under an app Theme the OS disagrees with — every row is `transparency: 'full'`, and
 * `osScheme` emulates the OS `prefers-color-scheme` apart from the `appearance` the row's
 * `scheme` sets. Each pair must look the same whatever the OS reports. See `ui-shots.mjs`'s
 * header doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged
 * with its siblings.
 *
 * Headless Chrome paints no Mica, so these shots prove the CSS glass keeps the app's scheme —
 * not the native layer itself, which only the packaged app on Windows can show.
 */
import issueRows from './040-issues.mjs';

/** The board, shot exactly as `010-board.mjs`'s rows are. */
const boardRow = (scheme, osScheme) => ({
  name: `board-glass-${scheme}-on-${osScheme}-os`,
  app: 'client',
  viewport: { width: 1440, height: 900 },
  scheme,
  osScheme,
  transparency: 'full',
  setup: null,
  // The card's one-row header (`boardLayout.ts`'s `header`) — proves the board, not a
  // loading pane, is what was shot.
  expect: '[data-board-header]',
  mockup: scheme === 'light' ? 'v9-7-board-light.svg' : 'v9-7b-board-dark.svg',
});

/** `040-issues.mjs`'s `issue-list-light` row — its setup, `expect` and overrides — reused. */
const ISSUE_LIST = issueRows.find((row) => row.name === 'issue-list-light');

const issueListRow = (scheme, osScheme) => ({
  ...ISSUE_LIST,
  name: `issue-list-glass-${scheme}-on-${osScheme}-os`,
  scheme,
  osScheme,
  transparency: 'full',
  mockup: scheme === 'light' ? 'v9-1-issues-list-light.svg' : 'v9-3-issues-list-dark.svg',
});

export default [
  boardRow('light', 'light'),
  boardRow('light', 'dark'),
  boardRow('dark', 'light'),
  boardRow('dark', 'dark'),
  issueListRow('light', 'light'),
  issueListRow('light', 'dark'),
  issueListRow('dark', 'light'),
  issueListRow('dark', 'dark'),
];
