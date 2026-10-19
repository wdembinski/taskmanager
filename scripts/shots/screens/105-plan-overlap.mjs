/**
 * The Inbox's plan-overlap warning — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { INBOX_PLAN_OVERLAP_ITEM } from '../../fixtures/shots/65-plan-overlap.mjs';

export default [
  {
    // Proves the Inbox (`Attention.tsx`'s `PlanOverlapWarning`) warns, above the plan-check
    // verdict, which active card a plan's files collide with — one line per card. Same
    // `channelOverrides` pattern as `inbox-plan-check-light` (`100-plan-check.mjs`); the
    // mockup predates the warning and is kept only for the surrounding chrome.
    name: 'inbox-plan-overlap-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Inbox' }],
    expect: '[data-plan-overlap]',
    mockup: 'v10-14-inbox-light.svg',
    channelOverrides: {
      'attention:list': [INBOX_PLAN_OVERLAP_ITEM],
    },
  },
];
