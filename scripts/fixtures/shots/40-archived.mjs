/**
 * The Archived view's own milestones and native tickets — see `uiShotsFixture.mjs`'s own
 * header doc for how `CHANNELS` here is merged with every other file under this directory.
 */
import { PROJECT_ID } from '../boardShotsFixture.mjs';
import { DAY, now } from '../shotsFixtureHelpers.mjs';

/**
 * The three archived milestones `archived-light`'s own screen seeds (F14.8 step 4) — named
 * after the mockup's own rows (`v10-21-archived-light.svg`) so the shot reads the same way the
 * mockup does, on the fixture's one ticket project (`boardShotsFixture.mjs`'s `PROJECT_ID`).
 * Sorted newest-archived-first by `archivedViewModel` itself, so listing them in that same
 * order here is only for a human reading this file top to bottom, not load-bearing.
 */
export const ARCHIVED_MILESTONES = [
  {
    id: 'arch-m1',
    projectId: PROJECT_ID,
    name: 'M1 · Work while away',
    description: '',
    dueAt: now - 40 * DAY,
    color: '',
    closed: true,
    archivedAt: now - 10 * DAY,
    createdAt: now - 70 * DAY,
  },
  {
    id: 'arch-phase24',
    projectId: PROJECT_ID,
    name: 'Phase 24 · Native tickets',
    description: '',
    dueAt: now - 55 * DAY,
    color: '',
    closed: true,
    archivedAt: now - 17 * DAY,
    createdAt: now - 85 * DAY,
  },
  {
    id: 'arch-phase19',
    projectId: PROJECT_ID,
    name: 'Phase 19 · Chains',
    description: '',
    dueAt: now - 75 * DAY,
    color: '',
    closed: true,
    archivedAt: now - 45 * DAY,
    createdAt: now - 100 * DAY,
  },
];

/** A minimal native ticket filed under one of `ARCHIVED_MILESTONES` — the same shape
 *  `boardShotsFixture.mjs`'s own (private) `task()` helper builds. */
function archivedMilestoneTicket(over) {
  return {
    id: over.id,
    projectId: PROJECT_ID,
    phase: '',
    title: over.title,
    status: over.status,
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ticketKey: `FX-${over.id}`,
    milestoneId: over.milestoneId,
  };
}

/** Two of the three archived milestones' own tickets, all done but one — the open one is what
 *  makes `arch-phase24`'s row read "done · open" instead of a flat "done", the same way the
 *  mockup's own "41 done · 2 moved to Backlog" is not an all-done row either. */
export const ARCHIVED_MILESTONE_TICKETS = [
  archivedMilestoneTicket({
    id: '101',
    title: 'Ship the weekly digest email',
    status: 'done',
    milestoneId: 'arch-m1',
  }),
  archivedMilestoneTicket({
    id: '102',
    title: 'Queue agent runs while offline',
    status: 'done',
    milestoneId: 'arch-m1',
  }),
  archivedMilestoneTicket({
    id: '103',
    title: 'Reconcile native ticket ids on import',
    status: 'done',
    milestoneId: 'arch-phase24',
  }),
  archivedMilestoneTicket({
    id: '104',
    title: 'Backfill ticket numbers for pre-F24 rows',
    status: 'pending',
    milestoneId: 'arch-phase24',
  }),
  archivedMilestoneTicket({
    id: '105',
    title: 'Release the chain-link gate picker',
    status: 'done',
    milestoneId: 'arch-phase19',
  }),
];

export const CHANNELS = {
  // `ArchivedPane.tsx` and `useSidebarData.ts`'s own count both read this unscoped — an
  // `ArchivedListing`, not the bare `[]` the `'list'` fallback would answer with (that shape
  // mismatch is exactly the gap this step's plan calls out: an unlisted channel reads as an
  // empty listing instead of failing loudly).
  'archive:list': { projects: [], milestones: ARCHIVED_MILESTONES, epics: [] },
  // Joined in file order with `10-shell.mjs`'s own contribution (`milestone:list` ends up
  // `[...ARCHIVED_MILESTONES, ...MILESTONES]` — the sidebar's tree-visible ones come LAST,
  // the one order difference from before this split; see `uiShotsFixture.mjs`'s own header
  // doc on why that is harmless).
  'milestone:list': [...ARCHIVED_MILESTONES],
  // Joined in file order with `10-shell.mjs`'s `TASKS` and `50-sidebar.mjs`'s own
  // `SIDEBAR_TICKETS` — `archived-light` (and any other screen that reaches `board:tasks`)
  // needs to resolve these by id.
  'board:tasks': [...ARCHIVED_MILESTONE_TICKETS],
};
