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
import type { AdfBlock, CommentAttachment } from './adf';
import type { ExecTarget } from './execTarget';
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
 *   from the AI's `running`); `in-review` = the work is written and is waiting on
 *   someone else to look at it; `blocked` = the human is stuck/waiting; `done`;
 *   `cancelled` = won't do.
 *
 * Only `pending`/`done`/`failed`/`stopped`/`in-progress`/`in-review`/`blocked`/
 * `cancelled` are resting states; `running`/`waiting-input`/`blocked-by-limit` mean
 * a session is mid-flight.
 */
export type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'in-review'
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
  'in-review',
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
 * category) — it is not stored. Shared by main and renderer so the drag-to-move
 * IPC (`task:move`) and the board UI agree on the vocabulary.
 *
 * `blocked` used to be the one column no tracker could reach, in either direction. It
 * is now readable (a workflow's Blocked status resolves here) and writable (dropping a
 * card here transitions the issue), because a column that means one thing when the sync
 * fills it and another when you drag into it is not a column. It stays reachable for an
 * internal card, and for a workflow with no blocked status of its own.
 *
 * `in-review` cannot be derived from a JIRA *category* (JIRA has only three, and
 * every review-ish status sits in `In Progress`), so it is reachable only through
 * the user's status-name map — see `JiraSettings.statusCategoryOverrides`.
 */
export type BoardColumn = 'todo' | 'in-progress' | 'in-review' | 'blocked' | 'done';

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
 * - `ticket` — a **native ticket project** (Phase 24): a key prefix (`TM`) and a set of
 *   tickets the app itself owns, rather than mirrors from somebody else's tracker. It
 *   has no repo directory and no plan file at all (see {@link Project.ticketPrefix});
 *   its tickets are `tasks` rows with `source: 'ticket'`, so the board, the timeline,
 *   the attachments and the chain of execution all work on them unchanged.
 */
export type ProjectKind = 'plan' | 'agent' | 'ticket';

/**
 * Whether a project is the **legacy plan-driven kind** — the one the Projects tab lists,
 * the plan watcher watches, and the scheduler drains a queue for.
 *
 * Deliberately a whitelist. Every one of these tests used to be written by *elimination*
 * (`!isPersonalBoard(id) && kind !== 'agent'`), which is only correct while `plan` and
 * `agent` are the only two kinds there are: the moment a third exists every one of them
 * silently adopts it, and a ticket project would appear on the Projects tab with a plan
 * file watched for a directory it does not have. Naming the kind you mean cannot do that.
 */
export function isPlanProject(project: Pick<Project, 'id' | 'kind'>): boolean {
  return !isPersonalBoard(project.id) && project.kind === 'plan';
}

/**
 * Whether a project is **a directory on a machine** — the kinds for which `path` and
 * `target` mean something, so git, worktrees and "which distro does this run on" apply.
 *
 * The Personal board and a ticket project are both card lists rather than codebases: their
 * `path` is `''` and their `target` is only whatever the default happened to be the day
 * they were created. See {@link isPlanProject} for why this is a whitelist too.
 */
export function isRepoProject(project: Pick<Project, 'id' | 'kind'>): boolean {
  return !isPersonalBoard(project.id) && (project.kind === 'plan' || project.kind === 'agent');
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
  /**
   * Which model this project's tasks **run** with unless overridden — the steps-execution
   * model. Keeps its name and its meaning; only its label in the UI says "execution", now
   * that {@link Project.planningModel} sits beside it.
   */
  defaultModel: ClaudeModel;
  /**
   * Which model this project **plans** with — the one run whose whole output is judgement:
   * it reads a repo it has never seen and decides what the work *is*, where a step is handed
   * a brief that already says what to do.
   *
   * `null` — the default, and every project that predates the field — means "same as
   * execution", so nothing about an existing project changes until a human sets it. A card's
   * own `agentModel` still outranks both; see {@link resolveRunModel}.
   */
  planningModel: ClaudeModel | null;
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
   * The branch task branches start FROM and are merged back INTO — the repo's
   * integration branch (`main`, `master`, `development`, …).
   *
   * `''` means "whatever the main checkout happens to have checked out", which is how
   * this always worked and stays the default. Naming it explicitly is worth doing for
   * two reasons: the checkout wanders (you look at a branch, and suddenly every task
   * is based on it), and a named base that ISN'T checked out is integrated by moving
   * the ref rather than by merging in the work tree — so your uncommitted work in the
   * main checkout stops blocking merges it has nothing to do with.
   */
  baseBranch: string;
  /**
   * When true, the scheduler ticks the matching `- [ ]` back to `- [x]` in the
   * project's plan file as each task completes. Off by default so we never touch
   * the user's file unless they opt in. Only the single completed checkbox is
   * flipped — unrelated edits are left untouched.
   */
  writeBackPlan: boolean;
  /**
   * The project's PREFERENCE for auto-release: when a card's branch is merged back into
   * base, follow the repo's `RELEASE.md` and cut the release too (see `@shared/release`).
   *
   * A default, not a decision — every card may override it in the Details Panel, and a
   * card that never did follows this. Off for every project that predates the field, and
   * inert for a repo with no `RELEASE.md`: the merge notes that the file is missing and
   * nothing is run, because the instructions are the repo's to write.
   */
  autoRelease: boolean;
  /**
   * The project's PREFERENCE for auto-merge: when a card's run finishes, merge its branch
   * back into base without waiting to be asked (see `@shared/integrate`).
   *
   * `null` — the default, and every project that predates the field — means "whatever the
   * app-wide `AppSettings.autoIntegrate` says", so an upgrade changes nothing and turning
   * the global switch over still moves every repo that never disagreed with it. A card may
   * overrule this in turn, on the board.
   */
  autoIntegrate: boolean | null;
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
  /**
   * For a **ticket project**: the key prefix its tickets are named with — `'TM'`, giving
   * `TM-1`, `TM-2`, … See `@shared/ticketKey` for the canonical form (upper-case, no
   * punctuation, never a bare number).
   *
   * `''` means the project has none, which is true of every project that is not a ticket
   * project and of a ticket project nobody has named yet. Unique across the app,
   * case-blind, enforced by a partial unique index over the non-empty ones — `TM` and `tm`
   * are the same project's key to everyone but SQLite.
   *
   * The allocator behind the numbers (`ticketSeq`) is deliberately NOT on this type. It is
   * a counter, not a property: it is stale the moment anyone creates a ticket, so a copy of
   * it in an optimistic renderer would be wrong more often than right, and exposing it here
   * would let a patch write it. It is read and bumped inside the store, by the one function
   * that allocates a key, and by nothing else.
   */
  ticketPrefix: string;
  /**
   * Which machine this project's work runs on: the Claude session, `git`, its
   * worktrees and its plan file. Defaults to `local` — the machine showing the
   * window — so a project that predates this field behaves exactly as before.
   *
   * A target belongs to the PROJECT rather than to the app because `path` is
   * meaningless without it: `C:\Repositories\app` and `/home/you/bsp` cannot run on
   * the same machine, and both may be open at once.
   */
  target: ExecTarget;
  /**
   * Standing instructions injected into every run's prompt — setup knowledge that
   * belongs to your orchestrator rather than to the codebase (where the build tree
   * lives, an environment to source first, a wrapper a tool must run through).
   * Codebase knowledge belongs in the repo's own CLAUDE.md, which the CLI reads by
   * itself. Empty by default.
   */
  instructions: string;
  /**
   * The project's colour as a hex string (`#0091FF`), or `''` for none.
   *
   * Purely a board signal: a card tagged with this project wears a stripe of it along
   * its top edge, so a mixed column tells you at a glance which repo each card is
   * about. Nothing about how the project runs depends on it.
   */
  color: string;
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
  /** Model for planning runs; omitted (or `null`) = the app-wide seed, and then "same as
   *  execution". See {@link Project.planningModel}. */
  planningModel?: ClaudeModel | null;
  defaultPermissionMode?: PermissionMode;
  concurrency?: number;
  useWorktrees?: boolean;
  /** Integration branch; defaults to `''` = the main checkout's current branch. */
  baseBranch?: string;
  writeBackPlan?: boolean;
  /** Release after a card's branch merges, per the repo's `RELEASE.md`. Defaults to off. */
  autoRelease?: boolean;
  /** Merge a finished card's branch by itself; defaults to `null` = follow the app setting. */
  autoIntegrate?: boolean | null;
  planAligned?: boolean;
  /**
   * Defaults to `plan`. `agent` forces a plan-less, worktree-isolated project; `ticket`
   * forces a project with no repo at all (`path`/`planPath` both `''`).
   */
  kind?: ProjectKind;
  jiraEpicKeys?: string[];
  /**
   * The ticket key prefix, for `kind: 'ticket'`. Normalized on the way in and ignored for
   * every other kind. Omitted (or unusable) leaves the project prefix-less, which simply
   * means it cannot allocate a key yet — see {@link Project.ticketPrefix}.
   */
  ticketPrefix?: string;
  /** Defaults to the global `defaultExecTarget`. */
  target?: ExecTarget;
  instructions?: string;
  /** Hex colour for the board stripe; defaults to none. */
  color?: string;
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
    | 'planningModel'
    | 'defaultPermissionMode'
    | 'concurrency'
    | 'useWorktrees'
    | 'baseBranch'
    | 'writeBackPlan'
    | 'autoRelease'
    | 'autoIntegrate'
    | 'planAligned'
    | 'jiraEpicKeys'
    // Renaming a prefix re-keys every ticket the project owns, in the same transaction —
    // the numbers are the durable part, the key is denormalised for display.
    | 'ticketPrefix'
    | 'target'
    | 'instructions'
    | 'color'
  >
>;

/**
 * Every model a run may be launched on, cheapest first — the one list the dropdowns and
 * the ladder below share.
 *
 * It lives here rather than in `session.ts` (where {@link ClaudeModel} is declared) because
 * `model.ts` already imports from there, and a project's models are the reason the list is
 * needed at all. Six renderer files each carried their own copy of it before this.
 */
export const MODELS: readonly ClaudeModel[] = ['haiku', 'sonnet', 'opus'];

/**
 * Which model a run costs: the card's own choice, else the project's model **for that kind
 * of run**, else the project's execution model.
 *
 * ```
 * task.agentModel                                 // explicit per-card / per-step choice
 *   ?? (planning ? project.planningModel : null)  // null = "same as execution"
 *   ?? project.defaultModel                       // the steps-execution model
 * ```
 *
 * `planning` is decided by the caller from what the run IS ("come back with a plan"), not
 * from the permission mode alone — a chat reply or a review that merely inherited `plan`
 * mode from its card is not planning and keeps the execution model.
 *
 * Pure, and here rather than in the scheduler, for the same reason `releaseMode` is: a
 * ladder that decides what a run costs should be testable without a CLI. `??` throughout,
 * never `||` — both new values are nullable and this schema treats `''` as a real value.
 */
export function resolveRunModel(
  task: Pick<Task, 'agentModel'>,
  project: Pick<Project, 'defaultModel' | 'planningModel'>,
  planning: boolean,
): ClaudeModel {
  return (
    task.agentModel ?? (planning ? (project.planningModel ?? null) : null) ?? project.defaultModel
  );
}

/**
 * The kind of an internal (non-JIRA) task, chosen by the user when adding it and
 * used to pick the card's type icon. JIRA-mirrored tasks don't use this — their
 * icon comes from `externalType` (the JIRA issue type). Null for legacy ad-hoc
 * tasks created before types existed (they fall back to a neutral icon).
 */
export type TaskType = 'bug' | 'feature';

/**
 * The kind of a **native ticket** (Phase 24) — a third type field beside {@link TaskType}
 * (the legacy ad-hoc `bug|feature`) and `Task.externalType` (JIRA's own, a free string).
 *
 * Three of them because they answer for three different owners and none can speak for the
 * others: JIRA's is whatever that instance calls its issue types, the ad-hoc one is what a
 * human picked in the Add-task dialog, and this is a closed set this app defines and can
 * therefore reason about (`epic` is the one that has children). `typeIconKeyFor` in
 * `@shared/tickets` is the single resolver over all three, so no two surfaces can disagree
 * about what a card is.
 */
export type IssueType = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

/**
 * How two tickets are related, as documentation — **not** as a gate.
 *
 * Deliberately apart from `LinkGate` in `@shared/taskChain`, which is the chain of
 * execution: an arrow there decides *when a run may start*. One of these decides nothing at
 * all. Conflating them would mean marking a ticket "duplicates" another and having the
 * scheduler refuse to start it.
 */
export type TicketLinkType =
  'blocks' | 'duplicates' | 'relates' | 'implements' | 'causes' | 'clones';

/**
 * Why a card was taken off the board — see {@link Task.archivedReason}.
 *
 * Each one names a question JIRA answered, because that is the rule the sync enforces: no
 * card leaves the board unless it was asked about by key and answered (`reconcileJiraTasks`).
 * Lives here rather than beside the sync so the Removed-cards list can spell them out to the
 * human without the renderer importing anything from main.
 */
export type TaskArchiveReason =
  /** JIRA was asked whether this key still matches the board's query, and said no. */
  | 'left-query'
  /** A finished card kept past the query, until `doneRetentionDays` ran out. */
  | 'retention-expired'
  /** Asked for by key, and JIRA does not have it: deleted, or invisible to this token. */
  | 'gone-from-jira';

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
   *
   * **A resume handle, and nothing more.** It is deliberately CLEARED in places where the
   * conversation is over but the work is not — `finishParentChain` above all — so it must
   * never be read as "this card has run". {@link Task.workedAt} is that fact; see
   * `hasAgentWorked` in `@shared/board`.
   */
  sessionId: string | null;
  /**
   * Epoch ms an agent session last STARTED on this card — or on one of its steps, since a
   * plan's steps run on the card's branch and the work is the card's either way. Null on a
   * card no agent has ever run.
   *
   * A durable, monotonic fact, and the only honest answer to "is there a branch here to
   * merge". `sessionId` used to stand in for it, which broke the moment a card's chain
   * finished: `finishParentChain` clears the session on purpose (the planner's context is
   * spent and the next message must open a fresh conversation), and every predicate that
   * had borrowed it — the Details Panel's **Merge branch** button, both auto-merge and
   * auto-release switches, the composer, the `stacked` chain gate — read a finished card
   * as one that had never started. The merge note tells the human to press Merge in the
   * same beat that the button disappears; this is the field that keeps it there.
   *
   * Never cleared, not even by a re-assignment: the branch a previous attempt wrote does
   * not un-write itself, and the one thing a human then wants is the button that merges or
   * discards it.
   */
  workedAt?: number | null;
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
   *   - `ticket`: a **native ticket** of a `kind: 'ticket'` project (Phase 24) — this app
   *               is the tracker, so nothing external ever refreshes or removes it.
   *
   * `ticket` is a value of its own rather than a flag beside `adhoc`, and that is the
   * *structural* guarantee that `reconcileJiraTasks` can never adopt, rewrite or archive a
   * native ticket: the reconciler filters on `source === 'jira'` in both directions.
   */
  source: 'plan' | 'adhoc' | 'jira' | 'ticket';
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

  // --- Plan-driven subtasks (Phase 11). ---
  /**
   * The parent card this task is a **step of**, or null for an ordinary card. Set on
   * subtasks created from an approved plan (or added by hand); a subtask lives on the
   * same board as its parent but never appears as its own column entry — the board
   * attaches it under the parent card instead. Steps run strictly in `order`, one at
   * a time, each in its own session, sharing the parent's worktree.
   */
  parentTaskId?: string | null;
  /**
   * The step's brief: one phase of the approved plan, or whatever the human typed when
   * writing the step by hand. This is what the runner hands the agent as the work to do
   * — deliberately distinct from `externalDescription`, which stays JIRA's own text.
   * Null for cards that carry no brief of their own.
   */
  description?: string | null;
  /**
   * Which planning round produced this step (Phase 18 — re-planning). 1 for a card's
   * first approved plan and for every step that predates the field; 2 for the steps a
   * second approved plan appended, and so on. A step added by hand joins whichever round
   * is current.
   *
   * Purely a grouping: the chain still runs strictly in `order` across all rounds, and the
   * card's counter stays cumulative. It exists so the Details Panel can fold a finished
   * round away instead of showing one flat list that grows every time you re-plan.
   * Undefined on cards, which have no round of their own.
   */
  planRound?: number;

  // --- The card's own progress note (free text, yours alone). ---
  /**
   * Where you actually are on this card, in your words — "waiting on infra for the
   * cert", "reproduced, fixing now". Distinct from `status` (a fixed vocabulary the
   * board and the tracker both understand) and from a timeline comment (which scrolls
   * away): this is the ONE line the board shows, so a column of cards says what is
   * happening without opening any of them.
   *
   * Only the latest survives here — every one ever posted stays on the timeline as a
   * `status-note` entry. Null until the card has one. Never sent to JIRA.
   */
  statusNote?: string | null;
  /** Epoch ms the current `statusNote` was posted; null when there is none. */
  statusNoteAt?: number | null;

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
   * The sprint the issue is in, by name (e.g. "Sprint 5"), shown on the card so the
   * board says *which* sprint you're looking at. Read from the per-instance Greenhopper
   * "Sprint" custom field (see `jira/jiraSprint.ts`); null when the instance has no
   * such field, the field could not be discovered, or the issue is in no sprint.
   */
  externalSprint?: string | null;
  /**
   * The key of the issue's epic (JIRA Server's "Epic Link" custom field) or, failing
   * that, its parent issue (Cloud/team-managed `parent`). Upper-cased so it compares
   * directly against an agent project's `jiraEpicKeys` — this is what lets an assigned
   * ticket resolve to the repo that owns its epic. Null when the issue has no epic or
   * the epic field could not be discovered.
   */
  externalParentKey?: string | null;
  /**
   * The epic's human NAME ("Checkout rework"), as opposed to {@link Task.externalParentKey}'s
   * key. Carried separately because the key is what resolves a ticket to the repo that
   * owns it — machine-facing, and never worth a card's widest line — while the name is
   * the only form worth showing a human.
   *
   * Null until the sync has fetched it (the key comes free on the issue; the name costs
   * a lookup of the epic itself), so the card falls back to the key rather than showing
   * an empty line.
   */
  externalEpicName?: string | null;
  /**
   * The issue's description, flattened to plain text (v2 returns a string, v3 an
   * Atlassian Document Format tree). Shown in the task detail pane and handed to the
   * agent as the ticket's brief. Null for internal tasks and for empty descriptions.
   */
  externalDescription?: string | null;
  /**
   * The board column this task occupied *before* it was moved to `blocked`, so
   * un-blocking restores it. Null whenever the task is not blocked.
   *
   * Also null for a card the TRACKER is holding blocked — a drop into BLOCKED transitions
   * the issue when the workflow can express it, and a ticket that really is Blocked leaves
   * that status by being transitioned out of it, not by a column this app remembered. So a
   * non-null value here means "this block is the app's own", which is the only case where
   * there is anything to restore.
   */
  preBlockStatus?: TaskStatus | null;
  /**
   * The status the HUMAN left this card in, remembered for as long as an agent run owns
   * `status`. Null whenever no run is in flight.
   *
   * A card's state is the human's alone: an agent run says nothing about whether the work
   * is To Do, In Review or Done, so a run must never move a card between columns. But the
   * run's own lifecycle (`running`/`waiting-input`/`blocked-by-limit`) lives in that same
   * `status` field and the whole engine reads it, so the two are separated here rather
   * than by a second status column: the run borrows `status`, this remembers what it
   * borrowed it from, and the card goes back to it when the run ends. The board reads the
   * remembered one (see `restingStatus`), so the card doesn't visibly move meanwhile.
   *
   * The same trick as {@link Task.preBlockStatus}, one layer up: that one preserves a
   * column across an internal state, this one preserves it across a run.
   *
   * Only ever set on a **board card** — a top-level card of the Personal board. A plan
   * project's tasks are a QUEUE, where `pending → running → done` is the whole point, and
   * a step of an approved plan must still reach `done` or the chain cannot advance.
   */
  preRunStatus?: TaskStatus | null;
  /**
   * Epoch ms this card started being **kept past the query**, or null while the JQL still
   * returns it.
   *
   * The board is the JQL result, so a card used to be deleted the moment its issue stopped
   * matching — and the commonest JQL there is (`resolution = Unresolved`) stops matching an
   * issue the instant you finish it. Dragging a card to DONE therefore made it disappear
   * from the very column you had just dropped it in.
   *
   * So a card that leaves the query while it is done is retained instead, and this is the
   * clock on that: the sync re-reads a retained card by key (its column keeps following the
   * ticket, even out of Done) and drops it once it has been retained longer than
   * `JiraSettings.doneRetentionDays`. Cleared the moment the issue matches the JQL again —
   * it is an ordinary card once more.
   *
   * The same shape as {@link Task.preBlockStatus} and {@link Task.preRunStatus}: local state
   * about a card that the tracker knows nothing about, carried across every sync.
   */
  retainedSince?: number | null;
  /**
   * Epoch ms this card was **taken off the board**, or null while it is on it.
   *
   * A card that stops matching the query leaves the BOARD, not the database. The row carries
   * things JIRA has never heard of and can never give back — the timeline you wrote on it, the
   * files you attached, the arrows drawn to and from it, the branch its agent ran on, the
   * transcript of that run — so a query that stops mentioning a ticket is not permission to
   * destroy any of that. It is only evidence about what belongs in the columns.
   *
   * So the sync archives instead of deleting: the row stays whole and every read that draws the
   * board (`getPersonalTasks`) skips it. Restoring it is one write of `null`, and the card comes
   * back with the same id and everything still hanging off it. `retainedSince` above is the
   * milder version of the same idea — keep showing a finished card for a while — and this is
   * what happens when that clock finally runs out.
   *
   * `task:delete` — the human saying so, in as many words — stays a real delete. Nobody else
   * gets to.
   *
   * Null on every card that predates the field, which reads as "on the board": true of
   * everything already there when the app starts.
   */
  archivedAt?: number | null;
  /**
   * Which question's answer took this card off the board, or null on a card that is on it
   * (and on every row archived before this column existed).
   *
   * Stored rather than derived, because the Removed-cards list exists to answer exactly one
   * question — *why is this not on my board?* — and the row alone cannot answer it. A card
   * dropped for `retention-expired` and one dropped for `gone-from-jira` are the same row in
   * every other respect (both were retained, both have a `retainedSince`), and they mean
   * opposite things to the human: one is the app's own clock running out on a card you
   * finished, the other is the ticket having been deleted or hidden from your token. A list
   * that guessed between them would be worse than one that said nothing.
   *
   * Cleared by `unarchiveTask` along with `archivedAt` — the reason describes an absence, and
   * a card that is back has none.
   */
  archivedReason?: TaskArchiveReason | null;
  /** Epoch ms of the newest tracker comment the user has read (unread-badge marker). */
  lastReadCommentAt?: number | null;
  /** Epoch ms of the newest tracker comment seen at the last sync (drives unread). */
  latestCommentAt?: number | null;

  /**
   * The project this card is **about** — the filing, not the delegation.
   *
   * Its counterpart is `agentProjectId` below, and the two used to be the same column,
   * which is why tagging a card as "a Billing card" gave it the agent glyph and made
   * the pane offer to *reassign* something nobody had assigned. Filing a card says
   * where it belongs; delegating it says a run should happen. They are different
   * clicks and now different fields.
   *
   * Drives the card's colour stripe and the Project dropdown. Null for an unfiled card.
   */
  projectTagId?: string | null;

  // --- Agent delegation (My Tasks → an agent project). Null until assigned. ---
  /**
   * The **agent project** (see {@link ProjectKind}) this card has been delegated to —
   * the repo a delegated run happens in. The task's own `projectId` stays on the
   * Personal board, so the card never leaves My Tasks while its run is attributed to
   * the real repo. Null for a card nobody assigned to an agent.
   *
   * Written ONLY by delegation. Filing a card under a project writes `projectTagId`.
   */
  agentProjectId?: string | null;
  /**
   * Permission mode chosen for THIS assignment, overriding the agent project's
   * default for every run of this card (including a limit-resume or an auto-retry).
   * Null falls back to the project default.
   */
  agentMode?: PermissionMode | null;
  /** Model chosen for this assignment, overriding the project default. Null = project default. */
  agentModel?: ClaudeModel | null;
  /**
   * The plan a `plan`-mode delegated run produced, as markdown (Phase 11) — captured
   * from the agent's `ExitPlanMode` call and kept so it survives a restart, can be
   * re-read in the detail pane, and can be split into subtasks on approval. Null until
   * the card has been planned.
   */
  agentPlan?: string | null;
  /**
   * The git branch this card's worktree runs on (Phase 17), chosen — and editable — when
   * the agent is assigned. Steps of a plan inherit it: they share the parent's worktree,
   * so they share its branch.
   *
   * Null on every card assigned before branch naming existed, which `branchFor` reads as
   * "fall back to the legacy `orch/<taskId>` name" so no existing worktree is orphaned.
   */
  agentBranch?: string | null;
  /**
   * This card's answer to "release after the merge?" — `true`/`false` when the human has
   * said so in the Details Panel, `null` (the default, and every pre-existing card) when
   * they have not, which follows the agent project's `autoRelease` preference.
   *
   * Three states rather than two on purpose: a card that merely inherits must keep
   * inheriting, so that turning the preference on for the project turns it on for the
   * cards nobody has ruled on. See `@shared/release`.
   */
  autoRelease?: boolean | null;
  /**
   * This card's answer to "merge the branch when the work is finished?" — `true`/`false`
   * when the human has said so on the board, `null` (the default, and every pre-existing
   * card) when they have not, which follows the agent project's preference and, through
   * it, the app-wide setting. See `@shared/integrate`.
   *
   * Read at the moment a run FINISHES, not when it starts, so changing your mind while the
   * agent works still decides what happens to the branch it produces.
   */
  autoIntegrate?: boolean | null;

  // --- Native tickets (Phase 24). All null/empty unless `source === 'ticket'`. ---
  /**
   * The ticket's permanent name — `'TM-123'`. Denormalised for display: the card, the
   * backlog row, the Gantt gutter and the link picker all read it with no project lookup,
   * exactly as {@link Task.externalKey} works for a JIRA issue.
   *
   * A key is a **name**, so it is never re-issued: deleting `TM-500` must not make the next
   * ticket `TM-500` again, or every note, branch and link that ever mentioned it becomes a
   * lie. That is why the number below comes from the project's own allocator and never from
   * `MAX(ticketNumber)`. Null for everything that is not a native ticket.
   */
  ticketKey?: string | null;
  /**
   * The durable half of the key: the ordinal the project's allocator issued. Stored beside
   * `ticketKey` so a prefix rename is one `UPDATE` over the project's rows rather than a
   * re-numbering — the number is what the ticket IS, the key is how it reads.
   */
  ticketNumber?: number | null;
  /** What kind of ticket this is; see {@link IssueType}. Null for non-tickets. */
  issueType?: IssueType | null;
  /**
   * The **epic** this ticket hangs under — a task row of its own with
   * `issueType: 'epic'` — or null.
   *
   * Deliberately NOT `parentTaskId`, which already means "step of an approved plan":
   * `groupSubtasks` renders such children *inside* the parent card and `chainRunner`
   * executes them in order, so reusing it would silently turn every story under an epic
   * into an executable step of it.
   */
  epicTaskId?: string | null;
  /** The milestone this ticket is planned for (a `milestones` row), or null. */
  milestoneId?: string | null;
  /**
   * The ticket's labels, **by name** — the chips on the card, and what the label filter
   * matches on.
   *
   * Names rather than ids, and denormalised onto the row rather than kept in a join table,
   * for the same two reasons: the board read is the hottest query in the app and a join
   * would add a second query plus a per-render regroup to it, and deleting a label should
   * degrade a chip to grey rather than dangle. `dependsOn` sets the precedent for the
   * encoding — a JSON array of strings in one column.
   *
   * Undefined on a row that predates the field; read back as `[]`.
   */
  labels?: string[];
  /**
   * Estimated size in story points, or null for **not estimated**.
   *
   * Nullable rather than 0-defaulted on purpose: "nobody has estimated this" is a real
   * state, and `0` cannot express it because 0 points is itself a legitimate estimate. A
   * fractional number because half-points exist. Independent of `estimateDays` — the app
   * invents no conversion between the two.
   */
  storyPoints?: number | null;
  /** Estimated effort in days; null for not estimated. Fractional — half a day is the
   *  commonest estimate there is. See {@link Task.storyPoints}. */
  estimateDays?: number | null;
  /** Epoch ms the work is planned to start — the left edge of the Gantt bar. Null = unplanned. */
  startAt?: number | null;
  /** Epoch ms the work is due — the right edge of the Gantt bar. Null = no date. */
  dueAt?: number | null;
  /** The {@link Person} this ticket is assigned to, by id, or null for unassigned. */
  assigneeId?: string | null;
  /** The {@link Person} who raised it, by id, or null. */
  reporterId?: string | null;

  // --- The chain of execution (see `@shared/taskChain`). ---
  /**
   * Epoch ms this card's work **landed** — integration merged its branch, or a merge
   * request linked to it was first seen `merged`. Null while it has not.
   *
   * The condition an `after-merge` link waits on, and stored rather than derived for the
   * same reason `planRound` is: a chain that has been released must stay released. Every
   * derivable answer flickers — an MR list that has not been polled yet reads as "not
   * merged", and a card dragged back out of Done would un-land work that is demonstrably
   * in the base branch. Neither may pull a successor's start back out from under it.
   *
   * Null on every card that predates the field, which reads as "has not landed": nothing
   * is chained yet either, so nothing is held back by it.
   */
  landedAt?: number | null;
  /**
   * Epoch ms this card's chain last finished, or null. A one-shot marker, not a record like
   * {@link Task.landedAt}: `finishParentChain` sets it in the same beat it clears
   * `sessionId`, and `startTask` clears it the moment it is read.
   *
   * What it's for: the card's session is gone (see `sessionId` above), so the human's next
   * chat message starts a genuinely fresh run — and `startTask` needs to know that fresh run
   * is a REVIEW of work already merged, not new work, so it runs in the project directory
   * instead of cutting a worktree off a branch the chain's own integration already deleted.
   * `reviewSeed` on the run is exactly that flag; this column is what tells `startTask` to
   * set it on a run nothing else marked as one.
   */
  chainLandedAt?: number | null;
}

/**
 * Somebody a ticket can be assigned to or reported by (Phase 24).
 *
 * **App-wide, not per project**, because a person works across projects: filing the same
 * human once per project would make "assigned to me" a question with several answers.
 */
export interface Person {
  id: string;
  /** Display name, as typed. The only required field — everything else is decoration. */
  name: string;
  /** Their email, or `''`. Only ever a label here; the app sends nobody anything. */
  email: string;
  /**
   * The two or three letters on the avatar — **stored, not derived**. Two "Anna K"s need
   * different initials and only a human can say which is which; a deriver would give them
   * the same ones forever.
   */
  initials: string;
  /** Avatar colour as a hex string (`#0091FF`), or `''` for the default. */
  color: string;
  /**
   * True for **you**. At most one person may carry it — a partial unique index enforces
   * that, and setting it on somebody else clears it from whoever had it, in the same
   * transaction. It is what lets a board filter say "mine" without asking.
   */
  isMe: boolean;
  createdAt: number;
}

/** What a person is created/edited with. `name` is the only thing a caller must supply. */
export interface PersonInput {
  name: string;
  email?: string;
  /** Omitted (or blank) leaves the store to seed them from the name; edit them after. */
  initials?: string;
  color?: string;
  isMe?: boolean;
}

/** The editable half of a {@link Person} — everything but its id and `createdAt`. */
export type PersonPatch = Partial<Pick<Person, 'name' | 'email' | 'initials' | 'color' | 'isMe'>>;

/**
 * A dated goal a project's tickets are planned against — "Beta", "1.0" (Phase 24).
 *
 * A real table rather than a string on the ticket, because a milestone is drawn on the
 * timeline **whether or not any ticket points at it**: a date nobody has planned work for
 * yet is exactly the one worth seeing.
 */
export interface Milestone {
  id: string;
  /** The ticket project it belongs to. Cascades with it. */
  projectId: string;
  name: string;
  description: string;
  /** Epoch ms it is due, or null while it has no date. */
  dueAt: number | null;
  /** Hex colour for its marker on the timeline, or `''`. */
  color: string;
  /** Closed milestones stay on record but drop out of the pickers. */
  closed: boolean;
  createdAt: number;
}

/** What a milestone is created/edited with; only `name` is required. */
export interface MilestoneInput {
  name: string;
  description?: string;
  dueAt?: number | null;
  color?: string;
  closed?: boolean;
}

/** The editable half of a {@link Milestone}. Its project is fixed once created. */
export type MilestonePatch = Partial<
  Pick<Milestone, 'name' | 'description' | 'dueAt' | 'color' | 'closed'>
>;

/**
 * A label a project's tickets may wear (Phase 24) — the registry that gives a label its
 * colour and the filter dropdown its list.
 *
 * The tickets themselves carry label **names** (`Task.labels`), not ids, so deleting one of
 * these degrades a chip to grey rather than leaving a dangling reference. Names are unique
 * per project and matched case-blind, for the reason `task_attachments.name` is: the
 * sameness a human means is case-blind, whatever SQLite thinks.
 */
export interface TicketLabel {
  id: string;
  projectId: string;
  name: string;
  /** Hex colour for the chip, or `''` for the default grey. */
  color: string;
  createdAt: number;
}

/** What a label is created/edited with; only `name` is required. */
export interface TicketLabelInput {
  name: string;
  color?: string;
}

/** The editable half of a {@link TicketLabel}. Renaming it renames the chips too. */
export type TicketLabelPatch = Partial<Pick<TicketLabel, 'name' | 'color'>>;

/**
 * One documented relationship between two tickets — "TM-4 blocks TM-9" (Phase 24).
 *
 * **One row per link, directed, read from either end**, rather than a row per direction:
 * two rows would double every write and make "delete this link" ambiguous. Both ends are
 * indexed, so the inward query is as cheap as the outward one, and `@shared/tickets` owns
 * the phrasing that turns one row into the sentence each end reads.
 *
 * Gates nothing — see {@link TicketLinkType}.
 */
export interface TicketLink {
  id: string;
  /** The ticket the relationship is stated FROM: `from` *blocks* `to`. */
  fromTaskId: string;
  toTaskId: string;
  type: TicketLinkType;
  createdAt: number;
}

/**
 * What creating a native ticket sends. Everything but the title is optional, because a
 * ticket typed into a backlog in five seconds is the common case and every other field is
 * something a human fills in later.
 *
 * The key is deliberately absent: it is the project's allocator's to issue, and a caller
 * that could name a ticket could re-issue one.
 */
export interface TicketInput {
  title: string;
  /** The ticket's own brief. Lands in `externalDescription`, the field every surface
   *  already reads a card's description from (`Task.description` is a step's brief). */
  description?: string | null;
  /** Defaults to `task`. */
  issueType?: IssueType | null;
  epicTaskId?: string | null;
  milestoneId?: string | null;
  labels?: string[];
  storyPoints?: number | null;
  estimateDays?: number | null;
  startAt?: number | null;
  dueAt?: number | null;
  assigneeId?: string | null;
  reporterId?: string | null;
  /**
   * The priority name ("High"). Native tickets reuse `externalPriority` rather than adding
   * a column: `priorityRank`, the priority glyph and `sortCards` all read that field
   * already, and `task:setPriority`'s JIRA write-back branch is keyed on
   * `externalSource === 'jira'` — which a native ticket is not — so the same channel is
   * local-only for it without a line of new code.
   */
  priority?: string | null;
  /** The heading it files under, as on any other task. Defaults to `''`. */
  phase?: string;
}

/**
 * The ticket-specific fields a human may edit afterwards.
 *
 * `ticketKey` and `ticketNumber` are absent, and that is the point: a key is a permanent
 * name. Renaming the project's prefix re-keys its tickets in one transaction (see
 * `ProjectPatch`); nothing else may touch them. Title, description and priority keep going
 * through the channels every other card already uses.
 */
export type TicketPatch = Partial<
  Pick<
    Task,
    | 'issueType'
    | 'epicTaskId'
    | 'milestoneId'
    | 'labels'
    | 'storyPoints'
    | 'estimateDays'
    | 'startAt'
    | 'dueAt'
    | 'assigneeId'
    | 'reporterId'
  >
>;

/** What the assign-to-an-agent action sends: where to run, how, and an optional brief. */
export interface AssignAgentInput {
  /** The agent project (repo) the card is delegated to. */
  agentProjectId: string;
  /** Permission mode for this assignment; omitted = the project's default. */
  mode?: PermissionMode;
  /** Model for this assignment; omitted = the project's default. */
  model?: ClaudeModel;
  /**
   * Free-text instructions for the agent. Recorded as a comment on the task's
   * timeline (not just passed to the process), so it is visible to the human and
   * survives a retry — the prompt is rebuilt from the timeline on every fresh run.
   */
  notes?: string;
  /**
   * Whether to launch the agent straight away (Phase 17).
   *
   * `false` persists the assignment and stops, so the card shows a Start button and can be
   * talked to first — assigning used to be indistinguishable from starting, which left no
   * way to discuss a card with its agent before it began changing files. Defaults to
   * `true`, so every existing caller behaves exactly as before.
   */
  start?: boolean;
  /**
   * The git branch the worktree runs on. Proposed by the dialog from `buildBranchName` and
   * editable there; omitted falls back to the legacy `orch/<taskId>`.
   */
  branch?: string;
}

/**
 * Why a chat message could not be delivered (Phase 12). A refusal is a normal outcome,
 * not an exception: the UI turns each of these into a specific hint under the composer,
 * which a thrown `Error` string could not carry reliably.
 */
export type ChatRefusal =
  /** The run is blocked on a permission request or a plan approval — free text cannot
   *  answer either; the human has to approve/deny that item first. */
  | 'awaiting-decision'
  /** Nothing is running and nothing can be started (the scheduler is shutting down). */
  | 'not-running'
  /** The task has never run, so there is no conversation to continue. */
  | 'never-ran'
  /**
   * The card handed over to an approved plan and that chain has not finished: its steps
   * hold the conversation, so talk to the live step — or resolve the parked one first.
   */
  | 'chain-busy'
  /** A usage limit is holding all work; the message would go nowhere. */
  | 'limit'
  /**
   * The `claude` CLI cannot authenticate, so every run dies on spawn. A distinct reason
   * from `limit` because the fix is distinct: a limit ends by itself and this one ends
   * only when a human signs in, and telling them to wait would be telling them to wait
   * for ever.
   */
  | 'signed-out'
  /**
   * (Re-planning, Phase 18) The target is a STEP, not a card. A step is one unit of an
   * approved plan and cannot own a plan of its own — re-plan its parent instead.
   */
  | 'not-a-card'
  /**
   * (Re-planning, Phase 18) The card already carries `MAX_PLAN_STEPS` steps, so a new
   * round has nowhere to land. The cap is on the card, not on any one plan.
   */
  | 'chain-full'
  | 'unknown-task'
  | 'empty-message';

/**
 * What `task:chat` did with the message. `taskId` is the task that actually received
 * it — chatting with a card whose step is running talks to **the step**, since that is
 * where the live session is.
 */
export type ChatSendResult =
  /** Pushed into a live session's open input stream. */
  | { status: 'sent'; taskId: string; runId: string }
  /** Started a run with `--resume` and the message as its prompt. */
  | { status: 'resumed'; taskId: string; runId: string }
  | { status: 'refused'; taskId: string; reason: ChatRefusal };

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
 * What a project folder's git looks like, as answered while you are still CONFIGURING the
 * project rather than at the first run.
 *
 * Isolated worktrees are a per-project switch whose requirements are invisible until a task
 * dies on them: a folder that is not a repo silently degrades to the shared directory, and a
 * repo with no commits cannot produce a worktree at all. Both are one `git` call to detect and
 * unfixable-looking when they surface as a parked run instead.
 *
 *   - `missing`     — the path doesn't exist on the chosen machine.
 *   - `not-a-repo`  — a real folder, but no git. Worktrees will not engage.
 *   - `no-commits`  — `git init` with an unborn HEAD: nothing for a task branch to start from.
 *   - `ready`       — a repo with history; `branch` names the base tasks will branch off.
 *   - `unknown`     — git couldn't be run at all (not installed, distro down); advisory only.
 */
export type GitPreflightState = 'missing' | 'not-a-repo' | 'no-commits' | 'ready' | 'unknown';

/** The answer for one project folder. See {@link GitPreflightState}. */
export interface GitPreflight {
  state: GitPreflightState;
  /** The branch the checkout is currently on. Set for `ready`, and for `no-commits`
   *  (an unborn HEAD still names the branch it will be born on). */
  branch?: string;
  /**
   * Every local branch in the repo, so the form can offer a base to merge into rather
   * than making the human type one. Only populated for `ready` — an unborn repo has no
   * branches to list yet.
   */
  branches?: string[];
  /** git's own complaint, when there was one — for `unknown`. */
  detail?: string;
}

/**
 * One entry in a task's unified **activity timeline** (Phase 9): the human's
 * comments and status changes merged with the AI transcript, in time order. The
 * `id` is unique within its source table; `event`/`comment`/`status` are the three
 * kinds the My Tasks detail view renders.
 */
export type TaskActivityEntry =
  | { kind: 'comment'; id: number; body: string; createdAt: number }
  /**
   * A message you sent to the agent working this card (Phase 12). Distinct from a
   * `comment`: a note is for you, this was *said to* the agent and changed what it did,
   * so the card's story is wrong without it. The agent's replies need no kind of their
   * own — they already arrive as `event` entries on the transcript.
   */
  | { kind: 'chat'; id: number; body: string; createdAt: number }
  /**
   * A progress update you posted on the card — the one that is currently on the board
   * as `Task.statusNote`, plus every one it replaced. A kind of its own rather than a
   * `comment` because the two answer different questions ("what should I remember"
   * versus "where is this"), and because only the latest of these is the card's
   * headline. Deliberately not deletable: it is the card's history of itself.
   */
  | { kind: 'status-note'; id: number; body: string; createdAt: number }
  | { kind: 'status'; id: number; from: TaskStatus | null; to: TaskStatus; createdAt: number }
  | { kind: 'event'; id: number; event: SessionEvent; createdAt: number }
  /**
   * A comment fetched live from the linked JIRA issue (Phase D). Not persisted in the
   * store — merged into the timeline at read time. `id` is JIRA's comment id (a string).
   */
  | {
      kind: 'jira-comment';
      id: string;
      author: string;
      body: string;
      createdAt: number;
      /**
       * Whether *you* wrote it (Phase 12) — decided in the main process against the
       * cached `GET /myself`, since only it knows the account behind the PAT. False
       * whenever the identity is unknown: the chat pane puts your words on the right,
       * and guessing would put someone else's there.
       */
      mine: boolean;
      /**
       * The comment's structure — mentions, links, code, lists — when it could be
       * parsed. OPTIONAL, so `body` stays the contract and every existing consumer
       * (the fold into turns, the tests, the plain-text fallback) keeps working; the
       * pane renders this when present and falls back to markdown on `body` otherwise.
       */
      rich?: AdfBlock[];
      /**
       * Files on the issue, matched to this comment by filename. Attachment metadata is
       * per-ISSUE in JIRA, not per-comment, so this is a best-effort association.
       */
      attachments?: CommentAttachment[];
    };
