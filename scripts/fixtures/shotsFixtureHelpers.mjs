/**
 * Building blocks shared by the per-feature fixture files under `scripts/fixtures/shots/` —
 * kept outside that directory (`scripts/lib/shotModules.mjs`'s `listModuleFiles` only reads
 * `scripts/fixtures/shots/` itself) so this is never mistaken for a feature's own `CHANNELS`
 * module.
 */
import { PROJECT_ID } from './boardShotsFixture.mjs';

export const now = Date.UTC(2026, 0, 15, 12, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;

/** A milestone-tracker ticket, the same minimal `Task` fields `boardShotsFixture.mjs`'s own
 *  private `task()` helper settles on (not reused directly — it is not exported). */
export function sidebarTicket(over) {
  return {
    id: over.id,
    projectId: PROJECT_ID,
    phase: '',
    title: over.title ?? 'Untitled',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ticketKey: `FX-${over.id}`,
    ...over,
  };
}

/** A milestone fixture, the same minimal `Milestone` fields `sidebarModel.test.ts`'s own
 *  `milestone()` helper settles on. */
export function sidebarMilestone(over) {
  return {
    id: over.id,
    projectId: PROJECT_ID,
    name: over.name,
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    archivedAt: null,
    createdAt: now,
    ...over,
  };
}
