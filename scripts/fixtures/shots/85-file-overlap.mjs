/**
 * Two cards in one project that touch the same files — the board's
 * `waits for FX-f1 (same files: …)` chip (`fileOverlap.ts`, `chainStates.ts`). See
 * `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every other
 * file under this directory.
 *
 * FX-f1 is running with `packages/ui/src/board/taskcard.tsx` planned; FX-f2 sits in To Do with
 * the glob `packages/ui/src/board/*.tsx`, which matches it. Nobody chained them: the hold
 * applies to every card in To Do, and the chip's "Make this an arrow" is what would chain
 * them. Filed under a project of their own, like `80-ready-lanes.mjs`, so the fixture
 * project's cards — none of which have files — stay exactly as every other row draws them.
 *
 * Nothing here joins the shared `CHANNELS`: the cards and the project reach
 * `board-file-overlap-light` alone, through its own `channelOverrides`
 * (`scripts/shots/screens/125-file-overlap.mjs`).
 */
import { PROJECTS } from '../boardShotsFixture.mjs';
import { now, sidebarTicket } from '../shotsFixtureHelpers.mjs';

export const OVERLAP_PROJECT_ID = 'proj-fx-overlap';

/** `project:list` with the overlap project beside the fixture's own. */
export const OVERLAP_PROJECTS = [
  ...PROJECTS,
  {
    project: {
      ...PROJECTS[0].project,
      id: OVERLAP_PROJECT_ID,
      name: 'Overlap',
      path: 'C:/repos/overlap',
      ticketPrefix: 'FX',
      readyLanes: 3,
    },
    tasks: [],
  },
];

/** The card holding the files — its agent is at work on it. */
const holder = sidebarTicket({
  id: 'f1',
  title: 'Tighten the card footer spacing',
  projectId: OVERLAP_PROJECT_ID,
  ticketKey: 'FX-f1',
  status: 'running',
  preRunStatus: 'in-progress',
  sessionId: 'sess-fx-f1',
  agentProjectId: OVERLAP_PROJECT_ID,
  workedAt: now,
  plannedFiles: ['packages/ui/src/board/taskcard.tsx'],
});

/** The card it holds back — its plan's Critical files glob over the holder's file. */
const held = sidebarTicket({
  id: 'f2',
  title: 'Show the reviewer on every board card',
  projectId: OVERLAP_PROJECT_ID,
  ticketKey: 'FX-f2',
  agentProjectId: OVERLAP_PROJECT_ID,
  order: -20,
  plannedFiles: ['packages/ui/src/board/*.tsx'],
});

export const OVERLAP_TASKS = [holder, held];

/** FX-f1's live run, beside the fixture's own (`scheduler:activeRuns`). */
export const OVERLAP_ACTIVE_RUNS = [{ taskId: holder.id, runId: 'run-fx-f1' }];

/** Empty on purpose — see the header doc. */
export const CHANNELS = {};
