/**
 * Shared domain model — the app's durable vocabulary for PROJECTS and TASKS.
 *
 * Phase 1 only knew about ephemeral "runs" (one prompt, streamed, forgotten).
 * Phase 2 introduces persistence: the app remembers a set of projects, and each
 * project's `plan.md` is parsed into an ordered list of tasks the scheduler will
 * later work through. These types are the shape of that stored state and cross
 * the UI↔engine boundary, so they live in `shared`.
 *
 * They intentionally reuse `ClaudeModel` and `PermissionMode` from `session.ts`
 * (a project's defaults become a task's `StartSessionRequest` when it runs).
 */
import type { ClaudeModel, PermissionMode } from './session';

/**
 * Lifecycle of a single task, mirroring the state machine in
 * `docs/03-how-orchestration-works.md`:
 *
 *   pending ─► running ─► done
 *                │ │
 *                │ └─ needs a human answer ─► waiting-input ─► running
 *                │ └─ usage limit hit ─────► blocked-by-limit ─► running
 *                └─ unrecoverable error ───► failed
 *
 * `stopped` is a user-initiated halt. Only `pending`/`done`/`failed`/`stopped`
 * are stable resting states; the other three mean a session is mid-flight.
 */
export type TaskStatus =
  'pending' | 'running' | 'waiting-input' | 'blocked-by-limit' | 'done' | 'failed' | 'stopped';

/** A project the app orchestrates: a directory plus the plan that drives it. */
export interface Project {
  /** Stable app-assigned id (UUID). Not derived from the path, so a project can
   *  be moved on disk without losing its tasks' history. */
  id: string;
  /** Display name (defaults to the folder name; user-editable). */
  name: string;
  /** Absolute path to the project directory — Claude's working directory. */
  path: string;
  /** Absolute path to the plan file we parse into tasks (usually `<path>/plan.md`). */
  planPath: string;
  /** Which model this project's tasks run with unless overridden. */
  defaultModel: ClaudeModel;
  /** Permission mode this project's tasks run with unless overridden. */
  defaultPermissionMode: PermissionMode;
  /**
   * When true, the scheduler ticks the matching `- [ ]` back to `- [x]` in the
   * project's plan file as each task completes. Off by default so we never touch
   * the user's file unless they opt in. Only the single completed checkbox is
   * flipped — unrelated edits are left untouched.
   */
  writeBackPlan: boolean;
  /** Epoch ms when the project was added. */
  createdAt: number;
}

/**
 * What the UI sends to add a project. Only `path` is required; the engine fills
 * sensible defaults (name = folder name, plan = `<path>/plan.md`, etc.).
 */
export interface AddProjectInput {
  path: string;
  name?: string;
  planPath?: string;
  defaultModel?: ClaudeModel;
  defaultPermissionMode?: PermissionMode;
  writeBackPlan?: boolean;
}

/** One unit of work, parsed from a plan or added ad-hoc, owned by the app's DB. */
export interface Task {
  /** Stable app-assigned id (UUID). */
  id: string;
  /** The owning project. */
  projectId: string;
  /** The phase/heading this task falls under (e.g. "Phase 2 — Persistence"). */
  phase: string;
  /** The task text (the checkbox item's label). */
  title: string;
  /** Live status owned by the app, independent of the plan file's checkbox. */
  status: TaskStatus;
  /**
   * The Claude session id, captured the moment a session starts, so the task can
   * be resumed after a limit reset or app restart. Null until it has run.
   */
  sessionId: string | null;
  /** Ordering within the project (phase order, then position in the plan). */
  order: number;
}

/** A project bundled with its current tasks — the shape the Projects UI renders. */
export interface ProjectWithTasks {
  project: Project;
  tasks: Task[];
}
