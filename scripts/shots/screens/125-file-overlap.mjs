/**
 * The board's file-hold chip — see `ui-shots.mjs`'s header doc for the row shape and
 * `scripts/lib/shotModules.mjs` for how this file is merged with its siblings.
 */
import { BOOT_CHANNELS } from '../../fixtures/uiShotsFixture.mjs';
import {
  OVERLAP_ACTIVE_RUNS,
  OVERLAP_PROJECTS,
  OVERLAP_TASKS,
} from '../../fixtures/shots/85-file-overlap.mjs';

export default [
  {
    // Proves `chainStates`' file holds reach the card: FX-f1 is running with
    // `packages/ui/src/board/taskcard.tsx` planned, and FX-f2 in To Do plans the glob
    // `packages/ui/src/board/*.tsx`, so FX-f2 wears `waits for FX-f1 (same files: …)` with its
    // "Make this an arrow" button and FX-f1 wears no chip. `channelOverrides` adds the cards,
    // the run and their project for this row alone (`85-file-overlap.mjs`). No mockup draws
    // this chip — `board-light`'s is kept for the surrounding chrome only. The web board draws
    // the same chip from the same `chainStates`, but `090-web.mjs`'s shared relay has no
    // per-row overrides, so it has no row of its own here.
    name: 'board-file-overlap-light',
    app: 'client',
    viewport: { width: 1440, height: 900 },
    scheme: 'light',
    setup: null,
    expect: '[data-file-hold]',
    mockup: 'v9-7-board-light.svg',
    channelOverrides: {
      'board:tasks': [...BOOT_CHANNELS['board:tasks'], ...OVERLAP_TASKS],
      'scheduler:activeRuns': [...BOOT_CHANNELS['scheduler:activeRuns'], ...OVERLAP_ACTIVE_RUNS],
      'project:list': OVERLAP_PROJECTS,
    },
  },
];
