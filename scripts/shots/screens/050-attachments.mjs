/**
 * The card panel's own visual sign-off and files sections, plus the Inbox's inline attachments
 * — see `ui-shots.mjs`'s header doc for the row shape and `scripts/lib/shotModules.mjs` for how
 * this file is merged with its siblings.
 */
import {
  INBOX_QUESTION_ITEM,
  VISUAL_SIGNOFF_AI_APPROVED_ACTIVITY,
  VISUAL_SIGNOFF_ATTACHMENTS,
  VISUAL_SIGNOFF_STEP_ATTACHMENT,
  VISUAL_SIGNOFF_STEP_TASK,
} from '../../fixtures/shots/30-attachments.mjs';
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';

export default [
  {
    // Same setup as `issue-full-screen` — `'Tickets'`, `'issue-row:first'`, `'Open full
    // screen'` — opening whichever card the Tickets list puts first; `uiShotsFixture.mjs`'s
    // own `VISUAL_SIGNOFF_ATTACHMENTS` hangs a shot pair off that same id (see its own doc
    // comment on which id, and why) so this row's `expect` can prove `VisualSignOff.tsx`
    // actually renders in the card panel, not just in its own render test. `scheme: 'dark'`
    // (unlike `issue-full-screen`'s `'light'`) is not just variety: with the exact same
    // setup steps, a `'light'` shot here would be byte-identical to `issue-full-screen`'s own
    // and `--attach` would refuse the whole run as a duplicate (see `SCREENS`' own doc on
    // hashing). No mockup draws this section yet.
    name: 'visual-signoff-dark',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'dark',
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }, { click: 'Open full screen' }],
    expect: '[data-visual-signoff]',
    // The sign-off band makes the Ticket band tallest of any full-screen row — the state
    // most likely to squeeze the Links heading under the conversation.
    layoutCheck: {
      visible: '[data-links-heading]',
      clear: ['[role="log"][aria-label="Conversation"]'],
    },
    mockup: null,
  },
  // The same section once the project's AI reviewer approved the shots: `task:activity` for
  // 13a ends in `Visual sign-off: approved (AI reviewer)`, so the badge names the reviewer.
  // No mockup draws this section.
  ...['light', 'dark'].map((scheme) => ({
    name: `visual-signoff-ai-approved-${scheme}`,
    app: 'client',
    viewport: { width: 1280, height: 900 },
    scheme,
    setup: [{ click: 'Tickets' }, { click: 'issue-row:first' }, { click: 'Open full screen' }],
    expect: '[data-visual-signoff] [data-signoff-by="ai"]',
    mockup: null,
    channelOverrides: {
      'task:activity': {
        byArgTable: { '13a': VISUAL_SIGNOFF_AI_APPROVED_ACTIVITY },
        fallback: [],
      },
    },
  })),
  {
    // Proves the Inbox (`Attention.tsx`'s `InboxItem`) shows an agent question's own files
    // inline, not just the card panel's own sections. `attachment:list` is already globally
    // `VISUAL_SIGNOFF_ATTACHMENTS` (hung off task `13a` — see `visual-signoff-dark`'s own
    // comment), so the one thing missing is a real `attention:list` item for that same task;
    // this row's `channelOverrides` supplies it (`uiShotsFixture.INBOX_QUESTION_ITEM`).
    // Every other row leaves that channel at the shared fixture's empty `'list'` fallback, so
    // nothing elsewhere grows an inbox item it was not asked to.
    name: 'inbox-item-attachments',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [{ click: 'Inbox' }],
    expect: '[data-attachment-gallery]',
    mockup: null,
    channelOverrides: {
      'attention:list': [INBOX_QUESTION_ITEM],
    },
  },
  {
    // Proves `FilesSection` actually groups a card's files by step, not just by the card
    // itself. Same setup as `issue-full-screen`/`visual-signoff-dark` (`'Tickets'`,
    // `'issue-row:first'`, `'Open full screen'`), but `channelOverrides` additionally gives
    // 13a one step of its own (`VISUAL_SIGNOFF_STEP_TASK`) carrying a file of its own
    // (`VISUAL_SIGNOFF_STEP_ATTACHMENT`) — scoped to this row alone so `issue-row:first`'s
    // position cannot shift for either of those other two rows (see that task's own doc
    // comment on why it never counts as a ticket/board row of its own). The extra
    // `scrollToSelector` step is what actually brings `[data-files-section]` into frame —
    // `issue-full-screen`/`visual-signoff-dark` never scroll past it, so neither has proven
    // this section renders at all, only that it does not crash.
    name: 'files-section-grouped',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: [
      { click: 'Tickets' },
      { click: 'issue-row:first' },
      { click: 'Open full screen' },
      { scrollToSelector: '[data-files-section]' },
    ],
    expect: '[data-files-section]',
    mockup: null,
    channelOverrides: {
      'board:tasks': [...BOOT_CHANNELS['board:tasks'], VISUAL_SIGNOFF_STEP_TASK],
      'attachment:list': [...VISUAL_SIGNOFF_ATTACHMENTS, VISUAL_SIGNOFF_STEP_ATTACHMENT],
    },
  },
];
