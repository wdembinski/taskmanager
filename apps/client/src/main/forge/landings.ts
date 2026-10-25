/**
 * Which merged pull requests a GitHub sync lands, and which cards are still waiting on a
 * merge nobody has told us about — both pure, so the whole decision is testable without the
 * `registerIpc` closure that acts on it.
 *
 * The bug both exist for: a merged PR used to land on exactly ONE sync, the first that read
 * it as merged, because only `upserts` were looked at and a settled row stops being upserted.
 * A row with no card at that moment — filed later by a re-match, a link, or a board change —
 * never landed, and neither did a PR the open search never saw at all. On the VPN board that
 * left cards In Progress with their successors waiting until somebody wrote `landedAt` into
 * the database by hand.
 */
import { restingStatus } from '@shared/board';
import type { MergeRequest } from '@shared/mergeRequest';
import type { Task } from '@shared/model';
import { taskBranch } from '../worktreeManager';

/** One card to land, and the merged row that says so. */
export interface Landing {
  taskId: string;
  mr: MergeRequest;
}

/**
 * The cards this sync lands, one entry per card.
 *
 *  - **Every merged row in `upserts`**, as before — whether or not its card already landed,
 *    because the landing is idempotent and the move to Done is re-asked on every merged
 *    report (a card whose second PR merges later still gets moved).
 *  - **Every stored merged GitHub row whose card exists and has not landed.** This is the
 *    half that was missing: it catches a row filed under its card after the sync that first
 *    read it as merged. A card that already has `landedAt` is left alone, so a retained row
 *    does not re-land its card on every poll forever.
 *
 * `stored` is read AFTER the sync's own writes, so a row this very sync re-filed counts.
 */
export function mergedRowsToLand(
  upserts: readonly MergeRequest[],
  stored: readonly MergeRequest[],
  getTask: (id: string) => Task | undefined,
): Landing[] {
  const landings: Landing[] = [];
  const seen = new Set<string>();
  for (const mr of upserts) {
    if (mr.state !== 'merged' || !mr.taskId || seen.has(mr.taskId)) continue;
    seen.add(mr.taskId);
    landings.push({ taskId: mr.taskId, mr });
  }
  for (const mr of stored) {
    if (mr.provider !== 'github' || mr.state !== 'merged' || !mr.taskId) continue;
    if (seen.has(mr.taskId)) continue;
    const task = getTask(mr.taskId);
    if (!task || task.landedAt != null) continue;
    seen.add(mr.taskId);
    landings.push({ taskId: mr.taskId, mr });
  }
  return landings;
}

/** How far back the merged-PR search may reach, however old the oldest candidate is. */
export const MERGED_SEARCH_MAX_DAYS = 30;

/** The cards worth one merged-PR search, by branch, and the date to search from. */
export interface BranchCandidates {
  /** Source branch → the card it belongs to. */
  byBranch: Map<string, string>;
  /** `YYYY-MM-DD` for `merged:>=`, or null when there is no candidate and no search. */
  since: string | null;
}

/**
 * Cards whose PR may have merged without the app ever seeing it.
 *
 * A candidate is a top-level, non-archived card that has worked (`workedAt`), has not landed,
 * is not resting in Done or Cancelled, and whose branch no stored GitHub row explains — no
 * row at all has that `sourceBranch`. Every one of those conditions is what makes the search
 * cheap to keep asking: a card with a row is the normal sync's job, and a finished or landed
 * card is waiting on nothing. Two cards on one branch say nothing about either, so the
 * branch is dropped, as `buildBoardIndex` drops it.
 *
 * `since` is the oldest candidate's `workedAt` day — its PR cannot have merged before the
 * work began — capped at {@link MERGED_SEARCH_MAX_DAYS} so one stale card cannot widen the
 * search forever.
 */
export function unlandedBranchCandidates(
  tasks: readonly Task[],
  storedGithubRows: readonly MergeRequest[],
  now: number,
): BranchCandidates {
  const explained = new Set(storedGithubRows.map((mr) => mr.sourceBranch));
  const byBranch = new Map<string, string>();
  const ambiguous = new Set<string>();
  let oldest: number | null = null;
  const workedAtById = new Map<string, number>();
  for (const task of tasks) {
    if (task.parentTaskId || task.archivedAt != null) continue;
    if (task.landedAt != null || task.workedAt == null) continue;
    const resting = restingStatus(task);
    if (resting === 'done' || resting === 'cancelled') continue;
    const branch = task.agentBranch?.trim() || taskBranch(task.id);
    if (explained.has(branch) || ambiguous.has(branch)) continue;
    if (byBranch.has(branch)) {
      byBranch.delete(branch);
      ambiguous.add(branch);
      continue;
    }
    byBranch.set(branch, task.id);
    workedAtById.set(task.id, task.workedAt);
  }
  for (const id of byBranch.values()) {
    const at = workedAtById.get(id)!;
    if (oldest === null || at < oldest) oldest = at;
  }
  if (oldest === null) return { byBranch, since: null };
  const floor = now - MERGED_SEARCH_MAX_DAYS * 24 * 60 * 60 * 1000;
  return { byBranch, since: new Date(Math.max(oldest, floor)).toISOString().slice(0, 10) };
}
