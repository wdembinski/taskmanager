/**
 * The review workspace's entries (F15.14b) — see `ui-shots.mjs`'s header doc for the row shape
 * and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import {
  PR_FILES,
  PR_SUBJECT_ID,
  PR_SUMMARY,
  PR_VIEWED,
  REVIEW_QUEUES,
} from '../../fixtures/shots/96-review-workspace.mjs';

/** The four review channels `150-review-workspace.mjs`'s rows answer, plus `review:queues`. */
const WORKSPACE_OVERRIDES = {
  'review:queues': REVIEW_QUEUES,
  'review:subjectSummary': {
    byArgTable: { [PR_SUBJECT_ID]: PR_SUMMARY },
    fallback: { status: 'no-branch' },
  },
  'review:subjectFile': { byArgTable: PR_FILES, fallback: null, argIndex: 2 },
  'review:viewed': { byArgTable: { [PR_SUBJECT_ID]: PR_VIEWED }, fallback: [] },
  'review:list': [],
};

/** Card `3` (`boardShotsFixture.mjs`, in progress and worked) — its Changes pane loads `!412`'s
 *  seven files as the card's own diff, so the section has a file tree and a patch on screen. */
const CARD_ID = '3';

export default [
  // The web's `#/reviews` screen, reached the way a human does: the sidebar's Reviews row. The
  // workspace replaces the sidebar on its screen (rail → queues → files → diff, as v9-6 draws),
  // and opens the first requested row, `!412`. The overrides reach the fake relay through
  // `state.channelOverrides` (`fakeRelay.mjs`).
  {
    name: 'web-reviews',
    app: 'web',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Reviews' }],
    expect: '[data-review-workspace][data-state="loaded"] [data-source-badge]',
    mockup: 'v9-6-review-workspace-light.svg',
    channelOverrides: WORKSPACE_OVERRIDES,
  },
  // The desktop card's Changes section with its Open in review workspace button, scrolled into
  // frame — and the sidebar's Reviews row carrying the "Requested from me" count (2).
  {
    name: 'issue-peek-open-review',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: `board-card:${CARD_ID}` },
      { scrollToSelector: '[data-open-review-workspace]' },
    ],
    expect: '[data-open-review-workspace]',
    // Card 3 is frozen mid-run, so its running band spins forever (`030-board-columns.mjs`).
    allowPersistentSpinner: true,
    mockup: 'v9-2-issue-detail-light.svg',
    channelOverrides: {
      'review:queues': REVIEW_QUEUES,
      'task:diffSummary': {
        byArgTable: { [CARD_ID]: PR_SUMMARY },
        fallback: { status: 'no-branch' },
      },
      'task:diffFile': { byArgTable: PR_FILES, fallback: null, argIndex: 2 },
      'review:list': [],
    },
  },
];
