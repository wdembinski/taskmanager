/**
 * Releasing the cards chained after a card moved to Done by hand — the release dialog, the
 * waiting chip's `waitReason` tooltip and the panel's **Release waiting cards**
 * (`@tm/shared/releaseOnDone`, `ReleaseWaitingDialog.tsx`). See `uiShotsFixture.mjs`'s own
 * header doc for how `CHANNELS` here is merged with every other file under this directory.
 *
 * FX-rw1 is a branchless sign-off card (no agent, so nothing could ever land) resting in
 * In Review with two `after-merge` successors in To Do, FX-rw2 and FX-rw3. Setting its State to
 * Done in the detail pane asks, Release leading — `task:setStatus` answers with FX-rw1 as Done.
 * FX-rw4 is the other half: already Done, never landed, still holding FX-rw5, whose chip says
 * `Waits for FX-rw4 to merge (Done, not landed)`.
 *
 * Filed under a project of their own, like `80-ready-lanes.mjs`, and nothing here joins the
 * shared `CHANNELS`: the cards, arrows and project reach the `130-release-waiting.mjs` rows
 * alone, through their own `channelOverrides`.
 */
import { PROJECTS } from '../boardShotsFixture.mjs';
import { now, sidebarTicket } from '../shotsFixtureHelpers.mjs';

export const RELEASE_PROJECT_ID = 'proj-fx-release';

/** `project:list` with the release project beside the fixture's own. */
export const RELEASE_PROJECTS = [
  ...PROJECTS,
  {
    project: {
      ...PROJECTS[0].project,
      id: RELEASE_PROJECT_ID,
      name: 'Release',
      path: 'C:/repos/release',
      ticketPrefix: 'FX',
      readyLanes: 3,
    },
    tasks: [],
  },
];

const card = (over) => sidebarTicket({ projectId: RELEASE_PROJECT_ID, ...over });

/** The branchless predecessor a human is about to call Done. */
export const SIGN_OFF = card({
  id: 'rw1',
  title: 'Sign off the release notes',
  status: 'in-review',
  order: -30,
});

/** Already Done by hand, never landed — the panel's Release waiting cards. */
export const DONE_NOT_LANDED = card({
  id: 'rw4',
  title: 'Approve the API contract',
  status: 'done',
  order: -10,
});

const successors = [
  card({
    id: 'rw2',
    title: 'Publish the 2.0 changelog',
    agentProjectId: RELEASE_PROJECT_ID,
    order: -29,
  }),
  card({
    id: 'rw3',
    title: 'Tag the 2.0 release',
    agentProjectId: RELEASE_PROJECT_ID,
    order: -28,
  }),
  card({
    id: 'rw5',
    title: 'Generate the API client',
    agentProjectId: RELEASE_PROJECT_ID,
    order: -9,
  }),
];

export const RELEASE_TASKS = [SIGN_OFF, DONE_NOT_LANDED, ...successors];

const arrow = (from, to) => ({
  id: `link-${from}-${to}`,
  fromTaskId: from,
  toTaskId: to,
  gate: 'after-merge',
  createdAt: now,
});

export const RELEASE_LINKS = [arrow('rw1', 'rw2'), arrow('rw1', 'rw3'), arrow('rw4', 'rw5')];

/** What the move and the State dropdown answer for FX-rw1: the card, now Done, not landed. */
const MOVED = { byArgTable: { rw1: { ...SIGN_OFF, status: 'done' } }, fallback: null };
export const RELEASE_MOVES = { 'task:move': MOVED, 'task:setStatus': MOVED };

/** Empty on purpose — see the header doc. */
export const CHANNELS = {};
