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
import type { ClaudeModel, PermissionMode, SessionEvent } from './session';

/**
 * Lifecycle of a single task. Two overlapping worlds share one field:
 *
 * AI-run states (owned by the scheduler, `docs/03-how-orchestration-works.md`):
 *   pending ─► running ─► done
 *                │ │
 *                │ └─ needs a human answer ─► waiting-input ─► running
 *                │ └─ usage limit hit ─────► blocked-by-limit ─► running
 *                └─ unrecoverable error ───► failed
 *   `stopped` is a user-initiated halt of a run.
 *
 * Human to-do states (Phase 9, set by hand — see `MANUAL_STATUSES`):
 *   `pending` doubles as "To Do"; `in-progress` = a human is working it (distinct
 *   from the AI's `running`); `blocked` = the human is stuck/waiting; `done`;
 *   `cancelled` = won't do.
 *
 * Only `pending`/`done`/`failed`/`stopped`/`in-progress`/`blocked`/`cancelled` are
 * resting states; `running`/`waiting-input`/`blocked-by-limit` mean a session is
 * mid-flight.
 */
export type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'blocked'
  | 'running'
  | 'waiting-input'
  | 'blocked-by-limit'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'cancelled';

/**
 * The statuses a human may set by hand from the UI (Phase 9). The AI-run states
 * (`running`/`waiting-input`/`blocked-by-limit`) are excluded — only the scheduler
 * assigns those. `pending` is shown as "To Do". `task:setStatus` validates against
 * this list, and it drives the status dropdown/menu options.
 */
export const MANUAL_STATUSES = [
  'pending',
  'in-progress',
  'blocked',
  'done',
  'cancelled',
] as const satisfies readonly TaskStatus[];

export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/** Whether a status is one a human is allowed to set directly. */
export function isManualStatus(status: TaskStatus): status is ManualStatus {
  return (MANUAL_STATUSES as readonly TaskStatus[]).includes(status);
}

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
   * How many of this project's tasks the scheduler may run in parallel. 1 = strictly
   * one at a time. Seeded from the global default when the project is created (and,
   * for projects that predate this field, from the global value on migration).
   */
  concurrency: number;
  /**
   * When true (and the project is a git repo), each task runs in its own git
   * worktree on its own branch, and the scheduler auto-integrates the branch back
   * into the base when the task completes. Non-git projects ignore this and run in
   * the shared project directory. Default on.
   */
  useWorktrees: boolean;
  /**
   * When true, the scheduler ticks the matching `- [ ]` back to `- [x]` in the
   * project's plan file as each task completes. Off by default so we never touch
   * the user's file unless they opt in. Only the single completed checkbox is
   * flipped — unrelated edits are left untouched.
   */
  writeBackPlan: boolean;
  /**
   * Whether the plan has been reviewed for the team-orchestration features
   * (dependency `@needs:` clauses and, later, a shared contract). Projects that
   * predate those features migrate in as `false` ("needs review") so the UI can
   * offer a one-click AI "Align" upgrade; new projects, and any plan that already
   * carries `@needs:`/`@contract` markers, are `true` and skip the nudge. Purely a
   * UI hint — it never changes how a project runs.
   */
  planAligned: boolean;
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
  concurrency?: number;
  useWorktrees?: boolean;
  writeBackPlan?: boolean;
  planAligned?: boolean;
}

/**
 * The subset of a project the user may edit after it's created (Phase 8). The
 * folder `path` and `id` are immutable — a project keeps its identity/history even
 * if its plan file, name, model, or mode change.
 */
export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'planPath'
    | 'defaultModel'
    | 'defaultPermissionMode'
    | 'concurrency'
    | 'useWorktrees'
    | 'writeBackPlan'
    | 'planAligned'
  >
>;

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
  /**
   * Titles of tasks this one depends on (from a `@needs:` clause in the plan). The
   * scheduler won't start this task until every named prerequisite is `done`.
   * Empty for tasks with no declared dependencies (incl. ad-hoc tasks).
   */
  dependsOn: string[];
  /**
   * Where the task came from (Phase 8):
   *   - `plan`  : parsed from the project's plan file; owned by the plan, so a
   *               re-sync can add/remove/reorder it.
   *   - `adhoc` : created in the app (no plan line). Plan syncs never touch it, so
   *               plan-less projects and on-the-fly tasks survive re-parsing.
   */
  source: 'plan' | 'adhoc';
  /**
   * True when this task authors the milestone's shared `CONTRACT.md` (team
   * orchestration, Phase C) — declared with a trailing `@contract` marker in the
   * plan. A contract task becomes an implicit prerequisite of every other task
   * under the same phase/heading, so it runs first and alone; its siblings then
   * build against the merged contract. False for ordinary and ad-hoc tasks.
   */
  isContract: boolean;
}

/** A project bundled with its current tasks — the shape the Projects UI renders. */
export interface ProjectWithTasks {
  project: Project;
  tasks: Task[];
}

/** Severity of a plan-validation issue: `error` blocks (ok=false), `warning` is advisory. */
export type PlanIssueSeverity = 'error' | 'warning';

/** One problem found while validating a plan's `@needs:` dependencies. */
export interface PlanIssue {
  severity: PlanIssueSeverity;
  message: string;
}

/** Result of validating a project's plan (see `planValidate.ts`). */
export interface PlanValidation {
  /** True when there are no `error`-severity issues (warnings don't block). */
  ok: boolean;
  issues: PlanIssue[];
}

/**
 * One entry in a task's unified **activity timeline** (Phase 9): the human's
 * comments and status changes merged with the AI transcript, in time order. The
 * `id` is unique within its source table; `event`/`comment`/`status` are the three
 * kinds the My Tasks detail view renders.
 */
export type TaskActivityEntry =
  | { kind: 'comment'; id: number; body: string; createdAt: number }
  | { kind: 'status'; id: number; from: TaskStatus | null; to: TaskStatus; createdAt: number }
  | { kind: 'event'; id: number; event: SessionEvent; createdAt: number };
