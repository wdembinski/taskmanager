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

// Deterministic tiebreak when two entries share a timestamp: status → comment → chat →
// jira-comment → event, then by id. JIRA ids are strings, the rest numbers, so we
// compare stringified with numeric collation (only reached within one kind anyway).
// `chat` sits directly before `event`-once-removed on purpose: a message to the agent is
// written just before the send, so on a same-millisecond tie it must precede the
// transcript events that message caused.
const KIND_ORDER: Record<TaskActivityEntry['kind'], number> = {
  status: 0,
  comment: 1,
  chat: 2,
  'jira-comment': 3,
  event: 4,
};

/** Sort mixed activity entries oldest-first, with a stable, deterministic tiebreak. */
export function mergeActivity(entries: TaskActivityEntry[]): TaskActivityEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );
}
