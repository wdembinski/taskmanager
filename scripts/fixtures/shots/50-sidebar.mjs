/**
 * The sidebar tree's own "owner's shape" fixture — see `uiShotsFixture.mjs`'s own header doc
 * for how `CHANNELS` here is merged with every other file under this directory.
 */
import { PROJECT_ID } from '../boardShotsFixture.mjs';
import { DAY, now, sidebarMilestone, sidebarTicket } from '../shotsFixtureHelpers.mjs';

/**
 * The sidebar tree's own "owner's shape" (`sidebarModel.test.ts`'s own describe block, mirrored
 * here): a fully-done milestone that folds by default, a mixed milestone with both open and
 * finished tickets (plus a step under one of them, proving steps never reach the tree, and an
 * epic whose own tickets are all done, proving an epic group folds on its own even while its
 * milestone still has open work) and a running ticket (proving the brand-coloured glyph), a
 * milestone with only open work (plus a needs-input ticket, proving the colour cue), and a
 * milestone whose only content is a fully-done epic (proving "no open work" folds a milestone
 * even when nothing but an epic group drives that, with no loose tickets of its own).
 */
const shippedMilestone = sidebarMilestone({
  id: 'ms-shipped',
  name: 'Nordic rollout',
  createdAt: now - 3 * DAY,
});
const mixedMilestone = sidebarMilestone({
  id: 'ms-mixed',
  name: 'Reach the mobile build',
  createdAt: now - 2 * DAY,
});
const pendingMilestone = sidebarMilestone({
  id: 'ms-pending',
  name: 'Early access',
  createdAt: now - DAY,
});
const epicDoneMilestone = sidebarMilestone({
  id: 'ms-epic-done',
  name: 'Platform hardening',
  createdAt: now - 4 * DAY,
});
export const MILESTONES = [shippedMilestone, mixedMilestone, pendingMilestone, epicDoneMilestone];

const sidebarShippedTicket = sidebarTicket({
  id: 'sb-1',
  title: 'Ship the Nordic locale pack',
  // An owner for the board's initials circle (`boardShotsFixture.mjs`'s `PEOPLE`) — no epic,
  // which would regroup this tree.
  assigneeId: 'person-ola',
  status: 'done',
  milestoneId: shippedMilestone.id,
});
const sidebarMixedPending = sidebarTicket({
  id: 'sb-2',
  title: 'Wire the mobile build pipeline',
  assigneeId: 'person-marek',
  status: 'pending',
  milestoneId: mixedMilestone.id,
});
const sidebarMixedDone = sidebarTicket({
  id: 'sb-3',
  title: 'Audit the mobile bundle size',
  assigneeId: 'person-ania',
  status: 'done',
  milestoneId: mixedMilestone.id,
});
const sidebarMixedRunning = sidebarTicket({
  id: 'sb-4',
  title: 'Localize the onboarding tour',
  status: 'running',
  agentProjectId: PROJECT_ID,
  workedAt: now - 2 * 60_000,
  milestoneId: mixedMilestone.id,
});
const sidebarMixedStep = sidebarTicket({
  id: 'sb-2-s1',
  title: 'Draft the pipeline config',
  status: 'done',
  parentTaskId: sidebarMixedPending.id,
  milestoneId: null,
});
const sidebarMixedEpic = sidebarTicket({
  id: 'sb-7',
  title: 'Nordic theming epic',
  status: 'in-review',
  issueType: 'epic',
  milestoneId: mixedMilestone.id,
});
const sidebarMixedEpicChildA = sidebarTicket({
  id: 'sb-7-a',
  title: 'Ship the dark palette',
  assigneeId: 'person-marek',
  status: 'done',
  epicTaskId: sidebarMixedEpic.id,
  milestoneId: mixedMilestone.id,
});
const sidebarMixedEpicChildB = sidebarTicket({
  id: 'sb-7-b',
  title: 'Retire the legacy tokens',
  assigneeId: 'person-ania',
  status: 'done',
  epicTaskId: sidebarMixedEpic.id,
  milestoneId: mixedMilestone.id,
});
const sidebarPendingA = sidebarTicket({
  id: 'sb-5',
  title: 'Draft the early-access invite flow',
  assigneeId: 'person-ola',
  status: 'pending',
  milestoneId: pendingMilestone.id,
});
const sidebarPendingB = sidebarTicket({
  id: 'sb-6',
  title: 'Spec the invite quota limits',
  assigneeId: 'person-human',
  status: 'pending',
  milestoneId: pendingMilestone.id,
});
const sidebarPendingNeedsInput = sidebarTicket({
  id: 'sb-9',
  title: 'Resolve the invite-quota ambiguity',
  status: 'waiting-input',
  agentProjectId: PROJECT_ID,
  workedAt: now - 10 * 60_000,
  milestoneId: pendingMilestone.id,
});
const sidebarEpicDoneEpic = sidebarTicket({
  id: 'sb-8',
  title: 'Harden the sync protocol',
  status: 'done',
  issueType: 'epic',
  milestoneId: epicDoneMilestone.id,
});
const sidebarEpicDoneChildA = sidebarTicket({
  id: 'sb-8-a',
  title: 'Encrypt the sync payload',
  status: 'done',
  epicTaskId: sidebarEpicDoneEpic.id,
  milestoneId: epicDoneMilestone.id,
});
const sidebarEpicDoneChildB = sidebarTicket({
  id: 'sb-8-b',
  title: 'Rotate the sync keys automatically',
  status: 'done',
  epicTaskId: sidebarEpicDoneEpic.id,
  milestoneId: epicDoneMilestone.id,
});

export const SIDEBAR_TICKETS = [
  sidebarShippedTicket,
  sidebarMixedPending,
  sidebarMixedDone,
  sidebarMixedRunning,
  sidebarMixedStep,
  sidebarMixedEpic,
  sidebarMixedEpicChildA,
  sidebarMixedEpicChildB,
  sidebarPendingA,
  sidebarPendingB,
  sidebarPendingNeedsInput,
  sidebarEpicDoneEpic,
  sidebarEpicDoneChildA,
  sidebarEpicDoneChildB,
];

export const CHANNELS = {
  // Joined in file order with `40-archived.mjs`'s own contribution — see that file's own
  // comment on `milestone:list` for the one order difference from before this split.
  'milestone:list': [...MILESTONES],
  // Joined in file order with `10-shell.mjs`'s `TASKS` and `40-archived.mjs`'s own
  // `ARCHIVED_MILESTONE_TICKETS`.
  'board:tasks': [...SIDEBAR_TICKETS],
};
