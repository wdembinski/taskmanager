/**
 * The review workspace with AI drafts (F16.12) — see `ui-shots.mjs`'s header doc for the row
 * shape and `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { now } from '../../fixtures/shotsFixtureHelpers.mjs';
import {
  PR_FILES,
  REVIEW_QUEUES,
  TASK87_DRAFTS,
  TASK87_SUBJECT_ID,
  TASK87_SUMMARY,
} from '../../fixtures/shots/96-review-workspace.mjs';

/**
 * The agent card `TM-87 Send comments back`, opened from the Reviews queue the way a human
 * does: only a card subject loads comments, so this is the one place the v9-6 AI draft card can
 * be drawn. Its diff is `!412`'s (split, `src/upload/retry.ts` first) and `review:list` answers
 * `TASK87_DRAFTS` — one AI draft per severity, one dismissed, one human — so the header reads
 * one draft and "show dismissed (1)".
 *
 * `expect` waits for the blocker's card, which only renders once the comments have loaded on
 * the loaded diff.
 *
 * At 1440×900 only the line-18 thread and the nit fit in frame, so a second pair of rows
 * (`-more-`) opens "show dismissed (1)" and scrolls the nit to the top: the minor, the dimmed
 * dismissed draft with Restore, and the major follow it. No mockup draws that state.
 */
const aiRow = (scheme, mockup) => ({
  name: `review-workspace-ai-${scheme}`,
  app: 'client',
  viewport: { width: 1440, height: 900 },
  scheme,
  clock: now,
  setup: [{ click: 'Reviews' }, { click: 'TM-87 Send comments back' }],
  expect: '[data-ai-draft][data-severity="blocker"]',
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
  },
});

const moreRow = (scheme) => ({
  ...aiRow(scheme, null),
  name: `review-workspace-ai-more-${scheme}`,
  setup: [
    { click: 'Reviews' },
    { click: 'TM-87 Send comments back' },
    { click: 'show dismissed (1)' },
    { scrollToSelector: '[data-ai-draft][data-severity="nit"]' },
  ],
  expect: '[data-ai-draft][data-decision="dismissed"]',
});

export default [
  aiRow('light', 'v9-6-review-workspace-light.svg'),
  aiRow('dark', 'v9-6b-review-workspace-dark.svg'),
  moreRow('light'),
  moreRow('dark'),
];
