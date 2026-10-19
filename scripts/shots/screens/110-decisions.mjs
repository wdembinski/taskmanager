/**
 * The Inbox's open owner decisions — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { DECISION_PROJECTS, DECISION_TASKS } from '../../fixtures/shots/70-decisions.mjs';
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
];
