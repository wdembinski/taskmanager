/**
 * Pure merge for a task's activity timeline (Phase 9).
 *
 * A task's timeline is assembled from two stores — human `task_activity` rows
 * (comments + status changes) and the AI `task_events` transcript — which the
 * store maps to `TaskActivityEntry` values. This function interleaves them into a
 * single chronological list. Kept dependency-free (no better-sqlite3) so it can be
 * unit-tested under Vitest's Node.
 */
import type { TaskActivityEntry } from '@shared/model';

// Deterministic tiebreak when two entries share a timestamp: status → comment →
// event, then by id (ids are comparable within one source table).
const KIND_ORDER: Record<TaskActivityEntry['kind'], number> = { status: 0, comment: 1, event: 2 };

/** Sort mixed activity entries oldest-first, with a stable, deterministic tiebreak. */
export function mergeActivity(entries: TaskActivityEntry[]): TaskActivityEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.createdAt - b.createdAt || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id,
  );
}
