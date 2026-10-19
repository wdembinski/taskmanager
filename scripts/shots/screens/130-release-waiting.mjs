/**
 * Releasing the cards chained after a card moved to Done by hand — see `ui-shots.mjs`'s header
 * doc for the row shape and `scripts/lib/shotModules.mjs` for how this file is merged with its
 * siblings. Every row boots the `90-release-waiting.mjs` cards through its own
 * `channelOverrides`; the web board draws the same dialog and chip from the same components,
 * but `090-web.mjs`'s shared relay has no per-row overrides, so it has no row here.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';
import {
  RELEASE_LINKS,
  RELEASE_MOVES,
  RELEASE_PROJECTS,
  RELEASE_TASKS,
} from '../../fixtures/shots/90-release-waiting.mjs';

const channelOverrides = {
  'board:tasks': [...BOOT_CHANNELS['board:tasks'], ...RELEASE_TASKS],
  'chain:links': [...BOOT_CHANNELS['chain:links'], ...RELEASE_LINKS],
  'project:list': RELEASE_PROJECTS,
  ...RELEASE_MOVES,
};

const VIEWPORT = { width: 1440, height: 900 };

/** Open FX-rw1 and set its State to Done: the dialog asks, Release leading (no branch). */
const dialogRow = (scheme) => ({
  name: `release-waiting-dialog-${scheme}`,
  app: 'client',
  viewport: VIEWPORT,
  scheme,
  setup: [{ click: 'board-card:rw1' }, { click: 'title:Status' }, { click: 'option:Done' }],
  expect: '[role="dialog"]',
  mockup: `v10-22-release-waiting-${scheme}.svg`,
  channelOverrides,
});

/** Hover FX-rw5's waiting chip: `Waits for FX-rw4 to merge (Done, not landed)`. */
const reasonRow = (scheme) => ({
  name: `waiting-reason-${scheme}`,
  app: 'client',
  viewport: VIEWPORT,
  scheme,
  setup: [{ hover: '[data-task-id="rw5"] [data-waiting-on]' }],
  expect: '[role="tooltip"]',
  mockup: `v10-23-waiting-reason-${scheme}.svg`,
  channelOverrides,
});

export default [
  dialogRow('light'),
  dialogRow('dark'),
  reasonRow('light'),
  reasonRow('dark'),
  {
    // FX-rw4 is Done and never landed, still holding FX-rw5: its panel offers Release waiting
    // cards, which opens the same dialog. No mockup draws the panel block on its own.
    name: 'release-waiting-panel-light',
    app: 'client',
    viewport: VIEWPORT,
    scheme: 'light',
    setup: [{ click: 'board-card:rw4' }, { scrollToSelector: '[data-release-waiting]' }],
    expect: '[data-release-waiting]',
    mockup: null,
    channelOverrides,
  },
];
