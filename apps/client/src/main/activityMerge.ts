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

// Deterministic tiebreak when two entries share a timestamp: status → status-note →
// comment → chat → ticket comment → event, then by id. Tracker ids are strings, the rest
// numbers, so we compare stringified with numeric collation (only reached within one
// kind anyway). `chat` sits directly before `event` on purpose: a message to the agent
// is written just before the send, so on a same-millisecond tie it must precede the
// transcript events that message caused. `status-note` follows `status` because moving
// a card and then saying why is the order those two are written in.
//
// `github-comment` shares `jira-comment`'s weight rather than taking one after it: a card is
// linked to ONE tracker, so the two kinds never meet on the same timeline and any order
// between them would be a rule about a case that cannot arise. What they must agree on is
// where a ticket comment sits relative to everything else, and that is what sharing says.
const KIND_ORDER: Record<TaskActivityEntry['kind'], number> = {
  status: 0,
  'status-note': 1,
  comment: 2,
  chat: 3,
  'jira-comment': 4,
  'github-comment': 4,
  event: 5,
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
