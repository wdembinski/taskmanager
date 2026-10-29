/**
 * The board against its column-width and Links: Off mockups — see `ui-shots.mjs`'s header doc
 * for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings. `010-board.mjs` already shoots the light and dark resting board at 1440×900.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';

// `nextLinkMode` cycles off → focus → all → off and the board boots on `'all'`, so one `l`
// press lands on Off — where every chained card carries its needs/unblocks row instead of an
// arrow.
const LINKS_OFF = [{ key: 'l' }];

// The fixture's two chains are single arrows (13a → 13b, 14a → 14b), so no card both needs and
// unblocks. 13b → 14a joins them into one chain: 13b and 14a then read "needs … unblocks …" on
// one line, and 14b reads "needs" alone — v10-7e draws both shapes. Acyclic.
const LINKS_OFF_CHANNELS = {
  'chain:links': [
    ...BOOT_CHANNELS['chain:links'],
    { id: 'link-13b-14a', fromTaskId: '13b', toTaskId: '14a', gate: 'after-merge', createdAt: 0 },
  ],
};

// Proves the row rendered, and that it sits inside its card's clip rather than spilling out.
// 13a's card is the one in frame at 1440×900 — To Do's chained cards sit below the fold.
const LINK_CHIPS_CHECK = { visible: '[data-task-id="13a"] [data-link-chips]', clear: [] };

const linksOff = (name, viewport) => ({
  name,
  app: 'client',
  viewport,
  scheme: 'light',
  setup: LINKS_OFF,
  expect: '[data-board-header]',
  mockup: 'v10-7e-board-links-off-light.svg',
  channelOverrides: LINKS_OFF_CHANNELS,
  layoutCheck: LINK_CHIPS_CHECK,
});

// The mockups are drawn at 1440×900 and rasterized at the row's own viewport, so at 2560 the
// mockup is scaled up. Compare the column width there (≈260px, packed to the left, empty
// canvas to the right) — not the scale of the drawing.
const WIDE = { width: 2560, height: 1440 };

export default [
  linksOff('board-links-off-light', { width: 1440, height: 900 }),
  {
    name: 'board-light-2560',
    app: 'client',
    viewport: WIDE,
    scheme: 'light',
    setup: null,
    expect: '[data-board-header]',
    mockup: 'v9-7-board-light.svg',
  },
  {
    name: 'board-dark-2560',
    app: 'client',
    viewport: WIDE,
    scheme: 'dark',
    setup: null,
    expect: '[data-board-header]',
    mockup: 'v9-7b-board-dark.svg',
  },
  linksOff('board-links-off-light-2560', WIDE),
];
