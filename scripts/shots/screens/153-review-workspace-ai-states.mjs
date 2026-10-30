/**
 * *Ask AI to review*'s four states in the review workspace (F16.13) — see `ui-shots.mjs`'s
 * header doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged
 * with its siblings.
 */
import { now } from '../../fixtures/shotsFixtureHelpers.mjs';
import {
  PR_FILES,
  REVIEW_QUEUES,
  TASK87_AI_DONE,
  TASK87_AI_FAILED,
  TASK87_AI_MODEL_CATALOG,
  TASK87_AI_PARKED,
  TASK87_AI_RUNNING,
  TASK87_DRAFTS,
  TASK87_SUBJECT_ID,
  TASK87_SUMMARY,
} from '../../fixtures/shots/96-review-workspace.mjs';

/**
 * The agent card `TM-87 Send comments back` opened from the Reviews queue, as the 152 rows do,
 * with `aiReview:list` / `aiReview:get` answering one review `air-87-1` in the given state. The
 * header's `ai-review` slot draws the state; done and failed also put a card at the top of the
 * file list.
 *
 * v9-6 draws only the done state (the outlined "AI: 2 findings" button between Unified/Split
 * and Submit review). Running, parked and failed are not drawn, so their verdicts judge them
 * against that button's place and spacing.
 */
const stateRow = (state, review, expect) => (scheme, mockup) => ({
  name: `review-ai-${state}${scheme === 'dark' ? '-dark' : ''}`,
  app: 'client',
  viewport: { width: 1440, height: 900 },
  scheme,
  clock: now,
  setup: [{ click: 'Reviews' }, { click: 'TM-87 Send comments back' }],
  expect,
  mockup,
  channelOverrides: {
    'review:queues': REVIEW_QUEUES,
    'review:subjectSummary': {
      byArgTable: { [TASK87_SUBJECT_ID]: TASK87_SUMMARY },
      fallback: { status: 'no-branch' },
    },
    'review:subjectFile': { byArgTable: PR_FILES, fallback: null, argIndex: 2 },
    'review:viewed': { byArgTable: { [TASK87_SUBJECT_ID]: [] }, fallback: [] },
    'review:list': TASK87_DRAFTS,
    'aiReview:list': { byArgTable: { [TASK87_SUBJECT_ID]: [review] }, fallback: [] },
    'aiReview:get': { byArgTable: { [review.id]: review }, fallback: null },
    'model:catalog': TASK87_AI_MODEL_CATALOG,
  },
});

const ROWS = [
  stateRow('running', TASK87_AI_RUNNING, '[data-ai-review="running"][data-running]'),
  stateRow('parked', TASK87_AI_PARKED, '[data-ai-review="parked"]'),
  stateRow('failed', TASK87_AI_FAILED, '[data-ai-summary="failed"] [data-ai-error]'),
  stateRow('done', TASK87_AI_DONE, '[data-ai-summary="done"] [data-ai-checklist]'),
];

export default ROWS.flatMap((row) => [
  row('light', 'v9-6-review-workspace-light.svg'),
  row('dark', 'v9-6b-review-workspace-dark.svg'),
]);
