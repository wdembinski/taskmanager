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

/**
 * The columns of the My Tasks Kanban board. A board column is a *view* concept
 * derived from a task's status (and, for JIRA tasks, its external status
 * category) — it is not stored. `blocked` is an internal-only column that never
 * touches an external tracker. Shared by main and renderer so the drag-to-move
 * IPC (`task:move`) and the board UI agree on the vocabulary.
 */
export type BoardColumn = 'todo' | 'in-progress' | 'blocked' | 'done';

/**
 * JIRA groups every workflow status into one of three fixed *categories*. We map
 * the category (not the raw status name, which varies per project) onto a board
 * column, so any workflow lands sensibly without per-status configuration.
 */
export type JiraStatusCategory = 'To Do' | 'In Progress' | 'Done';

/**
 * The sentinel id of the built-in **Personal board** project — the home for the
 * standalone My Tasks board (JIRA tickets + internal ad-hoc tasks), which is not
 * tied to any code repo/plan. It reuses the whole task/activity machinery but is
 * hidden from the Projects tab and skipped by the plan watcher/scheduler. A fixed
 * id (not a UUID) so it's addressable and idempotently seeded.
 */
export const PERSONAL_PROJECT_ID = 'personal';

/** True for the built-in Personal board project (see `PERSONAL_PROJECT_ID`). */
export function isPersonalBoard(projectId: string): boolean {
  return projectId === PERSONAL_PROJECT_ID;
}

/**
 * What kind of project a row describes.
 *
 * - `plan` — the legacy Projects tab: a directory plus a plan.md whose checkboxes
 *   become a queue of tasks the scheduler drains.
 * - `agent` — the lightweight "agent project": just a repo directory (plus the JIRA
 *   epics it owns) that a single My Tasks card can be delegated to. It has no plan
 *   file and no queue — work only ever starts because a human assigned one card to
 *   an agent. Agent projects are hidden from the Projects tab and skipped by the
 *   plan watcher; they exist as `projects` rows so worktrees, integration, usage
 *   attribution and the usage-limit gate all work on them unchanged.
 */
export type ProjectKind = 'plan' | 'agent';

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
  /**
   * Whether this is a legacy plan-driven project or an agent project (see
   * {@link ProjectKind}). Rows that predate agent projects migrate in as `plan`.
   */
  kind: ProjectKind;
  /**
   * For an agent project: the JIRA epic/parent keys this repo owns (e.g.
   * `['ABC-100']`). A My Tasks card whose ticket hangs off one of these epics
   * resolves to this project automatically when it is assigned to an agent.
   * Always empty for plan projects.
   */
  jiraEpicKeys: string[];
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
  /** Defaults to `plan`. `agent` forces a plan-less, worktree-isolated project. */
  kind?: ProjectKind;
  jiraEpicKeys?: string[];
}

/**
 * The subset of a project the user may edit after it's created (Phase 8). The
 * `id` and `kind` are immutable — a project keeps its identity/history even if its
 * plan file, name, model, or mode change. The plan-project dialog never sends
 * `path` (its folder is fixed once added); agent projects do allow re-pointing the
 * folder, since they are nothing but a directory plus a few defaults.
 */
export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'path'
    | 'planPath'
    | 'defaultModel'
    | 'defaultPermissionMode'
    | 'concurrency'
    | 'useWorktrees'
    | 'writeBackPlan'
    | 'planAligned'
    | 'jiraEpicKeys'
  >
>;

/**
 * The kind of an internal (non-JIRA) task, chosen by the user when adding it and
 * used to pick the card's type icon. JIRA-mirrored tasks don't use this — their
 * icon comes from `externalType` (the JIRA issue type). Null for legacy ad-hoc
 * tasks created before types existed (they fall back to a neutral icon).
 */
export type TaskType = 'bug' | 'feature';

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
   *   - `jira`  : mirrored from a JIRA issue on the Personal board. A JIRA re-sync
   *               refreshes it, but its internal-only state (e.g. `blocked`) is
   *               preserved (see `jiraSync`).
   */
  source: 'plan' | 'adhoc' | 'jira';
  /**
   * True when this task authors the milestone's shared `CONTRACT.md` (team
   * orchestration, Phase C) — declared with a trailing `@contract` marker in the
   * plan. A contract task becomes an implicit prerequisite of every other task
   * under the same phase/heading, so it runs first and alone; its siblings then
   * build against the merged contract. False for ordinary and ad-hoc tasks.
   */
  isContract: boolean;
  /**
   * True when this task lays down the milestone's shared **scaffold** (team orchestration,
   * Phase D) — declared with a trailing `@scaffold` marker in the plan. Like a contract
   * task it runs first and alone under its heading (an implicit prerequisite of every
   * sibling), but instead of authoring `CONTRACT.md` it creates *and commits* the shared
   * monorepo root (workspace file, root manifest, base tsconfig, `.gitignore`, lockfile) so
   * fan-out siblings add only their own subtree and don't collide on those files at merge
   * time. False for ordinary and ad-hoc tasks.
   */
  isScaffold: boolean;
  /**
   * User-chosen kind for an internal task (bug/feature), driving its card icon.
   * Null for JIRA-mirrored tasks (they use `externalType`) and for legacy ad-hoc
   * tasks created before types existed.
   */
  type?: TaskType | null;

  // --- External tracker linkage (JIRA integration). All null for internal tasks. ---
  /** The external tracker this task mirrors, or null for an internal task. */
  externalSource?: 'jira' | null;
  /** The issue key shown to the user, e.g. `PROJ-123`. */
  externalKey?: string | null;
  /** The tracker's internal issue id (stable across renames; used for API calls). */
  externalId?: string | null;
  /** Deep link to the issue in the tracker's web UI. */
  externalUrl?: string | null;
  /** The raw workflow status name in the tracker (e.g. "In Review"). */
  externalStatus?: string | null;
  /** The tracker status's category, mapped onto a board column. */
  externalStatusCategory?: JiraStatusCategory | null;
  /** The issue's priority name (e.g. "High"), for the card's priority dot. */
  externalPriority?: string | null;
  /** The issue type (e.g. "Bug", "Story", "Task"), used to pick the card's type icon. */
  externalType?: string | null;
  /** A short label/component shown as a chip on the card (the issue's first label). */
  externalLabel?: string | null;
  /**
   * The board column this task occupied *before* it was moved to `blocked`, so
   * un-blocking restores it. Null whenever the task is not blocked. `blocked` is an
   * internal-only state — moving to/from it never touches the tracker.
   */
  preBlockStatus?: TaskStatus | null;
  /** Epoch ms of the newest tracker comment the user has read (unread-badge marker). */
  lastReadCommentAt?: number | null;
  /** Epoch ms of the newest tracker comment seen at the last sync (drives unread). */
  latestCommentAt?: number | null;
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
  | { kind: 'event'; id: number; event: SessionEvent; createdAt: number }
  /**
   * A comment fetched live from the linked JIRA issue (Phase D). Not persisted in the
   * store — merged into the timeline at read time. `id` is JIRA's comment id (a string).
   */
  | { kind: 'jira-comment'; id: string; author: string; body: string; createdAt: number };
