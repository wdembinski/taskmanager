/**
 * The Projects panel's "Review open tickets" dialog — see `ui-shots.mjs`'s header doc for the
 * row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { PROJECT_ID } from '../../fixtures/boardShotsFixture.mjs';
import { BOARD_REVIEW } from '../../fixtures/shots/95-board-review.mjs';

/**
 * "Review tickets" sits beside Edit on the fixture's one project, which has a repo.
 * `project:boardReview` answers the finished record for that project only
 * (`95-board-review.mjs`): one row per verdict, FX-2's Apply already reading "Applied", two
 * hot files and a first wave over the ready-lane cap.
 */
const reviewRow = (scheme) => ({
  name: `board-review-${scheme}`,
  app: 'client',
  viewport: { width: 1440, height: 900 },
  scheme,
  setup: [{ click: 'Projects' }, { click: 'Review tickets' }],
  expect: '[data-board-review] [data-verdict="SPLIT"]',
  mockup: `v10-22-board-review-${scheme}.svg`,
  channelOverrides: {
    'project:boardReview': { byArgTable: { [PROJECT_ID]: BOARD_REVIEW }, fallback: null },
  },
});

export default [reviewRow('light'), reviewRow('dark')];
