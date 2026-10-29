/**
 * Per-task activity and comment data for the Tickets screens — see `uiShotsFixture.mjs`'s own
 * header doc for how `CHANNELS` here is merged with every other file under this directory.
 */
import { now } from '../shotsFixtureHelpers.mjs';

/**
 * `task:activity`, by task id — read when `issue-peek`/`issue-full-screen` open a card
 * (`TaskDetail.tsx`'s `loadActivity`). Keyed on the fixture's own task ids (`boardShotsFixture
 * .mjs`'s `agentRunningParent`/`mrChangesRequestedCard`), rather than exporting those tasks
 * individually just to attach activity to them.
 */
export const TASK_ACTIVITY = {
  3: [
    {
      kind: 'chat',
      id: 1,
      body: 'Use the existing archive query, not a new fetch.',
      createdAt: now - 4 * 60_000,
    },
    { kind: 'status', id: 2, from: 'pending', to: 'in-progress', createdAt: now - 5 * 60_000 },
  ],
  6: [
    {
      kind: 'comment',
      id: 3,
      body: 'Left two inline notes on the diff.',
      createdAt: now - 30 * 60_000,
    },
  ],
};

/** The jira-sourced `trackerUnread` card's (`boardShotsFixture.mjs` id `'12'`) live comment
 *  thread — `ticketChannels('jira').fetchComments`, merged into the same timeline. */
export const TICKET_COMMENTS = {
  12: [
    {
      kind: 'jira-comment',
      id: 'c1',
      author: 'Wiktor Nowak',
      body: 'Can we also dedupe on externalKey while we are in here?',
      createdAt: now - 3 * 60 * 60 * 1000,
      mine: false,
    },
  ],
};

export const CHANNELS = {
  'task:activity': { byArgTable: TASK_ACTIVITY, fallback: [] },
  'jira:fetchComments': { byArgTable: TICKET_COMMENTS, fallback: [] },
};
