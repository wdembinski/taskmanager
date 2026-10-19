/**
 * Five satisfied successors of one landed card, more than a project's default three Ready
 * lanes hold — the board's `ready` / `queued (lane limit)` chips (`readyLanes.ts`,
 * `chainStates.ts`). See `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is
 * merged with every other file under this directory.
 *
 * Filed under a project of their own rather than the fixture's: the fixture project already
 * has every one of its three lanes taken (a running step, a card waiting on input, two reviews
 * with an open MR), so its own candidates would all read queued and the shot could not show
 * the cap's two halves side by side. This project has nothing running, so its default cap of 3
 * leaves 3 `ready` and 2 `queued`.
 *
 * Nothing here joins the shared `CHANNELS`: the cards, the arrows and the project reach
 * `board-ready-lanes-light` alone, through its own `channelOverrides`
 * (`scripts/shots/screens/120-ready-lanes.mjs`), so no other row's board changes.
 */
import { PROJECTS } from '../boardShotsFixture.mjs';
import { now, sidebarTicket } from '../shotsFixtureHelpers.mjs';

export const LANES_PROJECT_ID = 'proj-fx-lanes';

/** `project:list` with the lanes project beside the fixture's own, at the default cap. */
export const LANE_PROJECTS = [
  ...PROJECTS,
  {
    project: {
      ...PROJECTS[0].project,
      id: LANES_PROJECT_ID,
      name: 'Lanes',
      path: 'C:/repos/lanes',
      ticketPrefix: 'FX',
      readyLanes: 3,
    },
    tasks: [],
  },
];

/** The one predecessor every lane card runs after — merged, so every arrow is satisfied. */
const landedPredecessor = sidebarTicket({
  id: 'l0',
  title: 'Cut the shared release branch',
  projectId: LANES_PROJECT_ID,
  ticketKey: 'FX-l0',
  status: 'done',
  landedAt: now,
  agentProjectId: LANES_PROJECT_ID,
});

/** Most urgent first — the order the lanes are handed out in (`compareLaneOrder`). */
const LANE_CARDS = [
  ['l1', 'High', 'Rotate the signing certificate'],
  ['l2', 'High', 'Pin the updater feed URL'],
  ['l3', 'Medium', 'Retry a failed asset upload'],
  ['l4', 'Medium', 'Show the release channel in Settings'],
  ['l5', 'Low', 'Trim the changelog template'],
].map(([id, priority, title], i) =>
  sidebarTicket({
    id,
    title,
    projectId: LANES_PROJECT_ID,
    ticketKey: `FX-${id}`,
    externalPriority: priority,
    agentProjectId: LANES_PROJECT_ID,
    order: -10 + i,
  }),
);

export const LANE_TASKS = [landedPredecessor, ...LANE_CARDS];

export const LANE_LINKS = LANE_CARDS.map((t) => ({
  id: `link-${landedPredecessor.id}-${t.id}`,
  fromTaskId: landedPredecessor.id,
  toTaskId: t.id,
  gate: 'after-merge',
  createdAt: now,
}));

/** Empty on purpose — see the header doc. */
export const CHANNELS = {};
