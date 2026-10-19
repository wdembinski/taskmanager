/**
 * Two cards holding an open owner decision, in two projects — the Inbox's decisions list
 * (`InboxDecisions.tsx`). See `uiShotsFixture.mjs`'s own header doc for how `CHANNELS` here is
 * merged with every other file under this directory.
 *
 * Plus one planning question for `inbox-plan-decision`.
 *
 * Nothing here joins the shared `CHANNELS`: the flagged cards and the second project reach
 * `inbox-decisions` alone (and the question `inbox-plan-decision` alone), through each row's
 * own `channelOverrides`
 * (`scripts/shots/screens/110-decisions.mjs`), so no other row's board, Inbox or sidebar
 * changes.
 */
import { PROJECT_ID, PROJECTS } from '../boardShotsFixture.mjs';
import { DAY, sidebarTicket } from '../shotsFixtureHelpers.mjs';

export const BILLING_PROJECT_ID = 'proj-fx-billing';

/** `project:list` with a second project beside the fixture's own, so the list has two
 *  project subheadings to sort ("Billing" before "Fixture"). */
export const DECISION_PROJECTS = [
  ...PROJECTS,
  {
    project: {
      ...PROJECTS[0].project,
      id: BILLING_PROJECT_ID,
      name: 'Billing',
      path: 'C:/repos/billing',
      ticketPrefix: 'BIL',
      color: '#8764B8',
    },
    tasks: [],
  },
];

/** Asked against the real clock, not the fixture's own `now`, so the age line reads "N days
 *  ago" rather than a date in January. */
const asked = Date.now();

/** The two flagged cards — one per project. */
export const DECISION_TASKS = [
  sidebarTicket({
    id: 'dec-1',
    title: 'Choose the hosting plan',
    projectId: BILLING_PROJECT_ID,
    ticketKey: 'BIL-4',
    decisionQuestion:
      'Which hosting plan do we pay for — the monthly one, or the yearly one at a discount?',
    decisionAskedAt: asked - 2 * DAY,
  }),
  sidebarTicket({
    id: 'dec-2',
    title: 'Publish the mobile build',
    projectId: PROJECT_ID,
    ticketKey: 'FX-dec-2',
    decisionQuestion: 'Whose developer account publishes the app to the stores?',
    decisionAskedAt: asked - DAY,
  }),
];

/**
 * One `@@NEEDS_INPUT@@` question a PLANNING run raised (`duringPlanning`), with the two
 * choices the planner offered — what `inbox-plan-decision` shows with its "Make this a
 * decision on the card" button. Parked on fixture task `'1'` (`plainBacklog`), an existing
 * `TASKS` row, as `INBOX_PLAN_ITEM` (`60-plan-check.mjs`) is.
 */
export const INBOX_PLANNING_QUESTION = {
  id: 'att-plan-question-1',
  runId: 'run-plan-question-1',
  taskId: '1',
  projectId: PROJECT_ID,
  taskTitle: 'Command palette actions for every issue field',
  kind: 'question',
  prompt: 'Should the palette list archived issues as well, or only open ones?',
  options: ['Only open issues', 'Open and archived, archived last'],
  toolName: null,
  reason: null,
  duringPlanning: true,
  createdAt: asked - 5 * 60_000,
};

export const CHANNELS = {};
