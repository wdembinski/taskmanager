/**
 * The F14.10 sweep: runs `dueForAutoArchive` (`@shared/autoArchive`) against the live store
 * and actually archives whatever it names, at boot and once an hour after.
 *
 * All six reads/writes come in as `AutoArchiveSweepDeps` rather than a bound `Store` — the
 * same discipline `repoSkillsRefresher.ts` and `assignmentPoller.ts` keep — so a test drives
 * this over plain fakes with no SQLite underneath it. `listMilestones` is handed in already
 * narrowed to the live ticket projects the caller cares about (`ipc.ts`'s own
 * `milestonesAcrossTicketProjects`, with archived projects skipped): this module has no
 * project list of its own to filter.
 *
 * `archiveMilestone` is always called with `{ kind: 'backlog' }` — the sweep only ever
 * archives a milestone whose tickets are ALL closed already (`dueForAutoArchive`'s own
 * guarantee), so there is never an open ticket for any other choice to do something
 * different with.
 */
import { dueForAutoArchive, type AutoArchivableTicket } from '@shared/autoArchive';
import type { ActivityRow } from '@shared/activity';
import type { Milestone } from '@shared/model';
import type { ArchiveResult, OpenTicketsChoice } from '@shared/trackerArchive';

export interface AutoArchiveSweepDeps {
  /** The one knob (`AppSettings.ticketAutoArchiveWeeks`) — read fresh on every run. */
  getSettings: () => { ticketAutoArchiveWeeks: number | null };
  /** Every milestone from a live ticket project — the caller's own scope, not this file's. */
  listMilestones: () => Milestone[];
  /** `Store.listMilestoneTickets` — every native ticket on any milestone. */
  listMilestoneTickets: () => AutoArchivableTicket[];
  /** `Store.ticketDoneTimes` — the newest close per ticket, from the activity log. */
  ticketDoneTimes: () => ReadonlyMap<string, number>;
  archiveMilestone: (id: string, choice: OpenTicketsChoice, at: number) => ArchiveResult;
  appendActivity: (row: Omit<ActivityRow, 'id'>) => ActivityRow | null;
  /** Pushed once, after the loop, only when something actually archived. */
  onMilestonesChanged: () => void;
  log: (message: string, err?: unknown) => void;
}

/**
 * One pass: find what is due, archive each, record it, and push once if anything moved.
 *
 * Whole body try/caught — a boot sweep that throws must never take the rest of boot down
 * with it. A single milestone's refusal (an archive-project race, say) is logged and
 * skipped rather than stopping the pass; a failed activity-log write for one milestone is
 * logged and swallowed the same way `transitionThenRecord` (`moveActivity.ts`) already
 * swallows one, and does not stop the next milestone from archiving.
 *
 * Returns the ids actually archived, in `dueForAutoArchive`'s own order.
 */
export function runAutoArchiveSweep(deps: AutoArchiveSweepDeps, now: number): string[] {
  try {
    const milestones = deps.listMilestones();
    const dueIds = dueForAutoArchive(
      milestones,
      deps.listMilestoneTickets(),
      deps.ticketDoneTimes(),
      now,
      deps.getSettings().ticketAutoArchiveWeeks,
    );
    if (dueIds.length === 0) return [];

    const milestonesById = new Map(milestones.map((m) => [m.id, m]));
    const archivedIds: string[] = [];
    for (const id of dueIds) {
      const result = deps.archiveMilestone(id, { kind: 'backlog' }, now);
      if (!result.ok) {
        deps.log(`Auto-archive sweep: milestone ${id} refused — ${result.message}`);
        continue;
      }
      archivedIds.push(id);

      const milestone = milestonesById.get(id);
      try {
        deps.appendActivity({
          at: now,
          projectId: result.projectId,
          taskId: null,
          runId: null,
          kind: 'milestone-archived',
          outcome: null,
          origin: null,
          title: milestone?.name ?? '',
          costUsd: null,
          detail: { reason: 'auto', milestoneId: id },
        });
      } catch (e) {
        deps.log('Auto-archive sweep: failed to record a milestone archive', e);
      }
    }

    if (archivedIds.length > 0) deps.onMilestonesChanged();
    return archivedIds;
  } catch (e) {
    deps.log('Auto-archive sweep failed', e);
    return [];
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Runs the sweep once immediately, then every hour — `unref`'d, so an idle app can still
 * exit on its own rather than this timer holding the process open. Returns a stop function
 * for the caller's own shutdown path.
 */
export function startAutoArchiveSweep(deps: AutoArchiveSweepDeps): () => void {
  runAutoArchiveSweep(deps, Date.now());
  const timer = setInterval(() => runAutoArchiveSweep(deps, Date.now()), HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
