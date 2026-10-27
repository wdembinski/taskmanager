/**
 * The review workspace (F15.14) — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { now } from '../../fixtures/shotsFixtureHelpers.mjs';
import {
  PR_FILES,
  PR_SUBJECT_ID,
  PR_SUMMARY,
  PR_VIEWED,
  REVIEW_QUEUES,
} from '../../fixtures/shots/96-review-workspace.mjs';

/**
 * The desktop app's `reviews` tab, reached the way a human does: the sidebar's Reviews row, so
 * the rail (its Reviews tile highlighted) frames the workspace as v9-6/v9-6b draw it. The
 * workspace opens the first requested row —
 * GitLab `!412` (`96-review-workspace.mjs`) — read from a local clone, with two of its seven
 * files viewed and `src/upload/retry.ts` the first patch on screen.
 *
 * `expect` waits for the source badge inside a loaded workspace: `data-state` sits on the
 * `[data-review-workspace]` root itself, so the two are one compound selector, not a descendant
 * pair. `review:list` answers `[]` — a PR row has no task, so it is never asked, but a stray
 * call must not reach a card's comments either.
 */
const workspaceRow = (scheme, mockup) => ({
  name: `review-workspace-${scheme}`,
  app: 'client',
  viewport: { width: 1440, height: 900 },
  scheme,
  clock: now,
  setup: [{ click: 'Reviews' }],
  expect: '[data-review-workspace][data-state="loaded"] [data-source-badge]',
  mockup,
  channelOverrides: {
    'review:queues': REVIEW_QUEUES,
    'review:subjectSummary': {
      byArgTable: { [PR_SUBJECT_ID]: PR_SUMMARY },
      fallback: { status: 'no-branch' },
    },
    'review:subjectFile': { byArgTable: PR_FILES, fallback: null, argIndex: 2 },
    'review:viewed': { byArgTable: { [PR_SUBJECT_ID]: PR_VIEWED }, fallback: [] },
    'review:list': [],
  },
});

export default [
  workspaceRow('light', 'v9-6-review-workspace-light.svg'),
  workspaceRow('dark', 'v9-6b-review-workspace-dark.svg'),
];
