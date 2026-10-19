/**
 * The Inbox's plan-check verdict and the project form's auto-approve switches — see
 * `ui-shots.mjs`'s header doc for the row shape and `scripts/lib/shotModules.mjs` for how
 * this file is merged with its siblings.
 */
import { INBOX_PLAN_ITEM } from '../../fixtures/shots/60-plan-check.mjs';

export default [
  {
    // Proves the Inbox (`Attention.tsx`'s `InboxItem`) renders a `plan-approval` item's
    // stored `planCheck` verdict (`PlanCheckVerdict.tsx`) alongside the plan itself — not
    // just that the component renders in isolation (`Attention.render.test.tsx`).
    // `channelOverrides` supplies the one failing-check item (`INBOX_PLAN_ITEM`); every
    // other row leaves `attention:list` at the shared fixture's empty `'list'` fallback, so
    // nothing elsewhere grows an inbox item it was not asked to (same pattern as
    // `inbox-item-attachments` in `050-attachments.mjs`). The mockup draws the Inbox's
    // layout but predates this card — it has no plan-check panel at all, so this row is
    // its own proof for that part of the screen; the mockup is kept only for the
    // surrounding chrome.
    name: 'inbox-plan-check-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Inbox' }],
    expect: '[data-plan-check]',
    mockup: 'v10-14-inbox-light.svg',
    channelOverrides: {
      'attention:list': [INBOX_PLAN_ITEM],
    },
  },
  {
    // Proves the Projects screen's edit form (`ProjectForm.tsx`) shows the auto-approve
    // switch and its "Most steps" field. Same click path as every other row that opens an
    // existing project's edit dialog: `'Projects'` (`Sidebar.tsx`'s nav button), then
    // `'Edit'` on the one fixture project's own card (`Projects.tsx`). No mockup draws this
    // card's own fields yet.
    name: 'project-form-auto-approve-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Projects' },
      { click: 'Edit' },
      { scrollToSelector: '[data-auto-approve-plans]' },
    ],
    expect: '[data-auto-approve-plans]',
    mockup: null,
  },
];
