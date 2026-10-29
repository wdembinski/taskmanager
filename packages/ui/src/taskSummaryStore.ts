/**
 * How a list of card summaries takes a change (F29.2) — the pure half every task listener
 * shares, so a board, the issue list and the sidebar all merge a `tasks:changed` delta and a
 * `task:changed` row the same way. No React here, the split `taskDetailHost.ts` already uses.
 *
 * Both functions return the SAME array reference when nothing changed, so a `useState`
 * setter handed their result skips the re-render on its own.
 */
import { toTaskSummary, type TaskDelta, type TaskSummary } from '@tm/shared/taskSummary';

/**
 * A list's scope: one board's project id, or `'all'` for the union of every board — the
 * same rule `board:tasks` takes.
 */
export type TaskListScope = string;

/**
 * Merge one board's delta into a list. A delta for a board the list does not show is
 * ignored; on the `'all'` scope every delta applies. Upserted cards replace the row with
 * their id in place, or are appended when the list has none; removed ids are dropped.
 */
export function applyTaskDelta(
  list: TaskSummary[],
  delta: TaskDelta,
  scope: TaskListScope,
): TaskSummary[] {
  if (scope !== 'all' && scope !== delta.projectId) return list;
  if (delta.upserted.length === 0 && delta.removed.length === 0) return list;

  const removed = new Set(delta.removed);
  const upserts = new Map(delta.upserted.map((t) => [t.id, toTaskSummary(t)]));
  let changed = false;
  const next: TaskSummary[] = [];
  for (const row of list) {
    if (removed.has(row.id)) {
      changed = true;
      continue;
    }
    const upsert = upserts.get(row.id);
    if (upsert) {
      upserts.delete(row.id);
      if (!sameSummary(row, upsert)) {
        next.push(upsert);
        changed = true;
        continue;
      }
    }
    next.push(row);
  }
  for (const upsert of upserts.values()) {
    if (removed.has(upsert.id)) continue;
    next.push(upsert);
    changed = true;
  }
  return changed ? next : list;
}

/**
 * Patch one card a list already holds — what a `task:changed` row does to a list. A card
 * the list does not hold is ignored: which board a card is on is the delta's business.
 */
export function patchTaskSummary(list: TaskSummary[], task: TaskSummary): TaskSummary[] {
  const index = list.findIndex((row) => row.id === task.id);
  if (index < 0) return list;
  const summary = toTaskSummary(task);
  if (sameSummary(list[index]!, summary)) return list;
  const next = list.slice();
  next[index] = summary;
  return next;
}

/** Shallow equality over summary fields, with the array fields compared by element. */
function sameSummary(a: TaskSummary, b: TaskSummary): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = (a as Record<string, unknown>)[key];
    const y = (b as Record<string, unknown>)[key];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * The legacy `project:tasksChanged` (one board's WHOLE list) as the delta it amounts to
 * against `list`: every card of that board upserted, and every card `list` holds for that
 * board but the new list lacks, removed. Temporary — `useTaskSummaries` reads it only until
 * the main process sends `tasks:changed` itself (F29.2 step 3).
 */
export function deltaFromBoardList(
  list: readonly TaskSummary[],
  projectId: string,
  tasks: readonly TaskSummary[],
): TaskDelta {
  const kept = new Set(tasks.map((t) => t.id));
  return {
    projectId,
    upserted: tasks.map(toTaskSummary),
    removed: list.filter((t) => t.projectId === projectId && !kept.has(t.id)).map((t) => t.id),
  };
}
