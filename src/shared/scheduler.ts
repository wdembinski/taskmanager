/**
 * Shared scheduler vocabulary (Phase 3).
 *
 * The scheduler turns a project's static task list into a running queue: it picks
 * the next `pending` task, runs it as one Claude session, and moves it through
 * `running` → `done`/`failed`. These types describe the two things the engine
 * pushes to the UI so the Board can update live without polling:
 *
 *   - `task:changed`      — a single task's status/sessionId changed (and, while a
 *                           task is executing, the live `runId` to attach a
 *                           transcript to).
 *   - `scheduler:changed` — a project's queue moved between running/paused/idle,
 *                           so the Run/Pause/Stop buttons reflect reality.
 *
 * They live in `shared` because both the engine and the UI depend on them.
 */
import type { Task } from './model';

/**
 * Whether a project's queue is actively working (`running`), temporarily halted
 * but keeping any in-flight task alive (`paused`), or not scheduling at all
 * (`idle` — nothing running and nothing queued, or fully stopped).
 */
export type SchedulerState = 'idle' | 'running' | 'paused';

/** Pushed when a project's scheduler state changes, so the Board updates buttons. */
export interface SchedulerChange {
  projectId: string;
  state: SchedulerState;
}

/**
 * Pushed whenever a task's persisted state changes. `runId` is the live run id
 * while the task is executing (so the UI can wire the Phase 1 transcript to it),
 * and `null` once the task has settled or is not currently running.
 */
export interface TaskChange {
  task: Task;
  runId: string | null;
}

/** Maps a currently-running task id to its live run id (seed for the Board on load). */
export interface ActiveRun {
  taskId: string;
  runId: string;
}
