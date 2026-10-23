/**
 * The ticket panel's Ticket band (Details, then Links) above the conversation, full screen at
 * 1440x900, in the three states that decide how much room the band is left: no conversation
 * and no links, no conversation and two links, and a conversation long enough to overflow.
 * Every row carries a `layoutCheck` proving the "Links" heading is laid out in full and clear
 * of the conversation — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 *
 * `v9-2-issue-detail-light.svg` is the closest stand-in mockup; it does not draw these exact
 * states (no empty Links, no long conversation), so compare the band's order, not its rows.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';
import { now } from '../../fixtures/shotsFixtureHelpers.mjs';

/** The card `'issue-row:first'` opens — see `040-issues.mjs`'s `DECISION_TASKS`. */
const TASK_ID = '13a';

/** The fixture's own arrows with every one touching `13a` dropped: the Links empty state. */
const NO_LINKS = BOOT_CHANNELS['chain:links'].filter(
  (l) => l.fromTaskId !== TASK_ID && l.toTaskId !== TASK_ID,
);

/** Exactly two arrows on `13a`: `14a → 13a` (Blocked by) and `13a → 13b` (Blocks). */
const TWO_LINKS = [
  ...NO_LINKS,
  { id: 'link-band-1', fromTaskId: '14a', toTaskId: TASK_ID, gate: 'after-merge' },
  { id: 'link-band-2', fromTaskId: TASK_ID, toTaskId: '13b', gate: 'after-merge' },
];

/** Thirty fixed-time entries alternating notes and messages to the agent, oldest first, so the
 *  conversation is far taller than the room it is given. */
const LONG_CHAT = Array.from({ length: 30 }, (_, i) => ({
  kind: i % 2 === 0 ? 'comment' : 'chat',
  id: 4500 + i,
  body:
    i % 2 === 0
      ? `Note ${i + 1}: the retry queue drained after the deploy; keep an eye on the dashboard.`
      : `Message ${i + 1}: please re-run the queue check and report what changed since the last run.`,
  createdAt: now - (30 - i) * 10 * 60_000,
}));

const STATES = [
  {
    state: 'empty',
    channelOverrides: {
      'chain:links': NO_LINKS,
      'ticketLink:list': [],
      'task:activity': { byArgTable: { [TASK_ID]: [] }, fallback: [] },
    },
  },
  {
    state: 'two-links',
    channelOverrides: {
      'chain:links': TWO_LINKS,
      'ticketLink:list': [],
      'task:activity': { byArgTable: { [TASK_ID]: [] }, fallback: [] },
    },
  },
  {
    state: 'long-chat',
    // Band + the conversation's floor outgrow a 1440x900 pane, so the region above the
    // composer opens scrolled to the top with the conversation below the fold — the same
    // frame as `visual-signoff-dark`, byte for byte. Scrolling that region to the Links
    // heading brings the conversation into frame under it, which is what this state proves.
    scrollTo: '[data-links-heading]',
    channelOverrides: {
      'task:activity': { byArgTable: { [TASK_ID]: LONG_CHAT }, fallback: [] },
    },
  },
];

export default STATES.flatMap(({ state, scrollTo, channelOverrides }) =>
  ['light', 'dark'].map((scheme) => ({
    name: `ticket-band-${state}-${scheme}`,
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme,
    setup: [
      { click: 'Tickets' },
      { click: 'issue-row:first' },
      { click: 'Open full screen' },
      ...(scrollTo === undefined ? [] : [{ scrollToSelector: scrollTo }]),
    ],
    expect: '[data-links-heading]',
    layoutCheck: {
      visible: '[data-links-heading]',
      clear: ['[role="log"][aria-label="Conversation"]'],
    },
    mockup: 'v9-2-issue-detail-light.svg',
    channelOverrides,
  })),
);
