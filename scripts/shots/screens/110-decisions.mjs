/**
 * The Inbox's open owner decisions — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import {
  DECISION_PROJECTS,
  DECISION_TASKS,
  INBOX_PLANNING_QUESTION,
} from '../../fixtures/shots/70-decisions.mjs';
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';

export default [
  {
    // Proves `Attention()` draws `InboxDecisions.tsx`'s section above the attention list:
    // the "Decisions" heading, one subheading per project, each card's question and its own
    // answer box. `channelOverrides` adds the two flagged cards to `board:tasks` and the
    // second project to `project:list` for this row alone (`70-decisions.mjs`). The mockup
    // draws the Inbox's layout but predates decisions — it has no such section, so it is kept
    // for the surrounding chrome only, as `inbox-plan-check-light` does.
    name: 'inbox-decisions',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Inbox' }],
    expect: '[data-inbox-decisions]',
    mockup: 'v10-14-inbox-light.svg',
    channelOverrides: {
      'board:tasks': [...BOOT_CHANNELS['board:tasks'], ...DECISION_TASKS],
      'project:list': DECISION_PROJECTS,
    },
  },
  {
    // Proves `InboxItem`'s question branch offers "Make this a decision on the card" next to
    // Send for a question a PLANNING run raised (`AttentionItem.duringPlanning`), with the
    // question and its two option buttons above it. `channelOverrides` supplies that one item
    // (`INBOX_PLANNING_QUESTION`); the board is the shared fixture's, so no decisions section
    // draws. The mockup predates both, and is kept for the surrounding chrome only.
    name: 'inbox-plan-decision',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Inbox' }],
    expect: '[data-make-decision]',
    mockup: 'v10-14-inbox-light.svg',
    channelOverrides: {
      'attention:list': [INBOX_PLANNING_QUESTION],
    },
  },
];
