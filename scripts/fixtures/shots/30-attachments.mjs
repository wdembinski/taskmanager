/**
 * The `VISUAL_SIGNOFF_*` attachment data and the one Inbox question item — see
 * `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every other
 * file under this directory.
 */
import { PROJECT_ID } from '../boardShotsFixture.mjs';
import { now, sidebarTicket } from '../shotsFixtureHelpers.mjs';

/**
 * The shots `ui-shots.mjs`'s own `visual-signoff-dark` row proves the card panel's "Visual
 * sign-off" section renders from — exactly the shape `ingestAttachOutbox` would have left on
 * an owner card: a real shot, its mockup, the side-by-side page, the shared contact sheet and
 * the manifest `shots.json` ingests itself, never the agent's own `verdicts.txt` (that one is
 * read as a comment, not attached — see `TASK_ACTIVITY` above, which this row adds no row to,
 * so the section's badge reads "Pending").
 *
 * Hung off `chainWaitingPredecessor`'s id (`'13a'`) — NOT `agentRunningParent`'s (`'3'`),
 * despite `visual-signoff-dark`'s own setup steps being the exact ones `issue-peek`/
 * `issue-full-screen` use (`'Tickets'`, `'issue-row:first'`, `'Open full screen'`). Checked
 * empirically (`node scripts/ui-shots.mjs --only visual-signoff-dark`): the Tickets screen's
 * own `[role="option"]` order puts `'13a'` first, not `'3'` — `TASK_ACTIVITY`'s own comment
 * above, naming `3`/`6` as "the one card issue-peek/issue-full-screen opens", no longer holds
 * for whatever position in that list is actually first. Attaching to the wrong id left this
 * row's own `[data-visual-signoff]` `expect` unmatched (`selectorMissed`) the first time.
 */
export const VISUAL_SIGNOFF_ATTACHMENTS = [
  {
    id: 'vso-real',
    taskId: '13a',
    name: 'board-light.png',
    fileName: 'board-light.png',
    mimeType: 'image/png',
    size: 48_000,
    createdAt: now - 60_000,
  },
  {
    id: 'vso-mockup',
    taskId: '13a',
    name: 'board-light-mockup.png',
    fileName: 'board-light-mockup.png',
    mimeType: 'image/png',
    size: 51_000,
    createdAt: now - 60_000,
  },
  {
    id: 'vso-html',
    taskId: '13a',
    name: 'board-light.html',
    fileName: 'board-light.html',
    mimeType: 'text/html',
    size: 900,
    createdAt: now - 60_000,
  },
  {
    id: 'vso-index',
    taskId: '13a',
    name: 'index.html',
    fileName: 'index.html',
    mimeType: 'text/html',
    size: 1200,
    createdAt: now - 60_000,
  },
  {
    id: 'vso-manifest',
    taskId: '13a',
    name: 'shots.json',
    fileName: 'shots.json',
    mimeType: 'application/json',
    size: 300,
    createdAt: now - 60_000,
  },
];

/**
 * A step under the same owner card (`13a`) `VISUAL_SIGNOFF_ATTACHMENTS` hangs off — exists only
 * so `files-section-grouped`'s own `channelOverrides` (`ui-shots.mjs`) can prove `FilesSection`
 * actually groups by step, not just by card. `sidebarTicket`'s shape (source `'ticket'` despite
 * being a step) is the same one `sidebarMixedStep` above already proves stays off every
 * ticket/board listing once its `parentTaskId` names a task also in the list (`isBoardCard`,
 * `packages/shared/src/board.ts`) — so adding it only for that one row's own `board:tasks`
 * override cannot shift `issue-row:first`'s position for anyone else.
 */
export const VISUAL_SIGNOFF_STEP_TASK = sidebarTicket({
  id: 'vso-step-1',
  title: 'Shoot the dashboard retry UI',
  status: 'done',
  parentTaskId: '13a',
  milestoneId: null,
});

/** The step's own file — a plain image, not a `name`/`name-mockup` pair, so
 *  `groupAttachmentsForDisplay` draws it from `AttachmentGallery`'s `images` bucket rather
 *  than `pairs`, proving `FilesSection` carries more than just visual-sign-off shots. */
export const VISUAL_SIGNOFF_STEP_ATTACHMENT = {
  id: 'vso-step-shot',
  taskId: VISUAL_SIGNOFF_STEP_TASK.id,
  name: 'retry-ui.png',
  fileName: 'retry-ui.png',
  mimeType: 'image/png',
  size: 32_000,
  createdAt: now - 30_000,
};

/**
 * One inbox item — an agent question parked on the same owner card `VISUAL_SIGNOFF_ATTACHMENTS`
 * already hangs off (`13a`) — proving `InboxItem` (`Attention.tsx`) shows a run's own files
 * inline, not just the card panel's `VisualSignOff`/`FilesSection`. Every row but
 * `inbox-item-attachments` leaves `attention:list` at the shared fixture's empty `'list'`
 * fallback below; only that row's own `channelOverrides` supplies this.
 */
export const INBOX_QUESTION_ITEM = {
  id: 'att-vso-1',
  runId: 'run-vso-1',
  taskId: '13a',
  projectId: PROJECT_ID,
  taskTitle: 'Wire the retry queue to the dashboard',
  kind: 'question',
  prompt: 'Screenshots attached — does the dashboard layout match the mockup?',
  options: [],
  toolName: null,
  reason: null,
  createdAt: now - 120_000,
};

/**
 * The owner card `13a`'s timeline once the project's AI reviewer approved its shots: one
 * needs-changes round, then the AI's own sign-off — so `VisualSignOff`'s badge reads
 * "Approved (AI reviewer)" with its "AI review: round 1 of 2" line under it. Only the
 * `visual-signoff-ai-approved-*` rows serve this (as `task:activity`); every other row keeps
 * 13a's timeline empty and its badge "Pending".
 */
export const VISUAL_SIGNOFF_AI_APPROVED_ACTIVITY = [
  {
    kind: 'comment',
    id: 901,
    body: 'AI visual review: needs changes (round 1 of 2)\n\n- board-light: the toolbar overlaps the first column',
    createdAt: now - 20 * 60_000,
  },
  {
    kind: 'comment',
    id: 902,
    body: 'Visual sign-off: approved (AI reviewer)',
    createdAt: now - 5 * 60_000,
  },
];

export const CHANNELS = {
  'attachment:list': VISUAL_SIGNOFF_ATTACHMENTS,
};
