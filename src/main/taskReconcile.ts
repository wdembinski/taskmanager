/**
 * Pure reconciliation: merge a freshly parsed plan into the tasks a project
 * already tracks, without clobbering live status.
 *
 * Kept in its own module (no better-sqlite3 import) so it can be unit-tested
 * under Vitest's Node — the native database binary is built for Electron's ABI
 * and won't load there.
 */
import { randomUUID } from 'node:crypto';
import type { Task } from '@shared/model';
import type { ParsedTask } from './planParser';

// Identity key for matching an existing task to a parsed one: the (phase, title)
// pair. We JSON-stringify the pair so the two fields can't run together into a
// false match (a plain-space join would let "P1" + " a" collide with "P1 " + "a").
const identity = (phase: string, title: string): string => JSON.stringify([phase, title]);

/**
 * Existing tasks are matched to parsed ones by (phase, title). A match keeps its
 * id, live `status`, and `sessionId` — only its `order` is refreshed. Parsed
 * tasks with no match are created (`done` in the plan → `done`, else `pending`).
 * Existing tasks that no longer appear in the plan are dropped from the result.
 *
 * Returns the desired full task list in plan order. `newId` is injectable so
 * tests get deterministic ids.
 */
export function reconcileTasks(
  projectId: string,
  existing: Task[],
  parsed: ParsedTask[],
  newId: () => string = randomUUID,
): Task[] {
  // Index existing tasks by their identity so each is matched at most once.
  const byKey = new Map<string, Task>();
  for (const task of existing) byKey.set(identity(task.phase, task.title), task);

  return parsed.map((p, order) => {
    const key = identity(p.phase, p.title);
    const prior = byKey.get(key);
    byKey.delete(key); // consume, so duplicate plan lines don't both match it
    if (prior) {
      return { ...prior, order };
    }
    return {
      id: newId(),
      projectId,
      phase: p.phase,
      title: p.title,
      status: p.done ? 'done' : 'pending',
      sessionId: null,
      order,
    };
  });
}
