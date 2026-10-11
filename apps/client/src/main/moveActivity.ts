/**
 * F2.8 — a human moving a card's column is itself an activity-log row, same as a run
 * starting or finishing. This is the pure half: the row a move produces, and the small
 * wrapper that records it without letting a logging failure undo the move it describes.
 */
import type { ActivityRow } from '@shared/activity';
import type { Task, TaskStatus } from '@shared/model';

/**
 * The row a human's column move writes, or `null` when nothing moved — the handlers'
 * existing noop early-returns (`move.noop`, `from === status`) already cover that case
 * before this is ever called, so `null` here is a second, cheap guarantee rather than the
 * first line of defense.
 */
export function toMoveActivity(
  task: Task,
  from: TaskStatus,
  to: TaskStatus,
  at = Date.now(),
): Omit<ActivityRow, 'id'> | null {
  if (from === to) return null;
  return {
    at,
    projectId: task.projectId ?? null,
    taskId: task.id,
    runId: null,
    kind: 'status-moved',
    outcome: null,
    origin: 'human',
    title: task.title,
    costUsd: null,
    detail: { from, to },
  };
}

/**
 * Run the forge transition + local write, then record the move. `transition` throwing (the
 * forge refused, so the UI rolls back) propagates straight through and `record` never runs
 * — there is nothing to log yet. `record` throwing is logged and swallowed instead: the move
 * itself already succeeded, and a lost activity-log row must never turn into a failed move.
 */
export async function transitionThenRecord<T>(
  transition: () => Promise<T>,
  record: (result: T) => void,
  log: (msg: string, e: unknown) => void,
): Promise<T> {
  const result = await transition();
  try {
    record(result);
  } catch (e) {
    log('Failed to record a card move to the activity log', e);
  }
  return result;
}
