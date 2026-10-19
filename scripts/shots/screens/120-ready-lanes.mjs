/**
 * The board's lane cap — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';
import { LANE_LINKS, LANE_PROJECTS, LANE_TASKS } from '../../fixtures/shots/80-ready-lanes.mjs';

export default [
  {
    // Proves `chainStates`' lane inputs reach the card: five satisfied successors in a project
    // with the default 3 Ready lanes and nothing running, so FX-l1…FX-l3 (High, High, Medium)
    // wear `ready` and FX-l4/FX-l5 wear `queued (lane limit)`. `channelOverrides` adds the
    // cards, their arrows and their project for this row alone (`80-ready-lanes.mjs`). The
    // mockup is `board-light`'s and predates the cap — kept for the surrounding chrome only.
    // The web board draws the same chips from the same `chainStates`, but `090-web.mjs`'s
    // shared relay has no per-row overrides, so it has no row of its own here.
    name: 'board-ready-lanes-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    expect: '[data-chain-queued]',
    mockup: 'v9-7-board-light.svg',
    channelOverrides: {
      'board:tasks': [...BOOT_CHANNELS['board:tasks'], ...LANE_TASKS],
      'chain:links': [...BOOT_CHANNELS['chain:links'], ...LANE_LINKS],
      'project:list': LANE_PROJECTS,
    },
  },
];
