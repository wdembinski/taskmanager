/**
 * A finished ticket review of the fixture's own project — the Projects panel's "Review open
 * tickets" dialog (`BoardReviewDialog.tsx`, `@tm/shared/boardReview`). See
 * `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every other
 * file under this directory.
 *
 * One open ticket per verdict, each naming a real fixture card by its ref, so the rows carry
 * the board's own titles: FX-1 OK, FX-9 REWRITE, FX-15 SPLIT, FX-16 MERGE into FX-13b, FX-2
 * DROP (already applied), FX-14b REORDER after FX-13b and FX-10 DECIDE. Two hot files, and
 * two waves — the first holds four tickets, one over the project's ready-lane cap of 3, so
 * the parser's warning for it is on the record exactly as `parseBoardReviewReport` writes it.
 *
 * Nothing here joins the shared `CHANNELS`: the record reaches the `140-board-review.mjs`
 * rows alone, through their own `channelOverrides`, so every other row's Projects panel
 * still opens on a project that was never reviewed.
 */
import { PROJECT_ID } from '../boardShotsFixture.mjs';
import { now } from '../shotsFixtureHelpers.mjs';

const ticket = (ref, taskId, verdict, reason, evidence, extra = {}) => ({
  ref,
  taskId,
  verdict,
  reason,
  evidence,
  ...extra,
});

const TICKETS = [
  ticket(
    'FX-1',
    '1',
    'OK',
    'Clear, sized for one card, and nothing else open touches the palette.',
    ['packages/ui/src/palette/paletteModel.ts:41 — the field actions it extends'],
  ),
  ticket(
    'FX-9',
    '9',
    'REWRITE',
    'The banner it names was replaced by the usage bars; the copy now lives in the footer.',
    ['packages/ui/src/shell/UsageBars.tsx:88 — the strings the ticket means'],
    {
      rewrite: {
        title: 'Renew the usage bar tooltips',
        description: 'Rewrite the three tooltip strings on the footer usage bars.',
      },
    },
  ),
  ticket(
    'FX-15',
    '15',
    'SPLIT',
    'Two unrelated changes: measuring the reads, then batching them behind a flag.',
    [
      'apps/client/src/main/jira/jiraClient.ts:212 — one request per issue field',
      'apps/client/src/main/scheduler.ts:1840 — the sync loop that would batch them',
    ],
    {
      parts: [
        {
          title: 'Measure the per-field tracker reads',
          description: 'Log request counts per sync.',
        },
        {
          title: 'Batch tracker field reads behind a flag',
          description: 'One search query per page.',
        },
      ],
    },
  ),
  ticket(
    'FX-16',
    '16',
    'MERGE',
    'The retry budget is the detail pane’s own number; auditing it is part of FX-13b.',
    ['apps/client/src/main/automation/retry.ts:19 — the one budget both tickets name'],
    { mergeInto: 'FX-13b' },
  ),
  ticket(
    'FX-2',
    '2',
    'DROP',
    'Already done: Settings has a Test connection button that probes the write path.',
    ['packages/ui/src/settings/ConnectionTest.tsx:54 — the probe it asks for'],
  ),
  ticket(
    'FX-14b',
    '14b',
    'REORDER',
    'The release notes describe the retry queue, so they must land after it.',
    ['docs/release-notes.md:3 — the section FX-13b fills in'],
    { after: ['FX-13b'] },
  ),
  ticket(
    'FX-10',
    '10',
    'DECIDE',
    'Workable either way, but the two answers touch different services.',
    ['apps/server/src/workspaces/workspaces.service.ts:1 — no publish path yet'],
    { question: 'Should a published workspace be private to its owner or shared with the team?' },
  ),
];

const REPORT = {
  summary:
    'Seven open tickets: one ready as written, one to rewrite, one to split, one duplicate, one already done, one to reorder and one waiting on your call. The retry queue is the hot spot — three tickets touch it.',
  tickets: TICKETS,
  hotFiles: [
    {
      path: 'apps/client/src/main/automation/retry.ts',
      refs: ['FX-13b', 'FX-16'],
      note: 'Both change the retry budget; FX-16 folds into FX-13b.',
    },
    {
      path: 'packages/ui/src/TaskDetail.tsx',
      refs: ['FX-13b', 'FX-14b'],
      note: 'The detail pane band; FX-14b runs after FX-13b.',
    },
  ],
  waves: [
    {
      refs: ['FX-1', 'FX-9', 'FX-13b', 'FX-15'],
      note: 'No shared files between them.',
    },
    { refs: ['FX-14b', 'FX-10'], note: 'After the retry queue lands.' },
  ],
  warnings: ['Wave 1 has 4 tickets, more than the ready-lane cap of 3.'],
};

/** The record `project:boardReview` answers for the fixture's first project. */
export const BOARD_REVIEW = {
  id: 'review-fx-1',
  projectId: PROJECT_ID,
  status: 'done',
  startedAt: now - 6 * 60_000,
  finishedAt: now - 60_000,
  report: REPORT,
  error: null,
  applied: {
    'FX-2': { at: now - 30_000, ok: true, message: 'Moved FX-2 into Dropped.' },
  },
};

/** Empty on purpose — see the header doc. */
export const CHANNELS = {};
