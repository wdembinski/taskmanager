/**
 * The Start dialog's roles table and estimate line (F28.1, mockup v11-4) — see
 * `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is merged with every other
 * file under this directory.
 *
 * FX-212 is a card staged on the fixture's agent project with six planned steps, so the
 * estimate counts the mockup's 7–9 sessions. The project plans on `opus` and executes on
 * `sonnet`, so the four rows name both models the way v11-4 draws them, and it carries a
 * run history (`project:runStats`) whose figures give the mockup's `$6–12 · ~40 min`.
 *
 * Nothing here joins the shared `CHANNELS`: the card, its steps and the history reach the
 * `170-start-roles.mjs` rows alone, through their own `channelOverrides`.
 */
import { PROJECTS, PROJECT_ID } from '../boardShotsFixture.mjs';
import { sidebarTicket } from '../shotsFixtureHelpers.mjs';

/** `project:list` with the fixture's project planning on opus and every role field unset. */
export const START_ROLES_PROJECTS = PROJECTS.map((entry, i) =>
  i === 0
    ? {
        ...entry,
        project: {
          ...entry.project,
          planningModel: 'opus',
          reviewModel: null,
          leadModel: null,
          leadEffort: null,
          planningEffort: null,
          workerEffort: null,
          reviewEffort: null,
        },
      }
    : entry,
);

/** The card the dialog opens on: staged on the agent project, never run. */
export const START_CARD = sidebarTicket({
  id: '212',
  title: 'Offline outbox for the desktop replica',
  agentProjectId: PROJECT_ID,
  order: -40,
});

const STEP_TITLES = [
  'Add the outbox table',
  'Queue writes while offline',
  'Replay the queue on reconnect',
  'Resolve replay conflicts',
  'Show the pending count',
  'Cover the replay with tests',
];

export const START_STEPS = STEP_TITLES.map((title, i) =>
  sidebarTicket({ id: `212-s${i + 1}`, title, parentTaskId: START_CARD.id, order: i }),
);

/** Forty past sessions at $0.90–1.30 each, about six minutes apiece. */
export const START_RUN_STATS = {
  sessionCount: 40,
  costPerSessionUsd: { low: 0.9, high: 1.3 },
  minutesPerSession: 5.7,
};

export const CHANNELS = {};
