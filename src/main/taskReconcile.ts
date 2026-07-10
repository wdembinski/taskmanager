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

// Statuses whose task must NEVER be dropped by a plan re-sync even if its line was
// edited away: the AI-live states (running / waiting-input / blocked-by-limit) —
// dropping one orphans live work — plus the human-active to-do states in-progress /
// blocked (Phase 9), so re-syncing doesn't discard work someone is mid-way on.
const KEEP_ON_SYNC: ReadonlySet<string> = new Set([
  'running',
  'waiting-input',
  'blocked-by-limit',
  'in-progress',
  'blocked',
]);

/**
 * Merge a freshly parsed plan into a project's tasks (Phase 8 rules).
 *
 * Only `source: 'plan'` tasks are governed by the plan:
 *   - parsed items matched to an existing plan task by (phase, title) keep their
 *     id, live `status`, and `sessionId`;
 *   - unmatched parsed items become new plan tasks (`[x]` → `done`, else `pending`);
 *   - existing plan tasks that vanished from the plan are dropped — UNLESS they are
 *     mid-flight or human-active (see `KEEP_ON_SYNC`), which are kept so editing the
 *     plan during a run — or on a task someone is working — can't destroy that work.
 *
 * `source: 'adhoc'` tasks (created in the app) are never plan-managed and are always
 * preserved. Kept-but-unplanned tasks are appended after the plan tasks. `order` is
 * renumbered to the final array position. `newId` is injectable for deterministic tests.
 */
export function reconcileTasks(
  projectId: string,
  existing: Task[],
  parsed: ParsedTask[],
  newId: () => string = randomUUID,
): Task[] {
  // Index only PLAN tasks by identity, so each is matched to a parsed line at most once.
  const byKey = new Map<string, Task>();
  for (const task of existing) {
    if (task.source === 'plan') byKey.set(identity(task.phase, task.title), task);
  }

  const planTasks: Task[] = parsed.map((p) => {
    const key = identity(p.phase, p.title);
    const prior = byKey.get(key);
    byKey.delete(key); // consume, so duplicate plan lines don't both match it
    // Dependencies are re-derived from the plan on every sync, so a matched task
    // picks up edits to its `@needs:` clause (identity is the stripped title).
    if (prior) return { ...prior, source: 'plan', dependsOn: p.needs };
    return {
      id: newId(),
      projectId,
      phase: p.phase,
      title: p.title,
      status: p.done ? 'done' : 'pending',
      sessionId: null,
      order: 0, // renumbered below
      source: 'plan',
      dependsOn: p.needs,
    };
  });

  // Plan tasks that disappeared from the plan: keep the ones still in flight or
  // being actively worked (KEEP_ON_SYNC); drop the rest.
  const keptOrphans = [...byKey.values()].filter((t) => KEEP_ON_SYNC.has(t.status));
  // Ad-hoc tasks are outside the plan's control — always keep them.
  const adhoc = existing.filter((t) => t.source === 'adhoc');

  return [...planTasks, ...keptOrphans, ...adhoc].map((task, order) => ({ ...task, order }));
}
