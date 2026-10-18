/**
 * Which ticket project the sidebar's `team` tree shows (F13.17) — until now it was always
 * whichever ticket project `.find(ownsTickets)` hit first, i.e. the OLDEST one, regardless of
 * where any actual open work was. This module is the pure decision behind the replacement:
 * {@link resolveSidebarProject} picks the ticket project with the most open tickets, honouring
 * a device's own remembered choice when that choice still points at a live ticket project.
 * {@link openTicketCounts} is the tally it picks from; {@link parseRememberedProject} /
 * {@link serializeRememberedProject} are the `localStorage` codec for the remembered id, the
 * same single-purpose pair `sidebarFolds.ts` keeps for folds.
 */
import type { Project, Task } from '@tm/shared/model';
import { ownsTickets } from '@tm/shared/model';
import { isOpenTicketStatus } from '@tm/shared/tickets';

/** Every project's open-ticket count, keyed by `projectId` — a closed ticket
 *  (`isOpenTicketStatus`) or one archived off its tracker (`trackerArchivedAt`) counts for
 *  neither its own project nor any other, same as the archive sweep's own open-ticket test. */
export function openTicketCounts(
  tasks: readonly Pick<Task, 'projectId' | 'status' | 'trackerArchivedAt'>[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!isOpenTicketStatus(task.status) || task.trackerArchivedAt != null) continue;
    counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  }
  return counts;
}

export interface ResolveSidebarProjectArgs {
  /** Every project this machine knows about — narrowed below to the ones a `team` tree can
   *  even show. */
  projects: readonly Pick<Project, 'id' | 'ticketPrefix' | 'archivedAt'>[];
  /** {@link openTicketCounts}'s tally — a project with no entry reads as zero. */
  openCounts: ReadonlyMap<string, number>;
  /** This device's last choice (`parseRememberedProject`), or `null` for "never chosen". */
  rememberedId: string | null;
}

/**
 * The ticket project the sidebar's `team` tree should show.
 *
 * Candidates are `projects.filter(ownsTickets)` that are not archived — a Personal/agent
 * project (`ticketPrefix ''`) or an archived ticket project is never a candidate, remembered
 * or not. `rememberedId` wins outright when it names a live candidate, even an empty one — a
 * human who deliberately switched to a quiet project should not be bounced out of it the
 * moment its count stops leading. Otherwise the candidate with the most open tickets wins;
 * ties go to the earlier candidate, i.e. whichever sorts first in `projects`. `null` when
 * there are no candidates at all.
 */
export function resolveSidebarProject({
  projects,
  openCounts,
  rememberedId,
}: ResolveSidebarProjectArgs): string | null {
  const candidates = projects.filter(
    (project) => ownsTickets(project) && project.archivedAt == null,
  );
  if (candidates.length === 0) return null;

  if (rememberedId != null && candidates.some((project) => project.id === rememberedId)) {
    return rememberedId;
  }

  let best = candidates[0];
  let bestCount = openCounts.get(best.id) ?? 0;
  for (const candidate of candidates.slice(1)) {
    const count = openCounts.get(candidate.id) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best.id;
}

/** `raw`'s remembered project id — `null` for anything that is not a JSON-encoded string,
 *  including a never-written key, invalid JSON, a non-string value, or an empty string. */
export function parseRememberedProject(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' && parsed !== '' ? parsed : null;
  } catch {
    return null;
  }
}

/** The inverse of {@link parseRememberedProject} — plain JSON, so the two round-trip through
 *  `localStorage` without the codec needing to agree on anything fancier than that. */
export function serializeRememberedProject(id: string): string {
  return JSON.stringify(id);
}
