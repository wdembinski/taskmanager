/**
 * Persistent store — the app's memory of projects and their tasks.
 *
 * Backed by SQLite via `better-sqlite3` (a synchronous, embedded database; no
 * server, one file on disk). The database lives under Electron's per-user data
 * directory, passed in by the caller so this module stays decoupled from
 * Electron and is easy to point at a temp file in tests.
 *
 * The reconciliation logic (merging a freshly parsed plan into the tasks we
 * already track) lives in the pure `taskReconcile` module so it can be unit
 * tested without a database — the native better-sqlite3 binary is built for
 * Electron's ABI, not the Node that runs Vitest.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import Database from 'better-sqlite3';
import {
  type AddProjectInput,
  hasPlan,
  type Milestone,
  type MilestoneInput,
  type MilestonePatch,
  PERSONAL_PROJECT_ID,
  type Person,
  type PersonInput,
  type PersonPatch,
  type Project,
  type ProjectPatch,
  type Task,
  type TaskActivityEntry,
  type TaskArchiveReason,
  type TaskStatus,
  type TaskType,
  type TicketInput,
  type TicketLabel,
  type TicketLabelInput,
  type TicketLabelPatch,
  type TicketLink,
  type TicketLinkType,
} from '@shared/model';
import { isIssueType, isTicketLinkType, normalizeLabels, seedInitials } from '@shared/tickets';
import { formatTicketKey, normalizeTicketPrefix } from '@shared/ticketKey';
import { formatExecTarget, parseExecTarget } from '@shared/execTarget';
import { hostJoin } from '@shared/wslPath';
import type { AuthState } from '@shared/auth';
import type { LimitState } from '@shared/limit';
import type { SessionEvent } from '@shared/session';
import type { UsageSample } from '@shared/usage';
import {
  type AppSettings,
  DEFAULT_BOARD_DISPLAY,
  DEFAULT_CLOUD_SETTINGS,
  DEFAULT_GITHUB_SETTINGS,
  DEFAULT_GITLAB_SETTINGS,
  DEFAULT_JIRA_SETTINGS,
  DEFAULT_SETTINGS,
  resolveSyncInterval,
} from '@shared/settings';
import { mergeActivity } from './activityMerge';
import { type CloudOutboxRow, shapeCloudDelta } from './cloudDelta';
import { CLOUD_OUTBOX_BACKFILL_KEY, backfillCloudOutbox } from './cloudOutboxBackfill';
import type { JiraEpicFieldCache } from './jira/epicField';
import type { JiraSprintFieldCache } from './jira/jiraSprint';
import type { JiraIdentityCache } from './jira/identity';
import type { GitLabIdentityCache } from './gitlab/identity';
import type { GitHubIdentityCache } from './github/identity';
import type {
  MergeRequest,
  MergeRequestState,
  PipelineStage,
  PipelineStatus,
} from '@shared/mergeRequest';
import type { AttentionItem } from '@shared/attention';
import { isLinkGate, type LinkGate, type TaskLink } from '@shared/taskChain';
import type { TaskAttachment } from '@shared/attachments';
import type { ParsedTask } from './planParser';
import { splitProjectTag } from './projectTagMigration';
import { blockOwnerFor, needsBlockOwner } from './blockOwnerMigration';
import type { ParkedRun } from './parkedRun';
import type { SavedWindowState } from './windowState';
import { reconcileTasks } from './taskReconcile';

/** A row as stored; SQLite has no boolean, so we keep types explicit here. */
interface TaskRow {
  id: string;
  projectId: string;
  phase: string;
  title: string;
  status: string;
  sessionId: string | null;
  order: number;
  source: string;
  /** JSON array of prerequisite task titles (from a plan `@needs:` clause); null pre-migration. */
  dependsOn: string | null;
  /** 1 when the task authors the milestone's shared CONTRACT.md (`@contract`); 0 otherwise. */
  isContract: number;
  /** 1 when the task lays down the milestone's shared scaffold (`@scaffold`); 0 otherwise. */
  isScaffold: number;
  /** User-chosen internal task kind (bug/feature); NULL for JIRA and legacy tasks. */
  type: string | null;
  /** The parent card this row is a step of; NULL for ordinary cards. */
  parentTaskId: string | null;
  /** The step's brief (a phase of the approved plan, or hand-written); NULL if none. */
  description: string | null;
  /** The latest free-text progress note shown on the card; NULL until one is posted. */
  statusNote: string | null;
  /** Epoch ms the current `statusNote` was posted; NULL when there is none. */
  statusNoteAt: number | null;
  // External tracker linkage (JIRA). NULL for internal tasks.
  externalSource: string | null;
  externalKey: string | null;
  externalId: string | null;
  externalUrl: string | null;
  externalStatus: string | null;
  externalStatusCategory: string | null;
  externalPriority: string | null;
  externalType: string | null;
  externalLabel: string | null;
  /** Key of the issue's epic/parent (upper-cased), for agent-project resolution. */
  externalParentKey: string | null;
  externalEpicName: string | null;
  /** The name of the sprint the issue is in; NULL when it is in none. */
  externalSprint: string | null;
  /** The issue description flattened to plain text (v2 string / v3 ADF). */
  externalDescription: string | null;
  preBlockStatus: string | null;
  /** The human's status, parked while a run borrows `status`. See `Task.preRunStatus`. */
  preRunStatus: string | null;
  /** When this card started being kept past the JQL. See `Task.retainedSince`. */
  retainedSince: number | null;
  /** When this card was taken off the board, the row surviving. See `Task.archivedAt`. */
  archivedAt: number | null;
  /** Which answer took it off the board. See `Task.archivedReason`. */
  archivedReason: string | null;
  lastReadCommentAt: number | null;
  latestCommentAt: number | null;
  /** The project this card is filed under — what it is ABOUT. NULL when unfiled. */
  projectTagId: string | null;
  /** The agent project this card is delegated to; NULL when unassigned. */
  agentProjectId: string | null;
  /** Per-assignment permission mode override; NULL = the agent project's default. */
  agentMode: string | null;
  /** Per-assignment model override; NULL = the agent project's default. */
  agentModel: string | null;
  /** The plan a `plan`-mode delegated run produced, as markdown. NULL until it plans. */
  agentPlan: string | null;
  /** The git branch this card's worktree runs on; NULL = the legacy `orch/<taskId>`. */
  agentBranch: string | null;
  /** Which planning round produced this step; NULL pre-migration, read as round 1. */
  planRound: number | null;
  /** Per-card auto-release override as 0/1; NULL = follow the project. See `Task.autoRelease`. */
  autoRelease: number | null;
  /** Per-card open-a-PR override as 0/1; NULL = follow the project. See `Task.autoCreatePr`. */
  autoCreatePr: number | null;
  /** Per-card auto-merge override as 0/1; NULL = follow the project. See `Task.autoIntegrate`. */
  autoIntegrate: number | null;
  /** Epoch ms this card's work landed; NULL = it has not. See `Task.landedAt`. */
  landedAt: number | null;
  /** One-shot review marker; NULL once unset or never set. See `Task.chainLandedAt`. */
  chainLandedAt: number | null;
  /** Epoch ms an agent last started on this card or a step of it. See `Task.workedAt`. */
  workedAt: number | null;
  /** Epoch ms the human stopped this card's work; NULL once anything starts. See `Task.stoppedAt`. */
  stoppedAt: number | null;
  // Native tickets (Phase 24). NULL on everything that is not one.
  /** The ticket's permanent name, `'TM-123'`. Partial-unique over the non-NULL rows. */
  ticketKey: string | null;
  /** The ordinal the project's allocator issued. See `Task.ticketNumber`. */
  ticketNumber: number | null;
  /** 'epic' | 'story' | 'task' | 'bug' | 'subtask'; validated on read, never trusted. */
  issueType: string | null;
  /** The epic this ticket hangs under — a task id, deliberately NOT `parentTaskId`. */
  epicTaskId: string | null;
  /** The milestone it is planned for; plain TEXT with no foreign key. See below. */
  milestoneId: string | null;
  /** JSON array of label NAMES (like `dependsOn`); NULL pre-migration, read as []. */
  labels: string | null;
  /** Story points as a REAL; NULL means "not estimated", which 0 cannot express. */
  storyPoints: number | null;
  /** Estimated days as a REAL; NULL means not estimated. */
  estimateDays: number | null;
  /** Epoch ms the work is planned to start; NULL = unplanned. */
  startAt: number | null;
  /** Epoch ms the work is due; NULL = no date. */
  dueAt: number | null;
  /** The assignee's `people` id; plain TEXT, nulled explicitly when the person goes. */
  assigneeId: string | null;
  /** The reporter's `people` id. Same treatment as `assigneeId`. */
  reporterId: string | null;
}

/** A project row as stored; `writeBackPlan` is a 0/1 INTEGER (SQLite has no boolean). */
interface ProjectRow {
  id: string;
  name: string;
  path: string;
  planPath: string;
  defaultModel: string;
  /** The planning model; NULL (pre-migration, and the default) = "same as execution". */
  planningModel: string | null;
  defaultPermissionMode: string;
  concurrency: number;
  useWorktrees: number;
  /** Integration branch; null (pre-migration) and '' both mean "the checkout's current branch". */
  baseBranch: string | null;
  writeBackPlan: number;
  /** The project's auto-release preference as 0/1. See `Project.autoRelease`. */
  autoRelease: number;
  /** The project's open-a-PR preference as 0/1. See `Project.autoCreatePr`. */
  autoCreatePr: number;
  /** The project's auto-merge preference as 0/1; NULL = follow the app-wide setting. */
  autoIntegrate: number | null;
  planAligned: number;
  /**
   * A derived legacy label (`'plan' | 'agent' | 'ticket'`), written on every insert for
   * whatever outside this build still looks at it — see the `kind` write in `addProject`.
   * `rowToProject` no longer reads it back: a project's capabilities come from its other
   * fields now (`hasPlan`, `hasRepo`, `ownsTickets` in `@shared/model`).
   */
  kind: string;
  /** JSON array of JIRA epic keys owned by an agent project; null for plan projects. */
  jiraEpicKeys: string | null;
  /**
   * The ticket key prefix, or NULL for a project that has none — which is every project
   * that is not a ticket project. NULL rather than `''` because the uniqueness is enforced
   * by a PARTIAL unique index (`WHERE ticketPrefix IS NOT NULL`), and `''` would collide
   * across every existing row the moment the index was created.
   */
  ticketPrefix: string | null;
  /**
   * The key allocator: the highest ordinal this project has ever issued.
   *
   * Deliberately absent from `Project` — see `Project.ticketPrefix` for why. Read and
   * bumped inside `createTicketTx` and nowhere else, so a `ProjectPatch` can never write it.
   */
  ticketSeq: number;
  /** Serialized ExecTarget: 'local' or 'wsl:<distro>'. */
  target: string;
  /** Standing per-project instructions; null for projects that predate the field. */
  instructions: string | null;
  /** Hex colour for the board stripe; null for projects that predate the field. */
  color: string | null;
  createdAt: number;
}

/**
 * The extra arguments a call must supply — none for a synchronous `fn`, and one nobody can
 * produce for a `fn` that returns a promise. See {@link Store.runInTransaction}, which is
 * the only thing this exists for.
 *
 * Spelled as a rest tuple rather than as a constraint on `T` because `T` has to be inferred
 * from `fn` BEFORE the rule can be evaluated: a conditional in the parameter's own position
 * blocks that inference, and a conditional in the return position produces `never` silently
 * instead of an error. The label is what a reader sees when the call fails.
 */
export type SyncOnly<T> =
  T extends PromiseLike<unknown>
    ? [
        error: 'better-sqlite3 transactions are synchronous: an async fn commits at its first await, and every write after that point runs untransacted',
      ]
    : [];

/** The store's public surface. Constructed once in the main process. */
export interface Store {
  addProject(input: AddProjectInput): Project;
  listProjects(): Project[];
  getProject(id: string): Project | undefined;
  removeProject(id: string): void;
  /** Toggle the plan write-back opt-in for a project. */
  setWriteBack(id: string, enabled: boolean): void;
  /** Mark a project's plan as aligned/unaligned for the team-orchestration nudge. */
  setPlanAligned(id: string, aligned: boolean): void;
  /** Edit a project's name/plan/model/mode/write-back (Phase 8); returns the updated project. */
  updateProject(id: string, patch: ProjectPatch): Project | undefined;
  /**
   * Every task of a project, in order — **including archived ones**, deliberately.
   *
   * The asymmetry with `getPersonalTasks` below is the point. Archiving is a Personal-board
   * concept: it exists because a board is a QUERY over an external tracker and the query is
   * allowed to stop mentioning a ticket. A plan project's tasks are a QUEUE parsed from a file
   * the human owns, where nothing external ever removes a row and the reconciler in
   * `syncTasksFromPlan` has to see every task it already has or it would re-create it. Filtering
   * here would mean a queue that silently skipped work.
   */
  getTasks(projectId: string): Task[];
  getTask(id: string): Task | undefined;
  /** Patch a task's live fields (status/sessionId/external linkage); returns the updated task. */
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | 'status'
        | 'sessionId'
        | 'title'
        | 'description'
        | 'statusNote'
        | 'statusNoteAt'
        | 'externalSource'
        | 'externalKey'
        | 'externalId'
        | 'externalUrl'
        | 'externalStatus'
        | 'externalStatusCategory'
        | 'externalPriority'
        | 'externalType'
        | 'externalLabel'
        | 'externalParentKey'
        | 'externalEpicName'
        | 'externalSprint'
        | 'externalDescription'
        | 'preBlockStatus'
        | 'preRunStatus'
        | 'lastReadCommentAt'
        | 'latestCommentAt'
        | 'projectTagId'
        | 'agentProjectId'
        | 'agentMode'
        | 'agentModel'
        | 'agentPlan'
        | 'agentBranch'
        | 'landedAt'
        | 'chainLandedAt'
        | 'workedAt'
        | 'stoppedAt'
        | 'autoRelease'
        | 'autoCreatePr'
        | 'autoIntegrate'
        // Native tickets. `ticketKey`/`ticketNumber` are deliberately NOT patchable — a key
        // is a permanent name, and the only thing allowed to rewrite one is a prefix rename
        // (`updateProject`), which re-keys every ticket of the project at once.
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
    >,
  ): Task | undefined;
  /**
   * The cards ON a board, in order — the general form of `getPersonalTasks` below, which is
   * now a wrapper on it.
   *
   * "A board" is any project whose tasks are cards a human arranges: the built-in Personal
   * board and, since Phase 24, a ticket project. Archived rows are excluded, for the same
   * reason they are there: every caller that draws a board wants what a human can see.
   */
  getBoardTasks(projectId: string): Task[];
  /** The archived cards of one board, most recently archived first. The general form of
   *  `getArchivedTasks`. */
  getArchivedTasksFor(projectId: string): Task[];
  /**
   * Every board's cards, unioned — the Personal board plus every other project with no
   * plan file (see `isBoardProject`), archived rows excluded. What `board:tasks` reads
   * for the all-boards scope.
   *
   * Ordered `projectId, "order"` rather than by anything about the cards themselves: a
   * mixed-project list has no natural sort of its own, and ordering by a mutable per-card
   * field would jitter the whole thing on a write to a card the caller never touched.
   */
  getAllBoardTasks(): Task[];
  /** The archived cards across every board — the union form of `getArchivedTasksFor`,
   *  ordered the same way as `getAllBoardTasks` and for the same reason. */
  getAllArchivedBoardTasks(): Task[];
  /**
   * The Personal board (JIRA + internal ad-hoc), ordered — the cards that are ON it.
   *
   * Archived cards are excluded, and that is what makes this the safe default: every caller
   * that draws the board, matches a merge request to a card, or counts what is in a column
   * wants what a human can see. See `Task.archivedAt`.
   */
  getPersonalTasks(): Task[];
  /**
   * The same rows **plus the archived ones** — the input to JIRA reconciliation, and nothing
   * else.
   *
   * Named for its one caller rather than for what it returns, on purpose: a name like
   * `getAllPersonalTasks` would read as a harmless superset at every call site, and the one
   * place it is a superset SAFELY is the reconciler, which needs to recognise a ticket it has
   * already archived instead of mirroring it in as a brand-new card. Anywhere else it means a
   * card the human removed coming back — claiming a merge request, filling a column, answering
   * a count. If you are reaching for this and you are not the JIRA sync, you want
   * `getPersonalTasks`.
   */
  getPersonalTasksForSync(): Task[];
  /** Archived cards, most recently archived first — what a "removed" list is drawn from. */
  getArchivedTasks(): Task[];
  /**
   * Take a card off the board at `at`, keeping the row and everything hanging off it: its
   * timeline, its attachments, its transcript, and the chain arrows at both ends. Its steps go
   * with it — a step is only ever shown under its parent.
   *
   * `reason` is the question whose answer took it off — recorded on the row so the
   * Removed-cards list can say *why*, which is the only thing that list is for. Omitted
   * (null) reads as "an earlier version removed this", which is the truth for every row
   * archived before the column existed.
   *
   * Returns the archived card, or undefined for an unknown id, for a card that is already
   * archived, or for a STEP: a step is not on the board, so it cannot leave it on its own.
   */
  archiveTask(id: string, at: number, reason?: TaskArchiveReason | null): Task | undefined;
  /**
   * Put one back, steps and all, with the same id it left under — and with its reason
   * cleared, since it no longer describes anything. Undefined if unknown.
   */
  unarchiveTask(id: string): Task | undefined;
  /**
   * Destroy every card archived before `cutoff`, exactly as `deleteTask` would — the retention
   * backstop, so a board that archives forever does not grow forever. Returns how many cards
   * went (steps are taken with their card and are not counted separately).
   *
   * **This is the one real delete on the archiving path, and it cascades.** Everywhere else a
   * removed card is a row going quiet; here the row, its steps, its activity timeline and its
   * transcript go for good, and nothing puts them back but
   * `scripts/recover-deleted-tasks.mjs` and luck. That is the deliberate trade against the
   * other direction — archived rows accumulate at the rate the board loses cards, one row plus
   * its history apiece, with no ceiling — and the bound chosen is the age of the card rather
   * than the size of the pile. A "keep the newest N" cap prunes oldest-first exactly when the
   * pile is growing fastest, so a board that had just started haemorrhaging cards would
   * destroy the very rows somebody was about to go looking for. Six months of nobody looking
   * is a defensible reason to let go of a card; "four hundred others left after it" is not.
   */
  pruneArchivedBefore(cutoff: number): number;
  /**
   * Insert a new **mirrored** task, or update the existing one with the same id.
   *
   * Named for JIRA because JIRA had it first; `reconcileGitHubIssues` writes through the very
   * same method, and deliberately so. What it does is not tracker-specific — it refreshes the
   * tracker's own fields and leaves every column the tracker has never heard of alone (the
   * filing, the delegation, the plan, the steps, the status note, and whether the card is on
   * the board at all). A second copy for GitHub would be a second place for that list to fall
   * out of date. See the UPDATE below for the columns it deliberately omits.
   */
  upsertJiraTask(task: Task): Task;
  /**
   * Create an ad-hoc task (Phase 8): appended after existing tasks, `source: 'adhoc'`.
   *
   * `description` is the CARD's brief and lands in `externalDescription` — the field the
   * detail pane edits and the agent's prompt quotes (`Task.description` is a step's
   * brief, which a card never has). `projectTagId` files it under a project; the caller
   * checks the id, since the store does not know an agent project from a plan one.
   */
  createTask(
    projectId: string,
    input: {
      title: string;
      phase?: string;
      type?: TaskType | null;
      description?: string | null;
      projectTagId?: string | null;
    },
  ): Task | undefined;
  /** A card's steps, in execution order (empty for a card with no subtasks). */
  getSubtasks(parentId: string): Task[];
  /**
   * Append one step to a card (Phase 11). The step lives on the parent's board and
   * inherits the parent's agent project so the chain runs in the parent's repo, but
   * always in `bypassPermissions` — the human approved the plan, so the steps run
   * unattended — and with no model of its own, so it follows the project's execution
   * model rather than whatever the parent was planned on. Returns the created step, or
   * undefined if the parent is unknown, is itself a step, or the title is blank.
   *
   * `round` says which planning round the step belongs to (Phase 18), and only
   * `approvePlan` passes it — everyone else joins the round already in progress.
   */
  addSubtask(
    parentId: string,
    input: { title: string; description?: string | null; round?: number },
  ): Task | undefined;
  /** The card's newest planning round, or 0 when it has no steps yet. */
  maxSubtaskRound(parentId: string): number;
  /** Delete one task (and its transcript history) by id. */
  deleteTask(id: string): void;
  /** Re-parse a plan and reconcile it into the project's tasks; returns the result. */
  syncTasksFromPlan(projectId: string, parsed: ParsedTask[]): Task[];
  /**
   * Append one normalized session event to a task's persisted history (Phase 6),
   * so its transcript is viewable after the run ends or the app restarts.
   */
  appendTaskEvent(projectId: string, taskId: string, runId: string, event: SessionEvent): void;
  /** Load a task's full event history in order (all of its runs), for replay in the UI. */
  getTaskHistory(taskId: string): SessionEvent[];
  /**
   * Record one model call's token consumption (Performance dashboard). `costUsd` is
   * set only on the end-of-run reconciliation row so window cost can be summed without
   * double-counting tokens. Attribution is by `source`/`projectId`/`taskId`/`runId`.
   */
  appendTokenUsage(sample: UsageSample & { costUsd?: number | null }): void;
  /** Every usage sample with `createdAt >= sinceMs`, oldest first (for the rollup/series). */
  getUsageSamples(sinceMs: number): UsageSample[];
  /**
   * Total tokens recorded in `[fromMs, toMs)` — one SUM, not the rows.
   *
   * The quota bars ask this twice a tick and would otherwise drag a week of samples
   * across the IPC boundary to add up four numbers per row in the renderer.
   */
  getWindowTokens(fromMs: number, toMs: number): number;
  /** Total cost (USD) recorded since `sinceMs`, from the runs' `result` rows. */
  getWindowCost(sinceMs: number): number;
  /** Append a human progress comment to a task (Phase 9); returns the created entry. */
  addComment(projectId: string, taskId: string, body: string): TaskActivityEntry | undefined;
  /**
   * Append a message the human sent to the agent (Phase 12). Same row shape as a
   * comment under a different `kind`, so the timeline can tell "I wrote this down" from
   * "I said this to the agent" — and so a chat message is never deletable as a note.
   */
  addChatMessage(projectId: string, taskId: string, body: string): TaskActivityEntry | undefined;
  /**
   * File a progress note on a task's timeline. The caller also writes it onto the task
   * itself (`statusNote`/`statusNoteAt`) — the timeline keeps every one ever posted,
   * the task keeps only the latest, which is the one the board shows.
   */
  addStatusNote(projectId: string, taskId: string, body: string): TaskActivityEntry | undefined;
  /** Record a status change on a task's timeline (Phase 9). */
  recordStatusChange(
    projectId: string,
    taskId: string,
    from: TaskStatus | null,
    to: TaskStatus,
  ): void;
  /** Delete one comment by id. */
  deleteComment(commentId: number): void;
  /** The task's unified activity timeline: comments + status changes + AI transcript. */
  getTaskActivity(taskId: string): TaskActivityEntry[];
  /**
   * Persist (or clear, with `null`) the account-wide usage-limit gate so a limit
   * survives an app restart and the resume still happens after a relaunch (Phase 5).
   */
  saveLimitGate(state: LimitState | null): void;
  /** Load a persisted usage-limit gate, or null if none is in force. */
  loadLimitGate(): LimitState | null;
  /**
   * Persist the sign-in gate (`null` clears it). A dead credential outlives the process
   * that found it, so a restart must come back holding work rather than discovering the
   * same failure again one card at a time.
   */
  saveAuthGate(state: AuthState | null): void;
  /** Load a persisted sign-in gate, or null if the sign-in was believed good. */
  loadAuthGate(): AuthState | null;
  /**
   * Persist the whole {@link ParkedRun} side table — what a gate would have to be told
   * again to rebuild the runs it parked (see `parkedRun.ts`). An empty array clears it.
   *
   * Written whole rather than row by row: it is a handful of entries at most (one per
   * parked run that is a release or a chat reply), and the engine already holds it in
   * memory, so there is nothing to be gained by making the store diff it.
   */
  saveParkedRuns(runs: readonly ParkedRun[]): void;
  /** The persisted parked-run recipes; empty when nothing was parked (or the value rotted). */
  loadParkedRuns(): ParkedRun[];
  /** Current app settings, with any unset field filled from `DEFAULT_SETTINGS` (Phase 6). */
  getSettings(): AppSettings;
  /** Persist the full app settings object. */
  saveSettings(settings: AppSettings): void;
  /** Persist the JIRA token (opaque, already encrypted by the caller). */
  /** Every stored merge request, newest activity first. */
  listMergeRequests(): MergeRequest[];
  /** Insert or update one merge request (by its stable `gl-{repoId}-{number}` id). */
  upsertMergeRequest(mr: MergeRequest): void;
  /** Drop merge requests the forge no longer lists. */
  deleteMergeRequests(ids: readonly string[]): void;

  // --- The chain of execution (see `@shared/taskChain`). ---
  /** Every link on the board, oldest first. Small enough to hand over whole. */
  listTaskLinks(): TaskLink[];
  /**
   * Draw one arrow: `to` runs after `from`, subject to `gate`. Returns the created link,
   * or undefined when the pair is already linked — the caller has already run
   * `canLink`, and this last guard is the UNIQUE constraint, not a second opinion.
   */
  addTaskLink(fromTaskId: string, toTaskId: string, gate: LinkGate): TaskLink | undefined;
  /** Erase one arrow by id. No-op when it is already gone. */
  deleteTaskLink(id: string): void;
  /** Change what "after" means for one arrow, without redrawing it. */
  setTaskLinkGate(id: string, gate: LinkGate): TaskLink | undefined;

  // --- Native tickets (Phase 24). ---
  /**
   * Create a ticket in a ticket project, allocating its key.
   *
   * The bump of the project's counter and the INSERT are ONE transaction, so a refused
   * create never burns a number. The next number comes from the counter and **never** from
   * `MAX(ticketNumber)`: deleting `TM-500` must not make the next ticket `TM-500` again,
   * because a key is a permanent name.
   *
   * Undefined when the title is blank, the project is unknown or is not a ticket project,
   * or it has no prefix to name the ticket with — all four are "no ticket", not exceptions,
   * exactly as `addTaskLink` treats its own refusals.
   */
  createTicket(projectId: string, input: TicketInput): Task | undefined;

  /** Everyone the app knows about, oldest first. App-wide, not per project. */
  listPeople(): Person[];
  /** Add a person. Undefined when the name is blank. Setting `isMe` clears it elsewhere. */
  addPerson(input: PersonInput): Person | undefined;
  /** Edit one. Undefined for an unknown id. Setting `isMe` clears it from whoever had it. */
  updatePerson(id: string, patch: PersonPatch): Person | undefined;
  /**
   * Forget a person, and null every `assigneeId`/`reporterId` that pointed at them **in the
   * same transaction**.
   *
   * Explicitly, rather than through an `ON DELETE SET NULL` cascade, because a real cascade
   * would change task rows with no IPC event behind it: this renderer refreshes on
   * `project:tasksChanged`/`task:changed` and nothing polls, so the tickets would keep
   * showing a person the database has forgotten until something unrelated redrew them.
   */
  deletePerson(id: string): void;

  /** A project's milestones, earliest due first (undated last). */
  listMilestones(projectId: string): Milestone[];
  /** Add one. Undefined when the name is blank or the project is unknown. */
  addMilestone(projectId: string, input: MilestoneInput): Milestone | undefined;
  updateMilestone(id: string, patch: MilestonePatch): Milestone | undefined;
  /** Delete it and null the `milestoneId` of every ticket that pointed at it, in one
   *  transaction — see `deletePerson` for why this is not a cascade. */
  deleteMilestone(id: string): void;

  /** A project's label registry, oldest first — what gives a chip its colour. */
  listTicketLabels(projectId: string): TicketLabel[];
  /** Add one. Undefined when the name is blank, the project is unknown, or the name is
   *  already taken in that project (the unique index, matched case-blind). */
  addTicketLabel(projectId: string, input: TicketLabelInput): TicketLabel | undefined;
  /** Edit one. A RENAME rewrites the name on every ticket wearing it, in the same
   *  transaction — the tickets carry names, not ids. */
  updateTicketLabel(id: string, patch: TicketLabelPatch): TicketLabel | undefined;
  /** Delete it and strip the name from every ticket wearing it, in one transaction. */
  deleteTicketLabel(id: string): void;

  /** Every ticket link, oldest first. Small enough to hand over whole, like `listTaskLinks`. */
  listTicketLinks(): TicketLink[];
  /**
   * Document a relationship between two tickets. Undefined when either end is unknown, the
   * two are the same ticket, or that exact link already exists — the last is the UNIQUE
   * constraint rather than a second opinion, as with `addTaskLink`.
   */
  addTicketLink(fromTaskId: string, toTaskId: string, type: TicketLinkType): TicketLink | undefined;
  /** Erase one. No-op when it is already gone. */
  deleteTicketLink(id: string): void;

  // --- Attachments (see `@shared/attachments`). ---
  /** Every attachment on the board, oldest first — the whole list `attachment:list` hands over. */
  listAttachments(): TaskAttachment[];
  /** One task's own attachments, oldest first. A step's parent is NOT included. */
  attachmentsForTask(taskId: string): TaskAttachment[];
  /** One by id — how the protocol handler turns a URL into a file it may serve. */
  getAttachment(id: string): TaskAttachment | undefined;
  /**
   * Record a file that has already been copied into place. The id and `createdAt` are the
   * store's to assign; `name` is the caller's, already through `attachmentName` against
   * the names this task has.
   *
   * Undefined when the row is refused — an unknown task (foreign key) or a name already
   * taken (the unique index). Both are the caller having raced or skipped
   * `attachmentName`, and both are "no attachment" rather than an exception, exactly as
   * `addTaskLink` treats its own two rejections.
   */
  addAttachment(input: Omit<TaskAttachment, 'id' | 'createdAt'>): TaskAttachment | undefined;
  /**
   * Forget one. Returns the row that WAS there, because the bytes live outside the
   * database and the caller needs its `taskId` and `name` to unlink them — a plain
   * `void` would delete the only record of where the file is.
   */
  deleteAttachment(id: string): TaskAttachment | undefined;
  /**
   * Stamp (or clear) when the cloud last took these bytes — `TaskAttachment.cloudBlobAt`.
   *
   * `null` un-stamps it, which is not an error path but the ordinary consequence of a cache:
   * the cloud evicts under quota pressure, and a row that stops being true up there has to
   * stop claiming otherwise down here or nothing will ever push it again.
   *
   * Silent about an id that is not there — the attachment was removed while its upload was
   * in flight, which is a race with an obvious right answer (do nothing) rather than a
   * failure the uploader could act on.
   */
  markAttachmentUploaded(id: string, at: number | null): void;

  /**
   * Persist one open inbox item, with the kind-specific `context` its answer path needs
   * (a `PendingFailure`, a `PendingIntegration`, or null). Upserts, so re-raising the
   * same id is safe.
   */
  saveAttention(item: AttentionItem, context: unknown | null): void;
  /** Forget one item — it was answered, or its run ended. */
  deleteAttention(id: string): void;
  /** Every stored item, oldest first, with the context it was saved with. */
  listAttention(): Array<{ item: AttentionItem; context: unknown | null }>;
  /** Mark an MR's discussion read, or its pipeline/approval events seen. Returns it. */
  /** Rename an MR for this app only, or clear the override with null/blank. */
  setMergeRequestName(id: string, name: string | null): MergeRequest | undefined;
  markMergeRequestRead(id: string, at: number): MergeRequest | undefined;
  markMergeRequestEventsSeen(id: string, at: number): MergeRequest | undefined;
  /** The GitLab token ciphertext, beside the JIRA trio. */
  saveGitLabToken(value: string): void;
  loadGitLabToken(): string | null;
  clearGitLabToken(): void;
  /** Cache `GET /user` per instance, so notes can be attributed without a request each. */
  saveGitLabIdentity(cache: GitLabIdentityCache): void;
  loadGitLabIdentity(): GitLabIdentityCache | null;
  /** The GitHub token ciphertext — the same trio again, one forge over. */
  saveGitHubToken(value: string): void;
  loadGitHubToken(): string | null;
  clearGitHubToken(): void;
  /** Cache GitHub's `GET /user` per instance; see {@link saveGitLabIdentity}. */
  saveGitHubIdentity(cache: GitHubIdentityCache): void;
  loadGitHubIdentity(): GitHubIdentityCache | null;
  saveJiraToken(value: string): void;
  /** Load the stored JIRA token ciphertext, or null if none is set. */
  loadJiraToken(): string | null;
  /** Remove the stored JIRA token. */
  clearJiraToken(): void;
  /** The Task Manager personal access token ciphertext, alongside the JIRA/GitLab/GitHub trio. */
  saveCloudPat(value: string): void;
  loadCloudPat(): string | null;
  clearCloudPat(): void;
  /**
   * One-shot cleanup: if a pre-PAT vipper.iam refresh token is still on disk from before this
   * ticket, drop it — a dead credential should not sit encrypted on disk forever — and say so,
   * so `ipc.ts` can tell a returning signed-in user their sign-in was replaced rather than
   * silently going quiet. Returns `false` on every later call once the row is gone.
   */
  clearLegacyCloudSignIn(): boolean;
  /**
   * Cache the result of JIRA "Epic Link" field discovery so `/field` is queried once
   * per site rather than on every sync (see `jira/epicField.ts`).
   */
  saveJiraEpicField(cache: JiraEpicFieldCache): void;
  /** The cached epic-field discovery, or null if it has never run. */
  loadJiraEpicField(): JiraEpicFieldCache | null;
  /**
   * The same, for the per-instance "Sprint" custom field (see `jira/jiraSprint.ts`).
   * Cached separately so an instance with one field but not the other still resolves
   * whichever it has.
   */
  saveJiraSprintField(cache: JiraSprintFieldCache): void;
  /** The cached sprint-field discovery, or null if it has never run. */
  loadJiraSprintField(): JiraSprintFieldCache | null;
  /**
   * Cache `GET /myself` so the chat pane can tell your ticket comments from other
   * people's without a request per read (see `jira/identity.ts`). Keyed by site, like
   * the epic field above.
   */
  saveJiraIdentity(cache: JiraIdentityCache): void;
  /** The cached JIRA identity, or null if it has never been fetched. */
  loadJiraIdentity(): JiraIdentityCache | null;
  /**
   * Remember the **effective** JQL a sync ran — the user's filter with `openSprints()`
   * already folded in, since a sprint rolling over changes the question without anybody
   * editing a setting.
   *
   * Read by the next sync for one purpose: the removal guard stands down when the question
   * itself changed (see `jiraSync.guardRemovals`). A board is *meant* to turn over when the
   * sprint rolls, and a guard that fires on the one expected mass removal would teach the
   * human to ignore it.
   */
  saveJiraLastQuery(jql: string): void;
  /** The effective JQL of the last sync, or null if none has been recorded. */
  loadJiraLastQuery(): string | null;
  /**
   * The same, for GitHub's issue query. A separate row rather than a shared one: the two
   * syncs run independently, and one integration's query being edited says nothing about
   * whether the other's board is meant to turn over.
   */
  saveGitHubLastQuery(query: string): void;
  /** The issue query of the last GitHub sync, or null if none has been recorded. */
  loadGitHubLastQuery(): string | null;
  /**
   * Remember the main window's geometry so the next launch opens where the last one
   * closed. Written on a debounce while the window moves, so it stays cheap.
   */
  saveWindowState(state: SavedWindowState): void;
  /**
   * The raw saved geometry, unvalidated — the displays it refers to may not exist any
   * more, so `sanitizeWindowState` is what turns this into something to apply.
   */
  loadWindowState(): unknown;
  /**
   * The next batch of local `tasks`/`projects` changes for the cloud mirror (Phase 25),
   * shaped by `shapeCloudDelta` — collapsed to one row per entity, capped, deletes last.
   * `sinceSeq` is the cursor from the caller's last call (0 for a first sync).
   */
  getCloudDelta(sinceSeq: number, limit: number): CloudOutboxRow[];
  /** Drop outbox rows through `throughSeq` once the server has acked them. */
  pruneCloudOutbox(throughSeq: number): void;
  /**
   * Stable per-installation id sent as `SyncRequest.clientId` (Phase 25) — generated with
   * `randomUUID` on first read and persisted from then on, so presence and commands can
   * address this machine the same way across restarts. Never regenerated.
   */
  loadCloudClientId(): string;
  /** The opaque server cursor from the last successful `/v1/sync`, or null before the first one. */
  loadCloudCursor(): string | null;
  saveCloudCursor(cursor: string): void;
  /**
   * What this relayed command (by `CommandEnvelope.id`) ANSWERED the first time, or null if
   * it has never been applied. `cloudCommands.ts` checks this before dispatching, so a
   * redelivery — at-least-once is all the poll loop guarantees — is replayed rather than
   * re-executed.
   *
   * The ledger stores the answer rather than a boolean, and that distinction is load-bearing
   * now that redelivery actually happens: a redelivered `task:run` on a card that is running
   * BECAUSE OF THAT VERY COMMAND would re-enter the scheduler and answer the browser
   * "already running" for a command that had succeeded.
   */
  getCloudCommandOutcome(id: string): StoredCloudOutcome | null;
  /**
   * Record a relayed command's outcome: applied, pending an ack on the next `/v1/sync`, and
   * — when `awaited` — pending a RESULT on it too.
   *
   * `awaited` is false for the three v1 edit kinds, whose effect the web app observes
   * through the mirror and whose return value nothing is holding a promise for. Those are
   * written as already-sent, because there is nothing to send.
   */
  recordCloudCommandApplied(id: string, outcome: StoredCloudOutcome, awaited: boolean): void;
  /** Ids applied (or rejected) since the last successful ack — goes out as the next
   *  `SyncRequest.ackedCommandIds`. */
  getPendingCloudAcks(): string[];
  /** Mark ids as acked once a `/v1/sync` carrying them has succeeded. */
  markCloudAcksSent(ids: readonly string[]): void;
  /** The results not yet delivered to the server — goes out as `SyncRequest.results`. */
  getPendingCloudResults(): PendingCloudResult[];
  /** Mark results as sent once a `/v1/sync` carrying them has succeeded — mirrors
   *  {@link markCloudAcksSent}, and is a separate moment from it for the same reason
   *  `appliedAt` and `ackedAt` are two columns. */
  markCloudResultsSent(ids: readonly string[]): void;
  /**
   * Run `fn` inside one `better-sqlite3` transaction, committing its return value or rolling
   * every write in it back on a throw.
   *
   * **`fn` must be synchronous, and the compiler now says so.** `better-sqlite3` transactions
   * are, and handing this an `async` function silently does the wrong thing: it returns a
   * Promise, the transaction commits at the first `await`, and every write after that point
   * runs untransacted with nothing red anywhere. `applyCloudCommands` used to wrap its whole
   * batch in one of these and could not become async without hitting exactly that; it now
   * records each command's outcome in its own tiny synchronous transaction instead, and
   * leaves the atomicity of the work itself to the handler that already chose it.
   *
   * That trap was a docstring for one release, which is the same bet `RELAY_POLICY` declined
   * to make: a warning is read once by whoever writes the call and never again by whoever
   * makes it async two years later. So the rule is a type. `T` is inferred from `fn` first,
   * and a `T` that turns out to be a promise gives the rest parameter a one-element tuple —
   * an argument nobody can supply, so the call does not compile and the tuple's own label
   * says why. A sync `fn` gives it `[]` and nothing changes at any existing call site.
   *
   * A second, refusing OVERLOAD would not have worked, which is worth recording: overload
   * resolution checks arity before parameter types, so a one-argument call skips a
   * two-parameter overload entirely and lands on the permissive one. The ban has to ride on
   * the signature that actually matches.
   *
   * The failure this prevents leaves nothing red at runtime, so it is caught at build time
   * or not at all.
   */
  runInTransaction<T>(fn: () => T, ...betterSqlite3IsSynchronous: SyncOnly<T>): T;
  /**
   * Is the underlying handle still usable? Asked by the ONE caller that legitimately races
   * `close()` — the window-geometry flush, driven by an OS event whose timing we do not
   * control (`windowFlush.ts`). Every other method throws on use-after-close on purpose:
   * a store that silently swallowed writes would hide exactly this class of bug.
   */
  isOpen(): boolean;
  /** Close the handle. Idempotent — quit calls teardown from more than one place. */
  close(): void;
}

/**
 * One relayed command's stored answer — enough to REPLAY it without running anything.
 *
 * `taskId`/`projectId` are what the desktop's own event fan-out needs (which card changed,
 * which board to refresh); `ok`/`reason`/`value` are what the wire needs. Both, because a
 * redelivery has to reproduce both halves.
 */
export interface StoredCloudOutcome {
  taskId: string | null;
  projectId: string | null;
  ok: boolean;
  reason: string | null;
  /** What the channel returned, for an `ipc-invoke`. Absent for the edit kinds. */
  value?: unknown;
}

/** A stored outcome plus the command it belongs to, on its way onto the wire. */
export interface PendingCloudResult extends StoredCloudOutcome {
  commandId: string;
}

/**
 * Clean up a user-entered list of JIRA epic keys: trim, drop blanks, upper-case
 * (JIRA keys are case-insensitive but canonically upper), and de-duplicate — so
 * epic → agent-project matching later compares like with like.
 */
function normalizeEpicKeys(keys: string[] | undefined): string[] {
  if (!keys) return [];
  const seen = new Set<string>();
  for (const key of keys) {
    const trimmed = key.trim().toUpperCase();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Open (or create) the database at `dbPath` and return the store API.
 * `join(app.getPath('userData'), 'orchestrator.db')` is the production path.
 */
export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // better concurrency + crash safety
  db.pragma('foreign_keys = ON'); // so deleting a project cascades to its tasks

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      path                  TEXT NOT NULL,
      planPath              TEXT NOT NULL,
      defaultModel          TEXT NOT NULL,
      planningModel         TEXT,
      defaultPermissionMode TEXT NOT NULL,
      concurrency           INTEGER NOT NULL DEFAULT 1,
      useWorktrees          INTEGER NOT NULL DEFAULT 1,
      baseBranch            TEXT,
      writeBackPlan         INTEGER NOT NULL DEFAULT 0,
      autoRelease           INTEGER NOT NULL DEFAULT 0,
      autoCreatePr          INTEGER NOT NULL DEFAULT 0,
      autoIntegrate         INTEGER,
      planAligned           INTEGER NOT NULL DEFAULT 0,
      kind                  TEXT NOT NULL DEFAULT 'plan',
      jiraEpicKeys          TEXT,
      -- A ticket project's key prefix ('TM'), NULL for every other kind. COLLATE NOCASE
      -- for the reason task_attachments.name has it: the uniqueness a human means by "that
      -- prefix is taken" is case-blind, and TM and tm are the same project's key to
      -- everyone but SQLite. Its partial unique index is created after the ALTERs below.
      ticketPrefix          TEXT COLLATE NOCASE,
      -- The key allocator. Not a field on Project — see ProjectRow.ticketSeq.
      ticketSeq             INTEGER NOT NULL DEFAULT 0,
      target                TEXT NOT NULL DEFAULT 'local',
      instructions          TEXT,
      color                 TEXT,
      createdAt             INTEGER NOT NULL,
      -- Bumped by a trigger on every write (see below), never by a call site — the
      -- point of the cloud mirror (Phase 25): a delta reader needs "what moved" and
      -- a ~90-method Store interface is exactly the kind of surface a manual touch
      -- gets forgotten on.
      updatedAt             INTEGER
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                     TEXT PRIMARY KEY,
      projectId              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phase                  TEXT NOT NULL,
      title                  TEXT NOT NULL,
      status                 TEXT NOT NULL,
      sessionId              TEXT,
      "order"                INTEGER NOT NULL,
      source                 TEXT NOT NULL DEFAULT 'plan',
      dependsOn              TEXT,
      isContract             INTEGER NOT NULL DEFAULT 0,
      isScaffold             INTEGER NOT NULL DEFAULT 0,
      type                   TEXT,
      parentTaskId           TEXT,
      description            TEXT,
      statusNote             TEXT,
      statusNoteAt           INTEGER,
      externalSource         TEXT,
      externalKey            TEXT,
      externalId             TEXT,
      externalUrl            TEXT,
      externalStatus         TEXT,
      externalStatusCategory TEXT,
      externalPriority       TEXT,
      externalType           TEXT,
      externalLabel          TEXT,
      externalParentKey      TEXT,
      externalEpicName       TEXT,
      externalSprint         TEXT,
      externalDescription    TEXT,
      preBlockStatus         TEXT,
      preRunStatus           TEXT,
      retainedSince          INTEGER,
      archivedAt             INTEGER,
      archivedReason         TEXT,
      lastReadCommentAt      INTEGER,
      latestCommentAt        INTEGER,
      projectTagId           TEXT,
      agentProjectId         TEXT,
      agentMode              TEXT,
      agentModel             TEXT,
      agentPlan              TEXT,
      agentBranch            TEXT,
      planRound              INTEGER,
      landedAt               INTEGER,
      chainLandedAt          INTEGER,
      workedAt               INTEGER,
      stoppedAt              INTEGER,
      autoRelease            INTEGER,
      autoCreatePr           INTEGER,
      autoIntegrate          INTEGER,
      -- Native tickets (Phase 24). epicTaskId / milestoneId / assigneeId / reporterId are
      -- plain TEXT with NO foreign key, exactly as parentTaskId already is: foreign_keys is
      -- ON above, so a declared cascade really fires, and one here would change task rows
      -- with no IPC event behind it. Their owners null them explicitly instead.
      ticketKey              TEXT,
      ticketNumber           INTEGER,
      issueType              TEXT,
      epicTaskId             TEXT,
      milestoneId            TEXT,
      labels                 TEXT,
      -- REAL, not INTEGER: half-points exist and "half a day" is the commonest estimate
      -- there is. Nullable and never 0-defaulted — see Task.storyPoints.
      storyPoints            REAL,
      estimateDays           REAL,
      startAt                INTEGER,
      dueAt                  INTEGER,
      assigneeId             TEXT,
      reporterId             TEXT,
      -- Same trigger-touched column as projects.updatedAt above, for the same reason.
      updatedAt              INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId, "order");
    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      taskId    TEXT NOT NULL,
      runId     TEXT NOT NULL,
      event     TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(taskId, id);
    CREATE TABLE IF NOT EXISTS task_activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      taskId     TEXT NOT NULL,
      kind       TEXT NOT NULL,           -- 'comment' | 'status'
      body       TEXT,                    -- comment text (kind = 'comment')
      fromStatus TEXT,                    -- prior status (kind = 'status')
      toStatus   TEXT,                    -- new status  (kind = 'status')
      createdAt  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_activity_task ON task_activity(taskId, id);
    -- Token accounting (Performance dashboard). One row per recorded model call's
    -- token cost. Deliberately has NO projectId foreign key / cascade (unlike
    -- task_events): orchestrator rows carry a null taskId, and usage history should
    -- survive a plan re-sync AND a project delete — it is a record of spend, not of
    -- a task. projectId/taskId are plain nullable TEXT for that reason.
    CREATE TABLE IF NOT EXISTS token_usage (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source              TEXT NOT NULL,          -- 'task' | 'orchestrator'
      projectId           TEXT,                   -- null only if the project is unknown
      taskId              TEXT,                   -- null for orchestrator/aux runs
      runId               TEXT NOT NULL,
      inputTokens         INTEGER NOT NULL,
      outputTokens        INTEGER NOT NULL,
      cacheCreationTokens INTEGER NOT NULL,
      cacheReadTokens     INTEGER NOT NULL,
      totalTokens         INTEGER NOT NULL,
      costUsd             REAL,                   -- set only on result-derived cost rows
      createdAt           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(createdAt);
    CREATE INDEX IF NOT EXISTS idx_token_usage_project ON token_usage(projectId, createdAt);
    -- GitLab merge requests, matched to board cards by the JIRA key in their branch,
    -- title or description. A NEW table, so nothing to migrate.
    --
    -- taskId is nullable and NOT unique: an MR whose ticket is not on the board keeps
    -- its row (and therefore its read markers) as an orphan and is re-matched on every
    -- sync, and one ticket can perfectly well have several MRs.
    --
    -- Two independent read markers on purpose. lastReadAt clears an unread comment;
    -- lastEventSeenAt clears a red pipeline or a dropped approval. One marker would
    -- mean that opening an MR after a failed pipeline also silenced a comment landing a
    -- second later — the same pairing the JIRA side uses.
    CREATE TABLE IF NOT EXISTS merge_requests (
      id                TEXT PRIMARY KEY,   -- gl-{repoId}-{number}
      taskId            TEXT,               -- NULL = no board card claims it
      openedForTaskId   TEXT,               -- the card WE opened it for; NULL = a sync found it
      provider          TEXT NOT NULL,      -- 'gitlab' | 'github'; one table holds both
      repoId            INTEGER NOT NULL,   -- the forge's own id for the repository
      projectPath       TEXT NOT NULL,
      "number"          INTEGER NOT NULL,   -- !12 on GitLab, #12 on GitHub
      title             TEXT NOT NULL,
      displayName       TEXT,               -- yours, never the forge's; NULL = use the title
      webUrl            TEXT NOT NULL,
      sourceBranch      TEXT NOT NULL,
      targetBranch      TEXT NOT NULL,
      state             TEXT NOT NULL,
      draft             INTEGER NOT NULL,
      pipelineStatus    TEXT NOT NULL,
      pipelineStages    TEXT,               -- JSON array of {name,status}; NULL = not read
      pipelineUrl       TEXT,
      approvalsRequired INTEGER,            -- NULL = the instance would not say
      approvalsGiven    INTEGER NOT NULL,
      changesRequested  INTEGER NOT NULL,
      detailedMergeStatus TEXT,             -- GitLab's own verdict; NULL = not read
      hasConflicts      INTEGER NOT NULL DEFAULT 0,
      issueKeys         TEXT NOT NULL,      -- JSON array
      latestNoteAt      INTEGER,
      lastReadAt        INTEGER,
      lastEventAt       INTEGER,
      lastEventSeenAt   INTEGER,
      updatedAt         INTEGER NOT NULL,
      syncedAt          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mr_task ON merge_requests(taskId);
    -- Open Attention-inbox items. A NEW table, so nothing to migrate.
    --
    -- These lived only in the Scheduler's memory until Phase 17 made an agent's question
    -- BLOCKING. Once a run genuinely stops until a human answers, losing the question on
    -- restart loses the reason it stopped — the app would come back up with a parked task
    -- and no way to learn what it wanted.
    --
    -- What a restart can DO with a row varies by kind, and rehydrateAttention decides
    -- that rather than pretending uniformity: a failed task or a merge conflict is pure
    -- stored context any later call can act on, while a permission request is a promise
    -- held inside a socket handler in a process that no longer exists.
    --
    -- The context column carries the kind-specific blob (PendingFailure /
    -- PendingIntegration) the answer path needs, so a rehydrated item is answerable
    -- rather than merely visible.
    CREATE TABLE IF NOT EXISTS attention_items (
      id           TEXT PRIMARY KEY,
      runId        TEXT NOT NULL,
      taskId       TEXT NOT NULL,
      projectId    TEXT NOT NULL,
      taskTitle    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      options      TEXT NOT NULL,   -- JSON string[]
      toolName     TEXT,
      reason       TEXT,
      worktreePath TEXT,
      branch       TEXT,
      plan         TEXT,
      steps        TEXT,            -- JSON string[]
      questions    TEXT,            -- JSON AttentionQuestion[]
      context      TEXT,            -- JSON, kind-specific; NULL when there is none
      createdAt    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attention_task ON attention_items(taskId);
    -- The chain of execution: one row per arrow drawn between two cards, saying the
    -- second runs after the first (see shared/taskChain.ts for what each gate means).
    -- A NEW table, so nothing to migrate.
    --
    -- A table rather than a JSON column on tasks, for two reasons. ON DELETE CASCADE:
    -- deleting a card cannot leave an arrow pointing at nothing, which a JSON array of
    -- ids would do silently and forever. And both directions are queried — the runner
    -- asks "who follows me", the board asks "what am I waiting on" — so both ends get an
    -- index. foreign_keys = ON is set above, so the cascade actually fires.
    --
    -- UNIQUE(fromTaskId, toTaskId) makes the same arrow undrawable twice; the reverse
    -- arrow is refused as a cycle rather than by the schema.
    CREATE TABLE IF NOT EXISTS task_links (
      id          TEXT PRIMARY KEY,
      fromTaskId  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      toTaskId    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      gate        TEXT NOT NULL DEFAULT 'after-merge',   -- 'after-merge' | 'stacked'
      createdAt   INTEGER NOT NULL,
      UNIQUE (fromTaskId, toTaskId)
    );
    CREATE INDEX IF NOT EXISTS idx_task_links_from ON task_links(fromTaskId);
    CREATE INDEX IF NOT EXISTS idx_task_links_to   ON task_links(toTaskId);
    -- The files a card carries (see shared/attachments.ts). A step is a task row, so a
    -- step's attachments are the same shape hung off a different taskId.
    -- A NEW table, so nothing to migrate.
    --
    -- Follows task_links above: a real foreign key with ON DELETE CASCADE, because
    -- deleting a card must not leave a row pointing at nothing — and because that cascade
    -- is what makes "delete the card, delete its files" a fact of the schema rather than a
    -- step someone has to remember. (The BYTES are not reachable by a cascade; whoever
    -- deletes rows unlinks the directory, which is why deleteAttachment hands the row back.)
    --
    -- No path column. The absolute path is join(userData, 'attachments', taskId, name),
    -- so it cannot drift when a profile is restored under another Windows account.
    -- UNIQUE (taskId, name) is therefore doing two jobs at once: it is the addressing rule
    -- that makes an @name unambiguous AND the storage rule that keeps the filenames
    -- collision-free. Its index has taskId as its leftmost column, so it already serves
    -- "the attachments of this task" — a separate index on taskId would be dead weight.
    --
    -- COLLATE NOCASE on the name because that unique index stands in for the filesystem's
    -- own uniqueness, and NTFS says A.png and a.png are the same file. NOCASE folds ASCII
    -- only, which is exactly the character set attachmentName() emits.
    --
    -- cloudBlobAt is the one column here that is not about this machine: epoch ms of the
    -- last successful push of these bytes to the cloud, NULL for "not up there". It is a
    -- cache receipt, not a fact about the file — the cloud evicts under quota pressure, and
    -- clearing this is how the desktop learns to push again.
    CREATE TABLE IF NOT EXISTS task_attachments (
      id          TEXT PRIMARY KEY,
      taskId      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name        TEXT NOT NULL COLLATE NOCASE, -- the @token, and the file's name on disk
      fileName    TEXT NOT NULL,                -- the name it arrived with, for the chip
      mimeType    TEXT,                         -- NULL when the suffix said nothing
      size        INTEGER NOT NULL,
      createdAt   INTEGER NOT NULL,
      cloudBlobAt INTEGER,                      -- NULL until something pushes the bytes up
      UNIQUE (taskId, name)
    );
    -- Native tickets (Phase 24). Four NEW tables, so nothing to migrate.
    --
    -- People are APP-WIDE, not per project: a person works across projects, and filing the
    -- same human once per project would make "assigned to me" a question with several
    -- answers. No foreign key from tasks — see the tasks block above for why.
    --
    -- The partial unique index is what makes "me" singular. It covers only the rows where
    -- isMe = 1, so the many zeroes never collide; setting it on somebody new clears it from
    -- whoever had it, in the same transaction, or this index refuses the write.
    CREATE TABLE IF NOT EXISTS people (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      email     TEXT,
      -- Stored, not derived: two "Anna K"s need different initials and only a human can
      -- say which is which.
      initials  TEXT NOT NULL,
      color     TEXT,
      isMe      INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_me ON people(isMe) WHERE isMe = 1;
    -- A dated goal a project's tickets are planned against. A real table rather than a
    -- string on the ticket, because a milestone is drawn on the timeline whether or not any
    -- ticket points at it — a date nobody has planned work for yet is exactly the one worth
    -- seeing. Cascades with its project, which is one of the two places a real cascade is
    -- kept: the renderer re-reads the whole list when a project goes.
    CREATE TABLE IF NOT EXISTS milestones (
      id          TEXT PRIMARY KEY,
      projectId   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      dueAt       INTEGER,
      color       TEXT,
      closed      INTEGER NOT NULL DEFAULT 0,
      createdAt   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(projectId, dueAt);
    -- The label registry: what gives a label its colour and the filter dropdown its list.
    -- The TICKETS carry names rather than ids (tasks.labels, a JSON array), so deleting a
    -- row here degrades a chip to grey instead of dangling — and so the board read, the
    -- hottest query in the app, needs no join and no per-render regroup.
    --
    -- COLLATE NOCASE on the name for the same reason the prefix has it: Backend and backend
    -- are one label to everybody but SQLite, and a ticket wearing both would draw two chips
    -- and survive exactly one of the two deletes.
    CREATE TABLE IF NOT EXISTS ticket_labels (
      id        TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name      TEXT NOT NULL COLLATE NOCASE,
      color     TEXT,
      createdAt INTEGER NOT NULL,
      UNIQUE (projectId, name)
    );
    -- Documented relationships between tickets, named APART from task_links on purpose.
    -- task_links is the chain of execution — an arrow there gates when a run may start
    -- (see shared/taskChain.ts). One of these gates nothing at all. Conflating them would
    -- mean marking a ticket "duplicates" another and having the scheduler refuse to start
    -- it.
    --
    -- One row per link, DIRECTED, with an inverse lookup — not two rows. Two would double
    -- every write and make "delete this link" ambiguous. Both ends are indexed, exactly as
    -- task_links indexes both, so the inward query is as cheap as the outward one.
    --
    -- The cascade to tasks is the second place a real one is kept: a deleted ticket must
    -- not leave an arrow pointing at nothing, and the renderer re-reads the whole link list
    -- when a card goes anyway.
    CREATE TABLE IF NOT EXISTS ticket_links (
      id         TEXT PRIMARY KEY,
      fromTaskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      toTaskId   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type       TEXT NOT NULL DEFAULT 'relates',
      createdAt  INTEGER NOT NULL,
      UNIQUE (fromTaskId, toTaskId, type)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_links_from ON ticket_links(fromTaskId);
    CREATE INDEX IF NOT EXISTS idx_ticket_links_to   ON ticket_links(toTaskId);
    -- The client's outgoing half of the cloud mirror (Phase 25): one row per write to
    -- tasks/projects, append-only, filled by triggers rather than by any of the
    -- ~90 Store methods that touch those tables (see the triggers below). A NEW
    -- table, so nothing to migrate.
    --
    -- seq is the client's own sync cursor — getCloudDelta(sinceSeq, ...) reads
    -- forward from it and pruneCloudOutbox drops what the server has acked.
    --
    -- No deletedAt column anywhere, and none needed: a row with op = 'delete' IS
    -- the tombstone, including the ones a projects -> tasks cascade produces —
    -- SQLite fires a table's own AFTER DELETE triggers for a cascaded delete exactly
    -- as it would for an explicit one, so no call site has to know the cascade
    -- happened for the mirror to hear about it.
    CREATE TABLE IF NOT EXISTS cloud_outbox (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      entity   TEXT    NOT NULL,   -- 'task' | 'project'
      entityId TEXT    NOT NULL,
      op       TEXT    NOT NULL,   -- 'insert' | 'update' | 'delete'
      at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_outbox_entity ON cloud_outbox(entity, entityId);
    -- The client's incoming half (Phase 25's "Apply queued cloud commands on the client"):
    -- one row per CommandEnvelope.id this Client has applied, so a redelivered command —
    -- at-least-once delivery is the only guarantee cloudPoller.ts's poll loop gives — is
    -- a no-op the second time rather than a double edit. appliedAt and ackedAt are two
    -- different moments: applying happens inside the SAME transaction as the Store mutation
    -- it maps to (cloudCommands.ts), but the ack only reaches the server on the NEXT
    -- /v1/sync call, so ackedAt is null for however long that takes. Rows are kept, not
    -- pruned, once acked — the ledger is small (one row per command ever relayed to this
    -- Client) and an audit trail of what landed costs nothing to keep.
    -- result and resultSentAt are Phase 26's: a relayed ipc-invoke has an ANSWER a browser
    -- is holding a promise for, so the ledger stores what each command returned rather than
    -- merely that it ran. That is what makes a redelivery a REPLAY: re-running task:run for
    -- a card that is running because of that very command would answer "already running"
    -- for a command that had in fact succeeded. resultSentAt is a third moment after
    -- appliedAt and ackedAt — the ack says the command is off the server's queue, the result
    -- says what it answered, and they ride the same request but are not the same fact. A
    -- command nobody awaits is written already-sent; there is nothing to send.
    -- (No backticks in this block: it is inside a template literal.)
    CREATE TABLE IF NOT EXISTS cloud_applied_commands (
      id           TEXT PRIMARY KEY,
      appliedAt    INTEGER NOT NULL,
      ackedAt      INTEGER,
      result       TEXT,
      resultSentAt INTEGER
    );
  `);

  // Migrate ledgers written before the relay stored results. Every existing row is one of
  // the three v1 edit kinds, applied under the old rule where "applied" was the whole
  // answer — so a NULL `result` reads back as "applied, nothing to replay", and
  // `resultSentAt` defaults to the applied time because none of them was ever awaited.
  {
    const ledgerColumns = db.prepare(`PRAGMA table_info(cloud_applied_commands)`).all() as Array<{
      name: string;
    }>;
    if (!ledgerColumns.some((c) => c.name === 'result')) {
      db.exec(`ALTER TABLE cloud_applied_commands ADD COLUMN result TEXT`);
    }
    if (!ledgerColumns.some((c) => c.name === 'resultSentAt')) {
      db.exec(`ALTER TABLE cloud_applied_commands ADD COLUMN resultSentAt INTEGER`);
      db.exec(`UPDATE cloud_applied_commands SET resultSentAt = appliedAt`);
    }
  }

  // Migrate databases created before Phase 3 added the write-back column.
  const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  if (!projectColumns.some((c) => c.name === 'writeBackPlan')) {
    db.exec(`ALTER TABLE projects ADD COLUMN writeBackPlan INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before agent projects. Every existing row is a legacy
  // plan-driven project, so the 'plan' default is correct for them, and only agent
  // projects ever carry epic keys (NULL reads back as []).
  if (!projectColumns.some((c) => c.name === 'kind')) {
    db.exec(`ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'plan'`);
  }
  if (!projectColumns.some((c) => c.name === 'jiraEpicKeys')) {
    db.exec(`ALTER TABLE projects ADD COLUMN jiraEpicKeys TEXT`);
  }

  // Migrate databases created before the WSL execution target. Every existing project
  // ran on the machine showing the window, so 'local' is exactly right for them and
  // nothing about how they run changes. Standing instructions start empty (NULL → '').
  if (!projectColumns.some((c) => c.name === 'target')) {
    db.exec(`ALTER TABLE projects ADD COLUMN target TEXT NOT NULL DEFAULT 'local'`);
  }
  if (!projectColumns.some((c) => c.name === 'instructions')) {
    db.exec(`ALTER TABLE projects ADD COLUMN instructions TEXT`);
  }

  // Migrate databases created before a project could NAME its integration branch. NULL
  // reads back as '' = "whatever the checkout is on", which is precisely what every
  // existing project did, so nothing about how they integrate changes until it's set.
  if (!projectColumns.some((c) => c.name === 'baseBranch')) {
    db.exec(`ALTER TABLE projects ADD COLUMN baseBranch TEXT`);
  }

  // Migrate databases created before per-project colours. NULL reads back as '' — no
  // colour, hence no stripe — which is exactly how every board looked before.
  if (!projectColumns.some((c) => c.name === 'color')) {
    db.exec(`ALTER TABLE projects ADD COLUMN color TEXT`);
  }

  // Migrate databases created before auto-release. 0 = off for every existing project,
  // which is what they all did: a merge finished the card and nothing else happened.
  if (!projectColumns.some((c) => c.name === 'autoRelease')) {
    db.exec(`ALTER TABLE projects ADD COLUMN autoRelease INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before a project could ask for a PR instead of a merge. 0 =
  // off for every existing project, which is exactly what they all did: a finished card's
  // branch was merged locally or left for the Merge button, and nothing was ever pushed.
  if (!projectColumns.some((c) => c.name === 'autoCreatePr')) {
    db.exec(`ALTER TABLE projects ADD COLUMN autoCreatePr INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before a project could decide auto-merge for itself. NULL —
  // "follow the app-wide setting" — is deliberately NOT a `DEFAULT 0`: every existing
  // project was already doing exactly what `AppSettings.autoIntegrate` said, and writing a
  // 0 here would pin them all to "never" the instant the global was turned on.
  if (!projectColumns.some((c) => c.name === 'autoIntegrate')) {
    db.exec(`ALTER TABLE projects ADD COLUMN autoIntegrate INTEGER`);
  }

  // Migrate databases created before a project could plan on a different model than it runs
  // on. Deliberately no `NOT NULL DEFAULT`: NULL is the value that means "same as execution",
  // so every existing project plans exactly as it did until a human names a model.
  if (!projectColumns.some((c) => c.name === 'planningModel')) {
    db.exec(`ALTER TABLE projects ADD COLUMN planningModel TEXT`);
  }

  // Migrate databases created before native ticket projects (Phase 24). NULL on every
  // existing row — no project had a key prefix, and NULL rather than '' is what lets the
  // partial unique index below ignore them all instead of finding one collision per row.
  // The allocator starts at 0, so the first ticket any project ever issues is number 1.
  if (!projectColumns.some((c) => c.name === 'ticketPrefix')) {
    db.exec(`ALTER TABLE projects ADD COLUMN ticketPrefix TEXT COLLATE NOCASE`);
  }
  if (!projectColumns.some((c) => c.name === 'ticketSeq')) {
    db.exec(`ALTER TABLE projects ADD COLUMN ticketSeq INTEGER NOT NULL DEFAULT 0`);
  }
  // Created after the ALTER, not in the schema block above, for the reason
  // `idx_tasks_parent` is: on an older database the column does not exist until the ALTER
  // has run. PARTIAL, so the projects with no prefix — which is every existing one — do not
  // all collide on NULL.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_ticket_prefix
       ON projects(ticketPrefix) WHERE ticketPrefix IS NOT NULL`,
  );

  // Migrate databases created before the cloud mirror (Phase 25). NULL on every
  // pre-existing row until its first write after upgrade — the triggers created
  // below fill it from there, exactly as `createdAt` was never backfilled either.
  if (!projectColumns.some((c) => c.name === 'updatedAt')) {
    db.exec(`ALTER TABLE projects ADD COLUMN updatedAt INTEGER`);
  }

  // A safety net for the `kind` column's retirement: a project's capabilities now come
  // from its fields (`hasPlan`/`hasRepo`/`ownsTickets` in `@shared/model`), not from this
  // legacy label, so a plan project with a real directory but a blank `planPath` would
  // silently drop off the Projects tab and stop being watched the moment `hasPlan` — not
  // `kind` — decides that question. `addProject` has always defaulted `planPath` for a
  // plan-kind project, so no row this build ever wrote should match, but the WHERE clause
  // makes the fix idempotent regardless: once backfilled, `planPath` is no longer blank,
  // so a legacy row is never rewritten twice and a project never lands here except by an
  // anomaly this exists to correct.
  const planlessPlanRows = db
    .prepare(
      `SELECT id, path FROM projects WHERE kind = 'plan' AND path <> '' AND (planPath IS NULL OR planPath = '')`,
    )
    .all() as Array<{ id: string; path: string }>;
  if (planlessPlanRows.length > 0) {
    const backfillPlanPath = db.prepare(`UPDATE projects SET planPath = ? WHERE id = ?`);
    for (const row of planlessPlanRows) {
      backfillPlanPath.run(hostJoin(row.path, 'plan.md'), row.id);
    }
  }

  // Migrate databases created before an attachment's bytes could be pushed to the cloud
  // (Phase 26). NULL on every pre-existing row is exactly right — nothing has ever been
  // pushed — and `cloudAttachmentUploader`'s backfill is what walks them afterwards.
  const attachmentColumns = db.prepare(`PRAGMA table_info(task_attachments)`).all() as Array<{
    name: string;
  }>;
  if (!attachmentColumns.some((c) => c.name === 'cloudBlobAt')) {
    db.exec(`ALTER TABLE task_attachments ADD COLUMN cloudBlobAt INTEGER`);
  }

  // Migrate databases created before per-stage pipeline detail. NULL reads back as [], and
  // the UI falls back to the single overall status for those rows — exactly how every MR
  // looked before. The next sync of an MR fills its stages in.
  const mrColumns = db.prepare(`PRAGMA table_info(merge_requests)`).all() as Array<{
    name: string;
  }>;
  if (!mrColumns.some((c) => c.name === 'pipelineStages')) {
    db.exec(`ALTER TABLE merge_requests ADD COLUMN pipelineStages TEXT`);
  }

  // Migrate databases created before an MR could be renamed locally. NULL means "use the
  // upstream title", which is what every existing row was already doing.
  if (!mrColumns.some((c) => c.name === 'displayName')) {
    db.exec(`ALTER TABLE merge_requests ADD COLUMN displayName TEXT`);
  }

  // Migrate databases from before the board asked GitLab whether a merge would actually
  // succeed. NULL reads as "not read yet", which is honest — the next sync fetches it, and
  // until then `mergeBlockers` falls back to what the row already knows.
  if (!mrColumns.some((c) => c.name === 'detailedMergeStatus')) {
    db.exec(`ALTER TABLE merge_requests ADD COLUMN detailedMergeStatus TEXT`);
  }
  if (!mrColumns.some((c) => c.name === 'hasConflicts')) {
    db.exec(`ALTER TABLE merge_requests ADD COLUMN hasConflicts INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases from before this app could OPEN a merge request itself. NULL on every
  // existing row is the truth about all of them — each was discovered by a sync and is
  // matched to its card by key, which is the behaviour this column does not change. It is
  // only the ones the Create PR button opens from here on that remember their card.
  if (!mrColumns.some((c) => c.name === 'openedForTaskId')) {
    db.exec(`ALTER TABLE merge_requests ADD COLUMN openedForTaskId TEXT`);
  }

  // Migrate databases created while merge requests were GitLab's alone. A pure RENAME:
  // every existing row is a GitLab MR and stays exactly what it was — only the two columns
  // whose names said "GitLab" now say what they hold for either forge. Guarded on the OLD
  // name rather than the new one so a fresh database (whose DDL above already has them)
  // skips it, and so a half-applied pair still finishes.
  if (mrColumns.some((c) => c.name === 'gitlabProjectId')) {
    db.exec(`ALTER TABLE merge_requests RENAME COLUMN gitlabProjectId TO repoId`);
  }
  if (mrColumns.some((c) => c.name === 'iid')) {
    db.exec(`ALTER TABLE merge_requests RENAME COLUMN iid TO "number"`);
  }

  // Migrate databases created before Phase 8 added the task source column. Existing
  // tasks all came from plans, so the 'plan' default is correct for them.
  const taskColumns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  if (!taskColumns.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'plan'`);
  }

  // Migrate databases created before `@needs:` dependencies. Existing tasks have no
  // declared prerequisites, so a NULL (read as `[]`) is correct — no gating changes.
  if (!taskColumns.some((c) => c.name === 'dependsOn')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN dependsOn TEXT`);
  }

  // Migrate databases created before contract-first execution (Phase C). Existing
  // tasks predate the `@contract` marker, so 0 (not a contract task) is correct;
  // a re-sync re-derives the flag from the plan for any that gain the marker.
  if (!taskColumns.some((c) => c.name === 'isContract')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN isContract INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before scaffold-first execution (Phase D). Existing tasks
  // predate the `@scaffold` marker, so 0 is correct; a re-sync re-derives it from the plan.
  if (!taskColumns.some((c) => c.name === 'isScaffold')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN isScaffold INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before the JIRA integration. All new columns are
  // nullable with no default — existing (internal) tasks read them back as null,
  // which is exactly "not linked to any tracker".
  const jiraTaskColumns: Array<[string, string]> = [
    ['type', 'TEXT'],
    ['externalSource', 'TEXT'],
    ['externalKey', 'TEXT'],
    ['externalId', 'TEXT'],
    ['externalUrl', 'TEXT'],
    ['externalStatus', 'TEXT'],
    ['externalStatusCategory', 'TEXT'],
    ['externalPriority', 'TEXT'],
    ['externalType', 'TEXT'],
    ['externalLabel', 'TEXT'],
    ['preBlockStatus', 'TEXT'],
    // Null on every existing row, which reads as "no run has borrowed this card's
    // status" — exactly true of a task sitting in the DB when the app starts.
    ['preRunStatus', 'TEXT'],
    // NULL on every existing row, which reads as "the JQL still returns this card" — true
    // of anything already on the board when the app starts.
    ['retainedSince', 'INTEGER'],
    ['lastReadCommentAt', 'INTEGER'],
    ['latestCommentAt', 'INTEGER'],
    // Agent delegation: the epic/parent key and description come from JIRA (a re-sync
    // fills them in), `agentProjectId` is set only when a human assigns the card.
    ['externalParentKey', 'TEXT'],
    ['externalEpicName', 'TEXT'],
    // The sprint name, added with sprint support — NULL on every pre-existing row
    // until the next JIRA sync fills it in, which is exactly "no sprint known".
    ['externalSprint', 'TEXT'],
    ['externalDescription', 'TEXT'],
    ['agentProjectId', 'TEXT'],
    // Split out of `agentProjectId` (which used to mean both "about" and "runs in"):
    // NULL on every pre-existing row until the one-shot back-fill below fills it.
    ['projectTagId', 'TEXT'],
    // Per-assignment overrides of the agent project's model / permission mode. NULL
    // means "use the project default", which is what every pre-existing row wants.
    ['agentMode', 'TEXT'],
    ['agentModel', 'TEXT'],
    // The markdown plan a `plan`-mode run produced, kept so it survives a restart and
    // can be re-read (and re-split into subtasks) after the fact.
    ['agentPlan', 'TEXT'],
  ];
  for (const [name, type] of jiraTaskColumns) {
    if (!taskColumns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
  }

  // Migrate databases created before plan-driven subtasks (Phase 11). Every existing
  // row is an ordinary top-level card with no brief of its own, which is exactly what
  // NULL means for both columns — no behavior changes for them.
  for (const [name, type] of [
    ['parentTaskId', 'TEXT'],
    ['description', 'TEXT'],
    // The card's own progress note. NULL on every pre-existing row, which is exactly
    // "nobody has said where this is yet" — nothing about those cards changes.
    ['statusNote', 'TEXT'],
    ['statusNoteAt', 'INTEGER'],
    // The git branch this card's worktree runs on (Phase 17). NULL on every pre-existing
    // row, which `branchFor` reads as "use the legacy orch/<taskId>" — so an upgrade never
    // orphans a worktree that already exists on the old name.
    ['agentBranch', 'TEXT'],
    // Which round of planning produced this step (Phase 18 — re-planning). NULL on every
    // pre-existing row, coerced to 1 by `rowToTask`: everything that exists today came from
    // a card's first and only approved plan, which IS round 1.
    ['planRound', 'INTEGER'],
    // When this card's work landed (the chain of execution). NULL on every pre-existing
    // row = "it has not", which holds nothing back: no card is chained until a human
    // draws an arrow, and the next merge of a chained card fills it in.
    ['landedAt', 'INTEGER'],
    // One-shot marker a finished chain leaves for `startTask` (review, not new work). NULL
    // on every pre-existing row = "nothing to consume", which is exactly true: no chain
    // finished mid-upgrade with a human waiting to talk to it.
    ['chainLandedAt', 'INTEGER'],
    // When an agent last STARTED on this card (or a step of it). NULL on every pre-existing
    // row, and backfilled immediately below — a NULL here would hide the Merge button on
    // every card that had already run, which is the exact bug this column exists to fix.
    ['workedAt', 'INTEGER'],
    // When the human stopped this card's work. NULL on every pre-existing row and
    // deliberately NOT backfilled — unlike `workedAt` above, where NULL was a lie about
    // cards that had plainly run, NULL here is exactly true: nothing was stopped mid-upgrade,
    // and a guess would offer Resume on cards nobody ever stopped.
    ['stoppedAt', 'INTEGER'],
    // The card's auto-release override. NULL on every pre-existing row = "nobody has ruled
    // on this card", which follows the project's (also new, also off) preference — so no
    // upgraded install starts releasing anything by itself.
    ['autoRelease', 'INTEGER'],
    // The card's open-a-PR override. NULL on every pre-existing row = "nobody has ruled on
    // this card", which follows the project's (also new, also off) preference — so an
    // upgrade pushes nothing and opens nothing until somebody asks it to.
    ['autoCreatePr', 'INTEGER'],
    // The card's auto-merge override. NULL on every pre-existing row = "nobody has ruled on
    // this card", which follows its project and, through it, the app-wide setting — so an
    // upgrade merges exactly as often as the install did the day before.
    ['autoIntegrate', 'INTEGER'],
    // When this card was taken off the board without being destroyed. NULL on every
    // pre-existing row = "it is on the board", which is true of everything already there —
    // so an upgrade hides nothing, and the column stays empty until something archives.
    ['archivedAt', 'INTEGER'],
    // Which answer took it off. NULL on every pre-existing row — including one archived by
    // the version that added `archivedAt` and nothing else — which the Removed-cards list
    // reads as "removed by an earlier version" rather than inventing a reason for it.
    ['archivedReason', 'TEXT'],
    // Native tickets (Phase 24). NULL on every pre-existing row, which is exactly "this is
    // not a ticket" — nothing about those cards changes, and the twelve columns stay empty
    // until a ticket project exists to fill them.
    ['ticketKey', 'TEXT'],
    ['ticketNumber', 'INTEGER'],
    ['issueType', 'TEXT'],
    ['epicTaskId', 'TEXT'],
    ['milestoneId', 'TEXT'],
    ['labels', 'TEXT'],
    // REAL on purpose, and nullable: NULL means "not estimated", which 0 cannot express
    // because 0 points is itself a legitimate estimate. See `Task.storyPoints`.
    ['storyPoints', 'REAL'],
    ['estimateDays', 'REAL'],
    ['startAt', 'INTEGER'],
    ['dueAt', 'INTEGER'],
    ['assigneeId', 'TEXT'],
    ['reporterId', 'TEXT'],
  ] as Array<[string, string]>) {
    if (!taskColumns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
  }
  // Migrate databases created before the cloud mirror (Phase 25). Same NULL-until-next-write
  // reasoning as `projects.updatedAt` above.
  if (!taskColumns.some((c) => c.name === 'updatedAt')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN updatedAt INTEGER`);
  }
  // Backfill `workedAt` (see `Task.workedAt`). Unlike every other column above, NULL here is
  // not harmless: it is read as "no agent has run this card", which hides the Merge button
  // and both auto-merge/auto-release switches — so an upgrade would inherit the very bug the
  // column fixes, on exactly the cards that have work waiting to be merged.
  //
  // A card has demonstrably run when it holds a session, when its chain has landed, or when
  // any of its STEPS holds one (a plan's steps run on the card's branch). The instant is
  // recovered from its event trail where there is one; `1` is the honest fallback — a real
  // epoch nobody will mistake for a run time, meaning "before this column existed".
  //
  // Idempotent by the `workedAt IS NULL` guard, so it costs one no-op scan per open.
  db.exec(`
    UPDATE tasks
       SET workedAt = COALESCE(
             (SELECT MIN(e.createdAt) FROM task_events e WHERE e.taskId = tasks.id),
             chainLandedAt, landedAt, 1)
     WHERE workedAt IS NULL
       AND (sessionId IS NOT NULL
            OR chainLandedAt IS NOT NULL
            OR id IN (SELECT s.parentTaskId FROM tasks s
                       WHERE s.parentTaskId IS NOT NULL AND s.sessionId IS NOT NULL))
  `);
  // Created after the migration above, not in the schema block: on a pre-Phase-11 database
  // the column does not exist until the ALTER has run.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId, "order")`);
  // Same position, same reason. The unique one is the schema-level backstop under the
  // promise that a key is never re-issued: whatever a caller does, two rows can never wear
  // one name. PARTIAL, so every non-ticket row's NULL is ignored rather than colliding.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_ticket_key
       ON tasks(ticketKey) WHERE ticketKey IS NOT NULL`,
  );
  // An epic's children and a milestone's tickets are both read by the id they point at —
  // the Gantt groups by the first and the timeline markers by the second.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epicTaskId, "order")`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestoneId)`);

  // Created down here, not in the schema block above: on a pre-Phase-25 database
  // `tasks.updatedAt`/`projects.updatedAt` do not exist until the ALTERs above have run,
  // and a trigger body is resolved against the table's live column set at CREATE TRIGGER
  // time. `cloud_outbox` itself IS in the schema block — it is a new table, not migrated.
  //
  // One trigger per write kind, each doing two things: touch `updatedAt` (a bare
  // `UPDATE ... SET status = ...` never sets it itself, and there is no caller left out —
  // see `cloud_outbox` above) and append the outbox row. Combined into one body rather
  // than split across two triggers deliberately: SQLite still fires a DIFFERENT trigger
  // reached via a nested statement even with `recursive_triggers` off (its default here —
  // that pragma only stops a trigger from re-firing ITSELF), so two separate AFTER UPDATE
  // triggers would have the touch trigger's own nested `UPDATE` cross-fire the outbox
  // trigger a second time and double-log every edit, forever. Folded into one trigger,
  // the nested touch can only ever cross-fire that SAME trigger, which recursive_triggers
  // = off does block — confirmed against a real in-memory database before relying on it.
  //
  // The `WHERE updatedAt IS OLD.updatedAt` / `WHERE updatedAt IS NULL` guards on the
  // nested UPDATE avoid clobbering a value a caller DID set on purpose — the one future
  // caller being command apply (Phase 25, later), which will want to stamp the server's
  // own `updatedAt` rather than have this trigger immediately overwrite it with "now".
  // The outbox INSERT itself is deliberately unconditional (no such guard): every real
  // write gets logged even if the row's own `updatedAt` was already current.
  //
  // A fresh INSERT still costs two outbox rows (an 'insert' plus one 'update' echo from
  // the touch's nested UPDATE crossing into the update trigger) — a one-time cost per
  // entity, not per edit, and exactly what `shapeCloudDelta`'s collapse-to-last-row exists
  // to absorb.
  const nowMs = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
  for (const table of ['tasks', 'projects'] as const) {
    const entity = table === 'tasks' ? 'task' : 'project';
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_after_insert
      AFTER INSERT ON ${table}
      BEGIN
        INSERT INTO cloud_outbox (entity, entityId, op, at)
        VALUES ('${entity}', NEW.id, 'insert', ${nowMs});
        UPDATE ${table} SET updatedAt = ${nowMs} WHERE id = NEW.id AND updatedAt IS NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_after_update
      AFTER UPDATE ON ${table}
      BEGIN
        INSERT INTO cloud_outbox (entity, entityId, op, at)
        VALUES ('${entity}', NEW.id, 'update', ${nowMs});
        UPDATE ${table} SET updatedAt = ${nowMs} WHERE id = NEW.id AND updatedAt IS OLD.updatedAt;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_after_delete
      AFTER DELETE ON ${table}
      BEGIN
        INSERT INTO cloud_outbox (entity, entityId, op, at)
        VALUES ('${entity}', OLD.id, 'delete', ${nowMs});
      END;
    `);
  }

  // Seed the built-in Personal board project (idempotent). It hosts the standalone
  // My Tasks board (JIRA tickets + internal ad-hoc tasks); it has no repo/plan, so
  // it is hidden from the Projects tab and skipped by the plan watcher/scheduler.
  // createdAt = 0 keeps the seed deterministic (no Date.now at open).
  db.prepare(
    `INSERT INTO projects
       (id, name, path, planPath, defaultModel, planningModel, defaultPermissionMode,
        concurrency, useWorktrees, writeBackPlan, planAligned, createdAt)
     VALUES (@id, 'Personal', '', '', @defaultModel, @planningModel, @defaultPermissionMode, 1, 0, 0, 1, 0)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: PERSONAL_PROJECT_ID,
    defaultModel: DEFAULT_SETTINGS.defaultModel,
    planningModel: DEFAULT_SETTINGS.defaultPlanningModel,
    defaultPermissionMode: DEFAULT_SETTINGS.defaultPermissionMode,
  });

  // Migrate databases created before per-task git worktrees. Default on (1); it only
  // engages for git repos, so non-git projects keep running in the shared directory.
  if (!projectColumns.some((c) => c.name === 'useWorktrees')) {
    db.exec(`ALTER TABLE projects ADD COLUMN useWorktrees INTEGER NOT NULL DEFAULT 1`);
  }

  // Migrate databases created before the team-orchestration alignment flag. Existing
  // projects predate `@needs:`/`@contract`, so they backfill to 0 ("needs review") —
  // the UI offers a one-click Align upgrade. New projects are inserted with 1, and a
  // plan already carrying alignment markers is bumped to 1 on its next sync.
  if (!projectColumns.some((c) => c.name === 'planAligned')) {
    db.exec(`ALTER TABLE projects ADD COLUMN planAligned INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate databases created before per-project concurrency existed. Concurrency
  // used to be a single global setting applied to every project, so seed each
  // existing project with the current global value — that preserves their exact
  // prior behavior (the DEFAULT 1 above only covers the degenerate no-settings case).
  if (!projectColumns.some((c) => c.name === 'concurrency')) {
    db.exec(`ALTER TABLE projects ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1`);
    const settingsRow = db.prepare(`SELECT value FROM app_state WHERE key = 'settings'`).get() as
      { value: string } | undefined;
    let globalConcurrency = DEFAULT_SETTINGS.concurrency;
    try {
      if (settingsRow) {
        const saved = JSON.parse(settingsRow.value) as Partial<AppSettings>;
        if (typeof saved.concurrency === 'number') globalConcurrency = saved.concurrency;
      }
    } catch {
      // Malformed settings row — fall back to the built-in default.
    }
    db.prepare(`UPDATE projects SET concurrency = ?`).run(
      Math.max(1, Math.round(globalConcurrency)),
    );
  }

  /**
   * Fold the two per-integration poll intervals into the one shared `syncIntervalMinutes`.
   *
   * Written back once rather than derived on every read, so `getSettings` stays a plain merge
   * over defaults and the Settings screen — which saves the whole blob — cannot resurrect the
   * legacy pair by round-tripping them. `resolveSyncInterval` takes the SMALLER of the two,
   * so nobody's board gets staler than it already was.
   */
  {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = 'settings'`).get() as
      { value: string } | undefined;
    if (row) {
      try {
        const saved = JSON.parse(row.value) as Partial<AppSettings>;
        if (typeof saved.syncIntervalMinutes !== 'number') {
          const migrated = { ...saved, syncIntervalMinutes: resolveSyncInterval(saved) };
          delete (migrated.jira as { pollIntervalMinutes?: number } | undefined)
            ?.pollIntervalMinutes;
          delete (migrated.gitlab as { pollIntervalMinutes?: number } | undefined)
            ?.pollIntervalMinutes;
          db.prepare(
            `INSERT INTO app_state (key, value) VALUES ('settings', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          ).run(JSON.stringify(migrated));
        }
      } catch {
        // Malformed settings row — `getSettings` already falls back to the defaults.
      }
    }
  }

  const insertProject = db.prepare<[ProjectRow]>(
    `INSERT INTO projects (id, name, path, planPath, defaultModel, planningModel, defaultPermissionMode, concurrency, useWorktrees, baseBranch, writeBackPlan, autoRelease, autoCreatePr, autoIntegrate, planAligned, kind, jiraEpicKeys, ticketPrefix, ticketSeq, target, instructions, color, createdAt)
     VALUES (@id, @name, @path, @planPath, @defaultModel, @planningModel, @defaultPermissionMode, @concurrency, @useWorktrees, @baseBranch, @writeBackPlan, @autoRelease, @autoCreatePr, @autoIntegrate, @planAligned, @kind, @jiraEpicKeys, @ticketPrefix, @ticketSeq, @target, @instructions, @color, @createdAt)`,
  );
  const selectProjects = db.prepare(`SELECT * FROM projects ORDER BY createdAt`);
  const selectProject = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);
  const updateWriteBack = db.prepare(`UPDATE projects SET writeBackPlan = ? WHERE id = ?`);
  const updatePlanAligned = db.prepare(`UPDATE projects SET planAligned = ? WHERE id = ?`);
  const selectTasks = db.prepare(`SELECT * FROM tasks WHERE projectId = ? ORDER BY "order"`);
  // The Personal board's own reads. Three statements rather than one `selectTasks` filtered
  // in JS: the board read is the hottest query in the app (every sync, every card edit and
  // every window that comes back pushes the whole board), so `archivedAt IS NULL` belongs in
  // SQLite where the row never has to be built at all.
  //
  // `selectTasks` above is deliberately NOT filtered — see `getTasks` for why archiving is a
  // board concept and a plan project's queue must keep seeing every row it has.
  const selectBoardTasks = db.prepare(
    `SELECT * FROM tasks WHERE projectId = ? AND archivedAt IS NULL ORDER BY "order"`,
  );
  const selectArchivedBoardTasks = db.prepare(
    `SELECT * FROM tasks WHERE projectId = ? AND archivedAt IS NOT NULL
     ORDER BY archivedAt DESC, "order"`,
  );
  // The union read behind `getAllBoardTasks`/`getAllArchivedBoardTasks`: the same two
  // queries above, with the `projectId = ?` predicate widened to "every project with no
  // plan file" (a join against `projects`, since that is where `planPath` lives) and the
  // order fixed to `projectId, "order"` so a card never jumps around a mixed column.
  const selectAllBoardTasks = db.prepare(
    `SELECT tasks.* FROM tasks JOIN projects ON projects.id = tasks.projectId
     WHERE projects.planPath = '' AND tasks.archivedAt IS NULL
     ORDER BY tasks.projectId, tasks."order"`,
  );
  const selectAllArchivedBoardTasks = db.prepare(
    `SELECT tasks.* FROM tasks JOIN projects ON projects.id = tasks.projectId
     WHERE projects.planPath = '' AND tasks.archivedAt IS NOT NULL
     ORDER BY tasks.projectId, tasks."order"`,
  );
  const selectTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
  const deleteTasks = db.prepare(`DELETE FROM tasks WHERE projectId = ?`);
  const insertTask = db.prepare<[TaskRow]>(
    `INSERT INTO tasks
       (id, projectId, phase, title, status, sessionId, "order", source, dependsOn, isContract, isScaffold, type,
        parentTaskId, description, statusNote, statusNoteAt,
        externalSource, externalKey, externalId, externalUrl, externalStatus, externalStatusCategory,
        externalPriority, externalType, externalLabel, externalParentKey, externalEpicName, externalSprint,
        externalDescription,
        preBlockStatus, preRunStatus, retainedSince, archivedAt, archivedReason, lastReadCommentAt, latestCommentAt,
        projectTagId, agentProjectId, agentMode, agentModel,
        agentPlan, agentBranch, planRound, landedAt, chainLandedAt, workedAt, stoppedAt, autoRelease, autoCreatePr, autoIntegrate,
        ticketKey, ticketNumber, issueType, epicTaskId, milestoneId, labels,
        storyPoints, estimateDays, startAt, dueAt, assigneeId, reporterId)
     VALUES
       (@id, @projectId, @phase, @title, @status, @sessionId, @order, @source, @dependsOn, @isContract, @isScaffold, @type,
        @parentTaskId, @description, @statusNote, @statusNoteAt,
        @externalSource, @externalKey, @externalId, @externalUrl, @externalStatus, @externalStatusCategory,
        @externalPriority, @externalType, @externalLabel, @externalParentKey, @externalEpicName, @externalSprint,
        @externalDescription,
        @preBlockStatus, @preRunStatus, @retainedSince, @archivedAt, @archivedReason, @lastReadCommentAt, @latestCommentAt,
        -- The filing column was added after this INSERT was written and only ever set by
        -- an UPDATE, so a card created already filed (the Add-task dialog's Project
        -- picker) used to lose its project between the form and the row.
        @projectTagId, @agentProjectId, @agentMode, @agentModel,
        @agentPlan, @agentBranch, @planRound, @landedAt, @chainLandedAt, @workedAt, @stoppedAt, @autoRelease, @autoCreatePr, @autoIntegrate,
        -- The twelve ticket columns are listed HERE as well as in the column list above,
        -- and that is the whole discipline: a column added to the table, the row type and
        -- the writer but not to this statement is silently dropped at creation. That is
        -- exactly what happened to projectTagId (see the comment above it), and a ticket
        -- that lost its epic or its due date between the form and the row would be the
        -- same bug wearing a different name.
        @ticketKey, @ticketNumber, @issueType, @epicTaskId, @milestoneId, @labels,
        @storyPoints, @estimateDays, @startAt, @dueAt, @assigneeId, @reporterId)`,
  );
  const deleteTask = db.prepare(`DELETE FROM tasks WHERE id = ?`);
  // Native tickets. No foreign key backs epicTaskId (see the tasks table above), so deleting
  // an epic must null it on every ticket that named it — the same explicit clear
  // deleteMilestoneTx/deletePersonTx already do for milestoneId/assigneeId/reporterId.
  const clearEpicOnTasks = db.prepare(`UPDATE tasks SET epicTaskId = NULL WHERE epicTaskId = ?`);
  // Archiving is one column, written by id. Both statements take the card AND its steps in
  // one go (`parentTaskId = @id`): a step has no board presence of its own — the board hangs
  // it under its parent — so a step left behind by an archived card is a row nothing can
  // reach and nothing can restore.
  const archiveTaskStmt = db.prepare(
    `UPDATE tasks SET archivedAt = @at, archivedReason = @reason
     WHERE (id = @id OR parentTaskId = @id) AND archivedAt IS NULL`,
  );
  // The reason is cleared with the timestamp: it describes an ABSENCE, and a card that is
  // back on the board has none. Leaving it behind would have the next removal's list show a
  // stale sentence for a card removed for some other reason entirely.
  const unarchiveTaskStmt = db.prepare(
    `UPDATE tasks SET archivedAt = NULL, archivedReason = NULL WHERE id = @id OR parentTaskId = @id`,
  );
  // The ids the retention sweep is allowed to destroy. Selected rather than deleted in one
  // statement so each goes out through the same `deleteTaskDeep` an explicit delete uses, and
  // takes its timeline and transcript with it — a bare DELETE would strand both.
  //
  // Cards only (`parentTaskId IS NULL`), because `deleteTaskDeep` already takes a card's steps
  // with it and a step is only ever archived by its own card's cascade — counting the steps
  // would report four removals for one card and then delete three rows that were already gone.
  const selectArchivedBefore = db.prepare(
    `SELECT id FROM tasks WHERE archivedAt IS NOT NULL AND archivedAt < ? AND parentTaskId IS NULL`,
  );
  const selectSubtasks = db.prepare(
    `SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY "order", rowid`,
  );
  const selectSubtaskIds = db.prepare(`SELECT id FROM tasks WHERE parentTaskId = ?`);
  const nextOrder = db.prepare(
    `SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM tasks WHERE projectId = ?`,
  );
  const nextSubtaskOrder = db.prepare(
    `SELECT COALESCE(MAX("order"), -1) + 1 AS next FROM tasks WHERE parentTaskId = ?`,
  );
  // The card's newest planning round, or 0 when it has no steps at all — so the first
  // round a card ever gets is 1. COALESCE covers pre-migration rows, whose `planRound`
  // is NULL and which `rowToTask` reads as round 1.
  const maxSubtaskRound = db.prepare(
    `SELECT COALESCE(MAX(COALESCE(planRound, 1)), 0) AS round FROM tasks WHERE parentTaskId = ?`,
  );
  const upsertState = db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteState = db.prepare(`DELETE FROM app_state WHERE key = ?`);
  const selectState = db.prepare(`SELECT value FROM app_state WHERE key = ?`);
  // task_events references the PROJECT (not the task) so a plan re-sync — which
  // deletes and re-inserts task rows — never cascades away a task's history.
  const insertEvent = db.prepare(
    `INSERT INTO task_events (projectId, taskId, runId, event, createdAt)
     VALUES (@projectId, @taskId, @runId, @event, @createdAt)`,
  );
  const selectEvents = db.prepare(`SELECT event FROM task_events WHERE taskId = ? ORDER BY id`);
  // Timeline reads need id + createdAt (not just the event blob) to interleave with
  // human activity; the task-scoped deletes clean up on an explicit ad-hoc delete.
  const selectEventsFull = db.prepare(
    `SELECT id, event, createdAt FROM task_events WHERE taskId = ? ORDER BY id`,
  );
  const deleteEventsForTask = db.prepare(`DELETE FROM task_events WHERE taskId = ?`);
  const insertUsage = db.prepare(
    `INSERT INTO token_usage
       (source, projectId, taskId, runId, inputTokens, outputTokens,
        cacheCreationTokens, cacheReadTokens, totalTokens, costUsd, createdAt)
     VALUES
       (@source, @projectId, @taskId, @runId, @inputTokens, @outputTokens,
        @cacheCreationTokens, @cacheReadTokens, @totalTokens, @costUsd, @createdAt)`,
  );
  const selectUsageSince = db.prepare(
    `SELECT source, projectId, taskId, runId, inputTokens, outputTokens,
            cacheCreationTokens, cacheReadTokens, totalTokens, createdAt
     FROM token_usage WHERE createdAt >= ? AND totalTokens > 0 ORDER BY createdAt`,
  );
  const selectUsageCostSince = db.prepare(
    `SELECT COALESCE(SUM(costUsd), 0) AS cost FROM token_usage WHERE createdAt >= ?`,
  );
  // Half-open [from, to), so two adjacent windows can never double-count a sample on
  // their shared edge. Served by `idx_token_usage_time`.
  const selectUsageTokensBetween = db.prepare(
    `SELECT COALESCE(SUM(totalTokens), 0) AS tokens
     FROM token_usage WHERE createdAt >= ? AND createdAt < ?`,
  );
  const insertActivity = db.prepare(
    `INSERT INTO task_activity (projectId, taskId, kind, body, fromStatus, toStatus, createdAt)
     VALUES (@projectId, @taskId, @kind, @body, @fromStatus, @toStatus, @createdAt)`,
  );
  const selectActivity = db.prepare(
    `SELECT id, kind, body, fromStatus, toStatus, createdAt FROM task_activity
     WHERE taskId = ? ORDER BY id`,
  );
  const selectActivityRow = db.prepare(`SELECT * FROM task_activity WHERE id = ?`);
  const deleteActivity = db.prepare(`DELETE FROM task_activity WHERE id = ?`);
  const deleteActivityForTask = db.prepare(`DELETE FROM task_activity WHERE taskId = ?`);

  /** The single row key under which the usage-limit gate is persisted. */
  const LIMIT_GATE_KEY = 'limitGate';
  /** …and the one under which the sign-in gate is (see `@shared/auth`). */
  const AUTH_GATE_KEY = 'authGate';
  /**
   * …and the one holding the recipes for the runs those two gates parked (`parkedRun.ts`).
   * Deliberately beside the gates rather than inside either of them: a recipe outlives a
   * restart exactly as a gate does, but belongs to neither gate's shape.
   */
  const PARKED_RUNS_KEY = 'parkedRuns';
  /** The single row key under which app settings are persisted. */
  const SETTINGS_KEY = 'settings';

  /** The single row key under which the JIRA token ciphertext is persisted. */
  const JIRA_TOKEN_KEY = 'jira.pat';

  /** The single row key caching JIRA's per-instance "Epic Link" field discovery. */
  const JIRA_EPIC_FIELD_KEY = 'jira.epicField';

  /** The single row key caching JIRA's per-instance "Sprint" field discovery. */
  const JIRA_SPRINT_FIELD_KEY = 'jira.sprintField';

  /** The single row key caching `GET /myself` for the configured site. */
  const JIRA_IDENTITY_KEY = 'jira.identity';

  /** The effective JQL the last sync ran, so the next one can tell the question changed. */
  const JIRA_LAST_QUERY_KEY = 'jira.lastQuery';

  /** Where the main window was, and whether it was maximized, when we last looked. */
  const WINDOW_STATE_KEY = 'window.state';

  /** Guard for the one-shot `agentProjectId` → `projectTagId` back-fill below. */
  const PROJECT_TAG_SPLIT_KEY = 'migration.projectTagSplit';

  /** Guard for the one-shot release of cards pinned to their project's model, below. */
  const PINNED_MODEL_RELEASE_KEY = 'migration.pinnedModelRelease';

  /** Guard for the one-shot claim of blocks that predate `preBlockStatus` meaning ownership. */
  const BLOCK_OWNER_KEY = 'migration.blockOwner';

  /** The GitLab PAT ciphertext, and the cached `GET /user` for the configured instance. */
  const GITLAB_TOKEN_KEY = 'gitlab.pat';
  const GITLAB_IDENTITY_KEY = 'gitlab.identity';

  /** The same pair for GitHub. Separate rows, because both forges can be connected at once. */
  const GITHUB_TOKEN_KEY = 'github.pat';
  const GITHUB_IDENTITY_KEY = 'github.identity';

  /** The issue query the last GitHub sync ran — `JIRA_LAST_QUERY_KEY`'s counterpart. */
  const GITHUB_LAST_QUERY_KEY = 'github.lastQuery';

  /** A pre-PAT vipper.iam refresh token, if this database predates this ticket — see
   *  `clearLegacyCloudSignIn`. Nothing writes this key any more. */
  const IAM_REFRESH_TOKEN_KEY = 'iam.refreshToken';
  /** The Task Manager personal access token ciphertext — see `ipc.ts`'s `cloud:*` handlers. */
  const CLOUD_PAT_KEY = 'cloud.pat';
  const CLOUD_CLIENT_ID_KEY = 'cloud.clientId';
  const CLOUD_CURSOR_KEY = 'cloud.cursor';

  /** An attention_items row: `options`/`steps`/`questions`/`context` are JSON text. */
  interface AttentionRow {
    id: string;
    runId: string;
    taskId: string;
    projectId: string;
    taskTitle: string;
    kind: string;
    prompt: string;
    options: string;
    toolName: string | null;
    reason: string | null;
    worktreePath: string | null;
    branch: string | null;
    plan: string | null;
    steps: string | null;
    questions: string | null;
    context: string | null;
    createdAt: number;
  }

  /** A merge_requests row: SQLite has no boolean, and `issueKeys` is JSON. */
  interface MergeRequestRow {
    id: string;
    taskId: string | null;
    /** The card the Create PR button opened it for; NULL on every row a sync discovered. */
    openedForTaskId: string | null;
    provider: string;
    repoId: number;
    projectPath: string;
    number: number;
    title: string;
    displayName: string | null;
    webUrl: string;
    sourceBranch: string;
    targetBranch: string;
    state: string;
    draft: number;
    pipelineStatus: string;
    /** JSON array of {name,status}; NULL on rows written before stages existed. */
    pipelineStages: string | null;
    pipelineUrl: string | null;
    approvalsRequired: number | null;
    approvalsGiven: number;
    changesRequested: number;
    /** The forge's own merge verdict, raw; NULL on rows written before we asked. */
    detailedMergeStatus: string | null;
    hasConflicts: number;
    issueKeys: string;
    latestNoteAt: number | null;
    lastReadAt: number | null;
    lastEventAt: number | null;
    lastEventSeenAt: number | null;
    updatedAt: number;
    syncedAt: number;
  }

  function rowToMergeRequest(r: MergeRequestRow): MergeRequest {
    let issueKeys: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.issueKeys);
      if (Array.isArray(parsed))
        issueKeys = parsed.filter((k): k is string => typeof k === 'string');
    } catch {
      issueKeys = []; // corrupt JSON — the next sync rediscovers them
    }
    let pipelineStages: PipelineStage[] = [];
    try {
      const parsed: unknown = JSON.parse(r.pipelineStages ?? '[]');
      if (Array.isArray(parsed)) {
        pipelineStages = parsed.filter(
          (s): s is PipelineStage =>
            typeof (s as PipelineStage)?.name === 'string' &&
            typeof (s as PipelineStage)?.status === 'string',
        );
      }
    } catch {
      pipelineStages = []; // corrupt JSON — the next sync refetches the jobs
    }
    return {
      id: r.id,
      taskId: r.taskId,
      // `?? null` rather than the column straight: rows written before the column existed
      // read back as `undefined` from a `SELECT *` on some drivers, and `undefined` is not a
      // value `upsertMergeRequest` can bind.
      openedForTaskId: r.openedForTaskId ?? null,
      // Rows written before GitHub existed here have `provider: 'gitlab'` stored, so the
      // column is trusted rather than hardcoded — anything unrecognised reads as GitLab,
      // which is what every such row actually is.
      provider: r.provider === 'github' ? 'github' : 'gitlab',
      repoId: r.repoId,
      projectPath: r.projectPath,
      number: r.number,
      title: r.title,
      displayName: r.displayName,
      webUrl: r.webUrl,
      sourceBranch: r.sourceBranch,
      targetBranch: r.targetBranch,
      state: r.state as MergeRequestState,
      draft: r.draft === 1,
      pipelineStatus: r.pipelineStatus as PipelineStatus,
      pipelineStages,
      pipelineUrl: r.pipelineUrl,
      approvalsRequired: r.approvalsRequired,
      approvalsGiven: r.approvalsGiven,
      changesRequested: r.changesRequested === 1,
      detailedMergeStatus: r.detailedMergeStatus ?? null,
      hasConflicts: r.hasConflicts === 1,
      issueKeys,
      latestNoteAt: r.latestNoteAt,
      lastReadAt: r.lastReadAt,
      lastEventAt: r.lastEventAt,
      lastEventSeenAt: r.lastEventSeenAt,
      updatedAt: r.updatedAt,
      syncedAt: r.syncedAt,
    };
  }

  const selectMergeRequests = db.prepare(`SELECT * FROM merge_requests ORDER BY updatedAt DESC`);
  const selectMergeRequest = db.prepare(`SELECT * FROM merge_requests WHERE id = ?`);
  const upsertMergeRequestStmt = db.prepare(
    `INSERT INTO merge_requests
       (id, taskId, openedForTaskId, provider, repoId, projectPath, "number", title,
        displayName, webUrl,
        sourceBranch, targetBranch, state, draft, pipelineStatus, pipelineStages,
        pipelineUrl,
        approvalsRequired, approvalsGiven, changesRequested,
        detailedMergeStatus, hasConflicts, issueKeys,
        latestNoteAt, lastReadAt, lastEventAt, lastEventSeenAt, updatedAt, syncedAt)
     VALUES
       (@id, @taskId, @openedForTaskId, @provider, @repoId, @projectPath, @number, @title,
        @displayName, @webUrl,
        @sourceBranch, @targetBranch, @state, @draft, @pipelineStatus, @pipelineStages,
        @pipelineUrl,
        @approvalsRequired, @approvalsGiven, @changesRequested,
        @detailedMergeStatus, @hasConflicts, @issueKeys,
        @latestNoteAt, @lastReadAt, @lastEventAt, @lastEventSeenAt, @updatedAt, @syncedAt)
     ON CONFLICT(id) DO UPDATE SET
       taskId = excluded.taskId,
       -- COALESCE, unlike every other column here: a reconciler carries the remembered card
       -- forward, but a row rebuilt by anything that did not look it up first must not be
       -- able to forget which card opened it. Nothing upstream can supply this, so a NULL
       -- coming in is always "did not know", never "no longer true".
       openedForTaskId = COALESCE(excluded.openedForTaskId, merge_requests.openedForTaskId),
       projectPath = excluded.projectPath,
       title = excluded.title, displayName = excluded.displayName,
       webUrl = excluded.webUrl,
       sourceBranch = excluded.sourceBranch, targetBranch = excluded.targetBranch,
       state = excluded.state, draft = excluded.draft,
       pipelineStatus = excluded.pipelineStatus,
       pipelineStages = excluded.pipelineStages, pipelineUrl = excluded.pipelineUrl,
       approvalsRequired = excluded.approvalsRequired,
       approvalsGiven = excluded.approvalsGiven,
       changesRequested = excluded.changesRequested,
       detailedMergeStatus = excluded.detailedMergeStatus,
       hasConflicts = excluded.hasConflicts, issueKeys = excluded.issueKeys,
       latestNoteAt = excluded.latestNoteAt, lastReadAt = excluded.lastReadAt,
       lastEventAt = excluded.lastEventAt, lastEventSeenAt = excluded.lastEventSeenAt,
       updatedAt = excluded.updatedAt, syncedAt = excluded.syncedAt`,
  );
  const deleteMergeRequestStmt = db.prepare(`DELETE FROM merge_requests WHERE id = ?`);

  /** A task_links row. `gate` is validated on the way out, not trusted from the column. */
  interface TaskLinkRow {
    id: string;
    fromTaskId: string;
    toTaskId: string;
    gate: string;
    createdAt: number;
  }

  /** An unknown `gate` degrades to the strict default rather than to "no gate at all". */
  function rowToTaskLink(r: TaskLinkRow): TaskLink {
    return {
      id: r.id,
      fromTaskId: r.fromTaskId,
      toTaskId: r.toTaskId,
      gate: isLinkGate(r.gate) ? r.gate : 'after-merge',
      createdAt: r.createdAt,
    };
  }

  const selectTaskLinks = db.prepare(`SELECT * FROM task_links ORDER BY createdAt, rowid`);
  const selectTaskLink = db.prepare(`SELECT * FROM task_links WHERE id = ?`);
  // The links touching a set of tasks — used to carry a project's chain across the
  // delete-and-reinsert a plan re-sync performs. See `syncTasksFromPlan`.
  const selectTaskLinksForProject = db.prepare(
    `SELECT * FROM task_links
     WHERE fromTaskId IN (SELECT id FROM tasks WHERE projectId = ?)
        OR toTaskId   IN (SELECT id FROM tasks WHERE projectId = ?)`,
  );
  const insertTaskLink = db.prepare<[TaskLinkRow]>(
    `INSERT INTO task_links (id, fromTaskId, toTaskId, gate, createdAt)
     VALUES (@id, @fromTaskId, @toTaskId, @gate, @createdAt)
     ON CONFLICT(fromTaskId, toTaskId) DO NOTHING`,
  );
  const deleteTaskLinkStmt = db.prepare(`DELETE FROM task_links WHERE id = ?`);
  const updateTaskLinkGate = db.prepare(`UPDATE task_links SET gate = ? WHERE id = ?`);

  // --- Native tickets (Phase 24). ---------------------------------------------------

  /** How many keys a project has issued — asked before a prefix is allowed to be cleared. */
  const countProjectTickets = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE projectId = ? AND ticketNumber IS NOT NULL`,
  );
  // Re-key a project's tickets after a prefix rename. `||` concatenates, and SQLite coerces
  // the INTEGER ordinal to text — so this is the whole rename, in one statement, with the
  // numbers (the durable half) untouched.
  const rekeyProjectTickets = db.prepare(
    `UPDATE tasks SET ticketKey = @prefix || '-' || ticketNumber
       WHERE projectId = @id AND ticketNumber IS NOT NULL`,
  );
  // The two halves of key allocation, deliberately not one RETURNING statement: they only
  // ever run inside `createTicketTx`, where the transaction is what makes them atomic, and
  // two obvious statements beat one clever one in the place where being wrong renames a
  // ticket somebody else has already written down.
  const bumpTicketSeq = db.prepare(`UPDATE projects SET ticketSeq = ticketSeq + 1 WHERE id = ?`);
  const readTicketSeq = db.prepare(`SELECT ticketSeq FROM projects WHERE id = ?`);

  interface PersonRow {
    id: string;
    name: string;
    email: string | null;
    initials: string;
    color: string | null;
    isMe: number;
    createdAt: number;
  }

  function rowToPerson(r: PersonRow): Person {
    return {
      id: r.id,
      name: r.name,
      email: r.email ?? '',
      initials: r.initials,
      color: r.color ?? '',
      isMe: r.isMe !== 0,
      createdAt: r.createdAt,
    };
  }

  const selectPeople = db.prepare(`SELECT * FROM people ORDER BY createdAt, rowid`);
  const selectPerson = db.prepare(`SELECT * FROM people WHERE id = ?`);
  const insertPerson = db.prepare<[PersonRow]>(
    `INSERT INTO people (id, name, email, initials, color, isMe, createdAt)
     VALUES (@id, @name, @email, @initials, @color, @isMe, @createdAt)`,
  );
  const deletePersonStmt = db.prepare(`DELETE FROM people WHERE id = ?`);
  // What makes "me" singular in practice; the partial unique index is the backstop under it.
  const clearIsMe = db.prepare(`UPDATE people SET isMe = 0 WHERE isMe = 1`);
  const clearAssignee = db.prepare(`UPDATE tasks SET assigneeId = NULL WHERE assigneeId = ?`);
  const clearReporter = db.prepare(`UPDATE tasks SET reporterId = NULL WHERE reporterId = ?`);

  interface MilestoneRow {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    dueAt: number | null;
    color: string | null;
    closed: number;
    createdAt: number;
  }

  function rowToMilestone(r: MilestoneRow): Milestone {
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      description: r.description ?? '',
      dueAt: r.dueAt ?? null,
      color: r.color ?? '',
      closed: r.closed !== 0,
      createdAt: r.createdAt,
    };
  }

  // Earliest due first, and the undated LAST rather than first — SQLite sorts NULL before
  // everything, and a milestone nobody has dated is the one least worth the top of the list.
  const selectMilestones = db.prepare(
    `SELECT * FROM milestones WHERE projectId = ?
     ORDER BY dueAt IS NULL, dueAt, createdAt`,
  );
  const selectMilestone = db.prepare(`SELECT * FROM milestones WHERE id = ?`);
  const insertMilestone = db.prepare<[MilestoneRow]>(
    `INSERT INTO milestones (id, projectId, name, description, dueAt, color, closed, createdAt)
     VALUES (@id, @projectId, @name, @description, @dueAt, @color, @closed, @createdAt)`,
  );
  const deleteMilestoneStmt = db.prepare(`DELETE FROM milestones WHERE id = ?`);
  const clearMilestoneOnTasks = db.prepare(
    `UPDATE tasks SET milestoneId = NULL WHERE milestoneId = ?`,
  );

  interface TicketLabelRow {
    id: string;
    projectId: string;
    name: string;
    color: string | null;
    createdAt: number;
  }

  function rowToTicketLabel(r: TicketLabelRow): TicketLabel {
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      color: r.color ?? '',
      createdAt: r.createdAt,
    };
  }

  const selectTicketLabels = db.prepare(
    `SELECT * FROM ticket_labels WHERE projectId = ? ORDER BY createdAt, rowid`,
  );
  const selectTicketLabel = db.prepare(`SELECT * FROM ticket_labels WHERE id = ?`);
  const insertTicketLabel = db.prepare<[TicketLabelRow]>(
    `INSERT INTO ticket_labels (id, projectId, name, color, createdAt)
     VALUES (@id, @projectId, @name, @color, @createdAt)
     ON CONFLICT DO NOTHING`,
  );
  const updateTicketLabelStmt = db.prepare(
    `UPDATE ticket_labels SET name = @name, color = @color WHERE id = @id`,
  );
  const deleteTicketLabelStmt = db.prepare(`DELETE FROM ticket_labels WHERE id = ?`);
  // The rows a label rename or delete has to visit. Scoped to the label's own project,
  // because a label is per-project and two projects may perfectly well both have "backend".
  const selectLabelledTasks = db.prepare(
    `SELECT id, labels FROM tasks WHERE projectId = ? AND labels IS NOT NULL`,
  );
  const writeTaskLabels = db.prepare(`UPDATE tasks SET labels = @labels WHERE id = @id`);

  interface TicketLinkRow {
    id: string;
    fromTaskId: string;
    toTaskId: string;
    type: string;
    createdAt: number;
  }

  /** An unknown `type` degrades to `relates` — the weakest true thing — rather than
   *  dropping the link, exactly as `rowToTaskLink` degrades an unknown gate. */
  function rowToTicketLink(r: TicketLinkRow): TicketLink {
    return {
      id: r.id,
      fromTaskId: r.fromTaskId,
      toTaskId: r.toTaskId,
      type: isTicketLinkType(r.type) ? r.type : 'relates',
      createdAt: r.createdAt,
    };
  }

  const selectTicketLinks = db.prepare(`SELECT * FROM ticket_links ORDER BY createdAt, rowid`);
  const insertTicketLink = db.prepare<[TicketLinkRow]>(
    `INSERT INTO ticket_links (id, fromTaskId, toTaskId, type, createdAt)
     VALUES (@id, @fromTaskId, @toTaskId, @type, @createdAt)
     ON CONFLICT DO NOTHING`,
  );
  const deleteTicketLinkStmt = db.prepare(`DELETE FROM ticket_links WHERE id = ?`);

  const selectAttachments = db.prepare(`SELECT * FROM task_attachments ORDER BY createdAt, rowid`);
  const selectAttachmentsForTask = db.prepare(
    `SELECT * FROM task_attachments WHERE taskId = ? ORDER BY createdAt, rowid`,
  );
  const selectAttachment = db.prepare(`SELECT * FROM task_attachments WHERE id = ?`);
  // The attachments of a project's tasks — used to carry them across the
  // delete-and-reinsert a plan re-sync performs, exactly as the links above are.
  const selectAttachmentsForProject = db.prepare(
    `SELECT * FROM task_attachments
     WHERE taskId IN (SELECT id FROM tasks WHERE projectId = ?)
     ORDER BY createdAt, rowid`,
  );
  // No conflict target: DO NOTHING then covers the unique (taskId, name) AND the primary
  // key, so a re-inserted row on the plan-sync path is idempotent for free.
  const insertAttachment = db.prepare<[TaskAttachment]>(
    `INSERT INTO task_attachments
       (id, taskId, name, fileName, mimeType, size, createdAt, cloudBlobAt)
     VALUES (@id, @taskId, @name, @fileName, @mimeType, @size, @createdAt, @cloudBlobAt)
     ON CONFLICT DO NOTHING`,
  );
  const deleteAttachmentStmt = db.prepare(`DELETE FROM task_attachments WHERE id = ?`);
  // Only ever written by `cloudAttachmentUploader.ts`: a timestamp when the cloud took the
  // bytes, NULL when they are known not to be up there any more.
  const markAttachmentUploadedStmt = db.prepare(
    `UPDATE task_attachments SET cloudBlobAt = ? WHERE id = ?`,
  );

  const upsertAttentionStmt = db.prepare(
    `INSERT INTO attention_items
       (id, runId, taskId, projectId, taskTitle, kind, prompt, options, toolName, reason,
        worktreePath, branch, plan, steps, questions, context, createdAt)
     VALUES
       (@id, @runId, @taskId, @projectId, @taskTitle, @kind, @prompt, @options, @toolName,
        @reason, @worktreePath, @branch, @plan, @steps, @questions, @context, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       runId = excluded.runId, prompt = excluded.prompt, options = excluded.options,
       toolName = excluded.toolName, reason = excluded.reason,
       worktreePath = excluded.worktreePath, branch = excluded.branch,
       plan = excluded.plan, steps = excluded.steps, questions = excluded.questions,
       context = excluded.context`,
  );
  const deleteAttentionStmt = db.prepare(`DELETE FROM attention_items WHERE id = ?`);
  const selectAttentionStmt = db.prepare(`SELECT * FROM attention_items ORDER BY createdAt ASC`);
  const setMrName = db.prepare(`UPDATE merge_requests SET displayName = ? WHERE id = ?`);
  const markMrRead = db.prepare(`UPDATE merge_requests SET lastReadAt = ? WHERE id = ?`);
  const markMrEventsSeen = db.prepare(`UPDATE merge_requests SET lastEventSeenAt = ? WHERE id = ?`);

  // ---------------------------------------------------------------------------
  // One-shot: split "what this card is about" out of "where it runs".
  //
  // Both meanings lived in `agentProjectId`, so every card the user merely FILED under
  // a project reads as delegated to an agent. Each existing value becomes a project tag
  // (always true — you cannot delegate a card without also saying what it is about) and
  // the delegation is kept only where the card carries evidence of a real run.
  //
  // Guarded, and the guard is load-bearing: a second pass would examine a card the user
  // delegated AFTER the first, find no run on it yet, and silently clear the assignment.
  if (!selectState.get(PROJECT_TAG_SPLIT_KEY)) {
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE agentProjectId IS NOT NULL`)
      .all() as TaskRow[];
    const write = db.prepare(
      `UPDATE tasks SET projectTagId = @projectTagId, agentProjectId = @agentProjectId WHERE id = @id`,
    );
    db.transaction(() => {
      for (const row of rows) {
        const split = splitProjectTag(rowToTask(row));
        write.run({ id: row.id, ...split });
      }
      upsertState.run(PROJECT_TAG_SPLIT_KEY, JSON.stringify({ tasks: rows.length }));
    })();
  }
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // One-shot: let go of the model overrides the DIALOG wrote, not the human.
  //
  // NULL has always meant "use the project default" for `agentModel`, and every card
  // written before the assign dialog existed honoured that. The dialog then seeded its
  // dropdown from the project's own default and submitted it verbatim, so a card carries
  // an override whether or not anyone opened that dropdown — and a card whose override
  // EQUALS its project's default is indistinguishable from one that never chose.
  //
  // Left in place those rows outrank `projects.planningModel`, and the whole planning
  // model would appear to be ignored on precisely the cards people use. So the ones that
  // merely echo their project let go; a card whose model genuinely diverges (the deliberate
  // `opus` on a hard ticket) keeps it, because that is the one signal of intent the data
  // carries. Nothing about what those rows run today changes either way.
  //
  // Compared against the project that would actually RUN the card (`agentProjectId`, the
  // way `runProjectFor` resolves it) — not `task.projectId`, which for a board card is the
  // Personal board. A NULL subquery (no delegation, or one pointing somewhere that is not
  // an agent project) never matches, so those rows are left alone.
  //
  // Guarded like the split above, and for the same reason: a second pass would clear a
  // choice a human made deliberately after the first, one card at a time.
  //
  // `agentMode` has exactly the same history and is deliberately NOT touched — permission
  // mode is not what this is about, and `plan` mode carries meaning a model does not.
  if (!selectState.get(PINNED_MODEL_RELEASE_KEY)) {
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE tasks SET agentModel = NULL
            WHERE agentModel IS NOT NULL
              AND agentModel = (SELECT defaultModel FROM projects
                                 WHERE projects.id = tasks.agentProjectId
                                   AND projects.kind = 'agent')`,
        )
        .run();
      upsertState.run(PINNED_MODEL_RELEASE_KEY, JSON.stringify({ tasks: result.changes }));
    })();
  }
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // One-shot: claim every existing block as OURS.
  //
  // `preBlockStatus` now says who owns a block, and the JIRA sync preserves BLOCKED only
  // for the blocks that are ours — a tracker's own block arrives as a blocked status on
  // every poll and needs no preserving. But that field was only ever written by a drag, so
  // cards blocked any other way rest at `blocked` with a null marker, which the new rule
  // reads as the tracker's and the next sync would silently unblock. See
  // `blockOwnerMigration.ts` for why claiming them is the true answer and not just the
  // careful one.
  //
  // The SQL narrows; the pure predicate decides. `restingStatus` cannot be written in SQL
  // (a running card's block lives in `preRunStatus`), so this selects the superset both
  // shapes fall in and lets `needsBlockOwner` reject the rest.
  //
  // Guarded, and load-bearing again: after this pass null MEANS "the tracker holds this",
  // and a second one would overwrite that on every card JIRA has blocked since.
  if (!selectState.get(BLOCK_OWNER_KEY)) {
    const rows = db
      .prepare(
        `SELECT * FROM tasks
          WHERE preBlockStatus IS NULL AND (status = 'blocked' OR preRunStatus = 'blocked')`,
      )
      .all() as TaskRow[];
    const write = db.prepare(`UPDATE tasks SET preBlockStatus = @preBlockStatus WHERE id = @id`);
    db.transaction(() => {
      let claimed = 0;
      for (const row of rows) {
        const task = rowToTask(row);
        if (!needsBlockOwner(task)) continue;
        write.run({ id: row.id, preBlockStatus: blockOwnerFor(task) });
        claimed++;
      }
      upsertState.run(BLOCK_OWNER_KEY, JSON.stringify({ tasks: claimed }));
    })();
  }
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // One-shot: mirror the board that existed before the outbox triggers did.
  //
  // The triggers above only ever hear about a WRITE, so every project and card already on
  // this board when the mirror was switched on has no outbox row and never will until
  // somebody edits it — which is why the web app shows an empty board against a desktop full
  // of tickets. See `cloudOutboxBackfill.ts` for the ordering (projects first, parents before
  // steps) and for why both guards are needed: `NOT EXISTS` alone re-mirrors everything on
  // every launch once `pruneCloudOutbox` has cleared the acked rows, and the key alone loses
  // to a crash landing between the inserts and the guard.
  //
  // Last of the one-shots deliberately, and placed after every ALTER: the rows this queues
  // are the ones the mirror will resolve and send, so they should be the final shape of the
  // board rather than a state two migrations further up still intend to change.
  if (!selectState.get(CLOUD_OUTBOX_BACKFILL_KEY)) {
    db.transaction(() => {
      const queued = backfillCloudOutbox(db, Date.now());
      upsertState.run(CLOUD_OUTBOX_BACKFILL_KEY, JSON.stringify(queued));
    })();
  }
  // ---------------------------------------------------------------------------

  /** Read app settings, merging any stored fields over the built-in defaults. */
  function getSettings(): AppSettings {
    const row = selectState.get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(row.value) as Partial<AppSettings>;
      // Deep-merge EVERY nested block so a stored blob missing newer fields (or lacking
      // the block entirely) still fills them from the defaults. `gitlab` matters as much
      // as `jira` here: without it every existing user would load `gitlab: undefined`
      // and the poller would throw on `.enabled` at startup.
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        jira: { ...DEFAULT_JIRA_SETTINGS, ...(parsed.jira ?? {}) },
        gitlab: { ...DEFAULT_GITLAB_SETTINGS, ...(parsed.gitlab ?? {}) },
        github: { ...DEFAULT_GITHUB_SETTINGS, ...(parsed.github ?? {}) },
        cloud: { ...DEFAULT_CLOUD_SETTINGS, ...(parsed.cloud ?? {}) },
        board: { ...DEFAULT_BOARD_DISPLAY, ...(parsed.board ?? {}) },
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** SQLite stores writeBackPlan as 0/1; present it to the app as a real boolean. */
  function rowToProject(r: ProjectRow): Project {
    return {
      id: r.id,
      name: r.name,
      path: r.path,
      planPath: r.planPath,
      defaultModel: r.defaultModel as Project['defaultModel'],
      // NULL stays null — it is the value that means "plan on whatever you execute on",
      // not a missing model. Collapsing it to `defaultModel` here would read back as an
      // explicit choice and the dropdown would stop being able to say "same as execution".
      planningModel: (r.planningModel as Project['planningModel']) ?? null,
      defaultPermissionMode: r.defaultPermissionMode as Project['defaultPermissionMode'],
      concurrency: r.concurrency,
      useWorktrees: r.useWorktrees !== 0,
      baseBranch: r.baseBranch ?? '',
      writeBackPlan: r.writeBackPlan !== 0,
      autoRelease: r.autoRelease !== 0,
      autoCreatePr: r.autoCreatePr !== 0,
      // NULL stays null: a real third state ("this project has not ruled"), which follows
      // the app-wide setting. Collapsing it to false here would pin every project to
      // "never merge" the first time it was read.
      autoIntegrate:
        r.autoIntegrate === null || r.autoIntegrate === undefined ? null : r.autoIntegrate !== 0,
      planAligned: r.planAligned !== 0,
      jiraEpicKeys: parseStringArray(r.jiraEpicKeys),
      // NULL — "this project has no prefix" — presents as '' for the same reason `color`
      // and `baseBranch` do: the renderer's absent value is an empty string, and the NULL
      // exists only so the partial unique index can ignore the rows that have none.
      // `ticketSeq` is deliberately NOT read out: it is the allocator, not a property.
      ticketPrefix: r.ticketPrefix ?? '',
      target: parseExecTarget(r.target),
      instructions: r.instructions ?? '',
      color: r.color ?? '',
      createdAt: r.createdAt,
    };
  }

  /** Read a JSON string-array column (`dependsOn`, `jiraEpicKeys`) back (NULL/garbage → []). */
  function parseStringArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Read a JSON object/array column back, or null when it is absent or unparseable.
   *
   * The caller decides what a missing value means: an inbox item with no `questions`
   * degrades to a free-text prompt, which is still answerable — dropping the whole item
   * because one column was written by an older build would not be.
   */
  function parseJsonColumn<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Serialize a Task to its stored row shape (dependsOn → JSON text). */
  function taskToRow(task: Task): TaskRow {
    return {
      id: task.id,
      projectId: task.projectId,
      phase: task.phase,
      title: task.title,
      status: task.status,
      sessionId: task.sessionId,
      order: task.order,
      source: task.source,
      dependsOn: JSON.stringify(task.dependsOn ?? []),
      isContract: task.isContract ? 1 : 0,
      isScaffold: task.isScaffold ? 1 : 0,
      type: task.type ?? null,
      parentTaskId: task.parentTaskId ?? null,
      description: task.description ?? null,
      statusNote: task.statusNote ?? null,
      statusNoteAt: task.statusNoteAt ?? null,
      // External linkage — coalesce undefined → null so named params are always bound.
      externalSource: task.externalSource ?? null,
      externalKey: task.externalKey ?? null,
      externalId: task.externalId ?? null,
      externalUrl: task.externalUrl ?? null,
      externalStatus: task.externalStatus ?? null,
      externalStatusCategory: task.externalStatusCategory ?? null,
      externalPriority: task.externalPriority ?? null,
      externalType: task.externalType ?? null,
      externalLabel: task.externalLabel ?? null,
      externalParentKey: task.externalParentKey ?? null,
      externalEpicName: task.externalEpicName ?? null,
      externalSprint: task.externalSprint ?? null,
      externalDescription: task.externalDescription ?? null,
      preBlockStatus: task.preBlockStatus ?? null,
      preRunStatus: task.preRunStatus ?? null,
      retainedSince: task.retainedSince ?? null,
      archivedAt: task.archivedAt ?? null,
      archivedReason: task.archivedReason ?? null,
      lastReadCommentAt: task.lastReadCommentAt ?? null,
      latestCommentAt: task.latestCommentAt ?? null,
      projectTagId: task.projectTagId ?? null,
      agentProjectId: task.agentProjectId ?? null,
      agentMode: task.agentMode ?? null,
      agentModel: task.agentModel ?? null,
      agentPlan: task.agentPlan ?? null,
      agentBranch: task.agentBranch ?? null,
      planRound: task.planRound ?? null,
      landedAt: task.landedAt ?? null,
      chainLandedAt: task.chainLandedAt ?? null,
      workedAt: task.workedAt ?? null,
      stoppedAt: task.stoppedAt ?? null,
      // Three states in one column: 1 = release, 0 = don't, NULL = follow the project.
      autoRelease:
        task.autoRelease === null || task.autoRelease === undefined
          ? null
          : task.autoRelease
            ? 1
            : 0,
      // Same three states again: 1 = open a PR, 0 = don't, NULL = follow the project.
      autoCreatePr:
        task.autoCreatePr === null || task.autoCreatePr === undefined
          ? null
          : task.autoCreatePr
            ? 1
            : 0,
      // Same three states, same reason: 1 = merge, 0 = don't, NULL = follow the project.
      autoIntegrate:
        task.autoIntegrate === null || task.autoIntegrate === undefined
          ? null
          : task.autoIntegrate
            ? 1
            : 0,
      // Native tickets. All plain values except `labels`, which is a JSON array of names in
      // one column — the same encoding `dependsOn` uses above, read back by
      // `parseStringArray`.
      ticketKey: task.ticketKey ?? null,
      ticketNumber: task.ticketNumber ?? null,
      issueType: task.issueType ?? null,
      epicTaskId: task.epicTaskId ?? null,
      milestoneId: task.milestoneId ?? null,
      labels: JSON.stringify(normalizeLabels(task.labels)),
      storyPoints: task.storyPoints ?? null,
      estimateDays: task.estimateDays ?? null,
      startAt: task.startAt ?? null,
      dueAt: task.dueAt ?? null,
      assigneeId: task.assigneeId ?? null,
      reporterId: task.reporterId ?? null,
    };
  }

  function rowToTask(r: TaskRow): Task {
    return {
      id: r.id,
      projectId: r.projectId,
      phase: r.phase,
      title: r.title,
      status: r.status as Task['status'],
      sessionId: r.sessionId,
      order: r.order,
      source: (r.source as Task['source']) ?? 'plan',
      dependsOn: parseStringArray(r.dependsOn),
      isContract: r.isContract !== 0,
      isScaffold: r.isScaffold !== 0,
      type: (r.type as Task['type']) ?? null,
      parentTaskId: r.parentTaskId,
      description: r.description,
      statusNote: r.statusNote,
      statusNoteAt: r.statusNoteAt,
      externalSource: (r.externalSource as Task['externalSource']) ?? null,
      externalKey: r.externalKey,
      externalId: r.externalId,
      externalUrl: r.externalUrl,
      externalStatus: r.externalStatus,
      externalStatusCategory: (r.externalStatusCategory as Task['externalStatusCategory']) ?? null,
      externalPriority: r.externalPriority,
      externalType: r.externalType,
      externalLabel: r.externalLabel,
      externalParentKey: r.externalParentKey,
      externalEpicName: r.externalEpicName,
      externalSprint: r.externalSprint,
      externalDescription: r.externalDescription,
      preBlockStatus: (r.preBlockStatus as Task['preBlockStatus']) ?? null,
      preRunStatus: (r.preRunStatus as Task['preRunStatus']) ?? null,
      retainedSince: r.retainedSince ?? null,
      archivedAt: r.archivedAt ?? null,
      archivedReason: (r.archivedReason as Task['archivedReason']) ?? null,
      lastReadCommentAt: r.lastReadCommentAt,
      latestCommentAt: r.latestCommentAt,
      projectTagId: r.projectTagId,
      agentProjectId: r.agentProjectId,
      agentMode: (r.agentMode as Task['agentMode']) ?? null,
      agentModel: (r.agentModel as Task['agentModel']) ?? null,
      agentPlan: r.agentPlan,
      agentBranch: r.agentBranch,
      // Every step that predates re-planning came from the card's one and only approved
      // plan, so NULL is round 1 — not "no round", which would leave the panel unable to
      // group the very rows the grouping exists for.
      planRound: r.planRound ?? 1,
      landedAt: r.landedAt ?? null,
      chainLandedAt: r.chainLandedAt ?? null,
      workedAt: r.workedAt ?? null,
      stoppedAt: r.stoppedAt ?? null,
      // NULL stays null — it is a real third state ("this card has not ruled"), not a
      // missing false, and collapsing it here would pin every card to whatever the
      // project's preference was the first time it was read.
      autoRelease:
        r.autoRelease === null || r.autoRelease === undefined ? null : r.autoRelease !== 0,
      // Ditto — see `@shared/pullRequest`; the null is the card saying nothing, not "no".
      autoCreatePr:
        r.autoCreatePr === null || r.autoCreatePr === undefined ? null : r.autoCreatePr !== 0,
      // Ditto — see `@shared/integrate` for why the null must survive the round trip.
      autoIntegrate:
        r.autoIntegrate === null || r.autoIntegrate === undefined ? null : r.autoIntegrate !== 0,
      ticketKey: r.ticketKey ?? null,
      ticketNumber: r.ticketNumber ?? null,
      // Validated rather than cast, the way `rowToTaskLink` validates its gate: an issue
      // type written by a newer build reads back as "no type" — the neutral icon — instead
      // of being asserted into a union it is not in.
      issueType: r.issueType && isIssueType(r.issueType) ? r.issueType : null,
      epicTaskId: r.epicTaskId ?? null,
      milestoneId: r.milestoneId ?? null,
      labels: parseStringArray(r.labels),
      storyPoints: r.storyPoints ?? null,
      estimateDays: r.estimateDays ?? null,
      startAt: r.startAt ?? null,
      dueAt: r.dueAt ?? null,
      assigneeId: r.assigneeId ?? null,
      reporterId: r.reporterId ?? null,
    };
  }

  function getTasks(projectId: string): Task[] {
    return (selectTasks.all(projectId) as TaskRow[]).map(rowToTask);
  }

  /** The cards ON one board, archived rows excluded. See the interface for what "a board"
   *  means now that the Personal one is not the only kind. */
  function getBoardTasks(projectId: string): Task[] {
    return (selectBoardTasks.all(projectId) as TaskRow[]).map(rowToTask);
  }

  /** The archived cards of one board, most recently archived first. */
  function getArchivedTasksFor(projectId: string): Task[] {
    return (selectArchivedBoardTasks.all(projectId) as TaskRow[]).map(rowToTask);
  }

  /** Every board's cards, unioned. See the interface for the ordering rule. */
  function getAllBoardTasks(): Task[] {
    return (selectAllBoardTasks.all() as TaskRow[]).map(rowToTask);
  }

  /** Every board's archived cards, unioned. See `getAllBoardTasks`. */
  function getAllArchivedBoardTasks(): Task[] {
    return (selectAllArchivedBoardTasks.all() as TaskRow[]).map(rowToTask);
  }

  function getTask(id: string): Task | undefined {
    const row = selectTask.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Destroy a task, its steps, and their timelines and transcripts, in one transaction.
   *
   * Shared by `deleteTask` (the human said so) and `pruneArchivedBefore` (the retention clock
   * ran out), so the two cannot drift into deleting different amounts of a card. The plan-sync
   * path deliberately does NOT come through here — it replaces rows wholesale and must leave
   * plan history alone.
   */
  const deleteTaskDeep = db.transaction((taskId: string) => {
    // Deleting a card takes its steps with it — an orphaned step has no board column of its
    // own and would otherwise be unreachable in the UI.
    const children = (selectSubtaskIds.all(taskId) as Array<{ id: string }>).map((r) => r.id);
    for (const childId of [...children, taskId]) {
      // A step can never be somebody's epic, but running this unconditionally is cheap and
      // keeps the loop uniform — the same argument `deleteActivityForTask` already rests on.
      clearEpicOnTasks.run(childId);
      deleteActivityForTask.run(childId);
      deleteEventsForTask.run(childId);
      deleteTask.run(childId);
    }
  });

  /**
   * Allocate a key and insert a ticket, atomically.
   *
   * The bump and the insert are one transaction so that a refused create never burns a
   * number, and the number comes from the project's own counter and **never** from
   * `MAX(ticketNumber)`: deleting `TM-500` must not make the next ticket `TM-500` again,
   * because a key is a permanent name and re-issuing one makes every note, branch and link
   * that ever mentioned it a lie. This is the first place in this app where skipping a
   * transaction would corrupt a *name* rather than a row.
   *
   * Every refusal is checked BEFORE the bump, so it costs nothing. The one that cannot be
   * (another project holding this prefix, caught by the partial unique index) throws out of
   * the statement and rolls the counter back with it.
   */
  const createTicketTx = db.transaction(
    (projectId: string, input: TicketInput): Task | undefined => {
      const title = input.title.trim();
      if (!title) return undefined;
      const projectRow = selectProject.get(projectId) as ProjectRow | undefined;
      if (!projectRow) return undefined;
      const project = rowToProject(projectRow);
      // That board's cards come from its plan file, not a manual add — checked here too,
      // not only at the IPC boundary, because a migrated or hand-edited project can carry a
      // ticketPrefix left over from before this rule existed without that prefix reviving
      // manual filing on it. "No ticket" rather than an exception, as with `addTaskLink`.
      if (hasPlan(project)) return undefined;
      // Only a prefixed project has an allocator to name what it creates.
      const prefix = normalizeTicketPrefix(project.ticketPrefix);
      if (!prefix) return undefined;

      bumpTicketSeq.run(projectId);
      const ticketNumber = (readTicketSeq.get(projectId) as { ticketSeq: number }).ticketSeq;

      const task: Task = {
        id: randomUUID(),
        projectId,
        phase: input.phase?.trim() ?? '',
        title,
        status: 'pending',
        sessionId: null,
        order: (nextOrder.get(projectId) as { next: number }).next,
        // Its own value, not `adhoc`: this is the structural guarantee that the JIRA
        // reconciler — which filters on `source === 'jira'` in both directions — can never
        // adopt, rewrite or archive a ticket this app owns.
        source: 'ticket',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
        // The card's brief goes where every other surface already reads one from
        // (`Task.description` is a step's brief, which a ticket is not).
        externalDescription: input.description?.trim() || null,
        // Native tickets reuse the priority column JIRA cards use — see `TicketInput.priority`.
        externalPriority: input.priority?.trim() || null,
        ticketKey: formatTicketKey(prefix, ticketNumber),
        ticketNumber,
        issueType: input.issueType ?? 'task',
        epicTaskId: input.epicTaskId ?? null,
        milestoneId: input.milestoneId ?? null,
        labels: normalizeLabels(input.labels),
        storyPoints: input.storyPoints ?? null,
        estimateDays: input.estimateDays ?? null,
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        assigneeId: input.assigneeId ?? null,
        reporterId: input.reporterId ?? null,
      };
      insertTask.run(taskToRow(task));
      return getTask(task.id);
    },
  );

  /** Delete a person and null every ticket that pointed at them, in one transaction — see
   *  the interface for why this is not an `ON DELETE SET NULL` cascade. */
  const deletePersonTx = db.transaction((id: string) => {
    clearAssignee.run(id);
    clearReporter.run(id);
    deletePersonStmt.run(id);
  });

  /** The same shape one level down: the milestone goes, and its tickets lose the pointer. */
  const deleteMilestoneTx = db.transaction((id: string) => {
    clearMilestoneOnTasks.run(id);
    deleteMilestoneStmt.run(id);
  });

  /**
   * Rewrite one label name across a project's tickets — `from` → `to`, or `to = null` to
   * strip it.
   *
   * In JS rather than SQL because the column is a JSON array and the edit is per-row; the
   * transaction is what makes it one change. Matched **case-blind**, mirroring the registry's
   * `COLLATE NOCASE`: a ticket wearing `Backend` when the registry says `backend` is wearing
   * that label, and a rename that missed it would leave an orphan chip nothing can remove.
   */
  const rewriteLabelOnTasks = (projectId: string, from: string, to: string | null): void => {
    const wanted = from.trim().toLowerCase();
    if (!wanted) return;
    const rows = selectLabelledTasks.all(projectId) as Array<{ id: string; labels: string | null }>;
    for (const row of rows) {
      const labels = parseStringArray(row.labels);
      if (!labels.some((name) => name.trim().toLowerCase() === wanted)) continue;
      const next =
        to === null
          ? labels.filter((name) => name.trim().toLowerCase() !== wanted)
          : labels.map((name) => (name.trim().toLowerCase() === wanted ? to : name));
      writeTaskLabels.run({ id: row.id, labels: JSON.stringify(normalizeLabels(next)) });
    }
  };

  const updateTicketLabelTx = db.transaction((next: TicketLabelRow, previousName: string) => {
    updateTicketLabelStmt.run(next);
    // Only a RENAME touches the tickets — a colour change is the registry's business alone.
    if (next.name.trim().toLowerCase() !== previousName.trim().toLowerCase()) {
      rewriteLabelOnTasks(next.projectId, previousName, next.name);
    }
  });

  const deleteTicketLabelTx = db.transaction((row: TicketLabelRow) => {
    deleteTicketLabelStmt.run(row.id);
    rewriteLabelOnTasks(row.projectId, row.name, null);
  });

  // The cloud mirror's outbox reader (Phase 25). Reads a raw window well past `limit` so
  // `shapeCloudDelta` has enough repeated rows to actually collapse — a card edited five
  // times between syncs must still cost the caller one entity, not five.
  const OUTBOX_READ_MULTIPLE = 8;
  const selectCloudOutboxSince = db.prepare(
    `SELECT seq, entity, entityId, op, at FROM cloud_outbox WHERE seq > ? ORDER BY seq LIMIT ?`,
  );
  const deleteCloudOutboxThrough = db.prepare(`DELETE FROM cloud_outbox WHERE seq <= ?`);

  // The cloud mirror's applied-command ledger (Phase 25's "Apply queued cloud commands on
  // the client") — see the schema comment above `cloud_applied_commands`.
  const selectCloudCommandOutcome = db.prepare(
    `SELECT result FROM cloud_applied_commands WHERE id = ?`,
  );
  const insertCloudCommandApplied = db.prepare(
    `INSERT OR IGNORE INTO cloud_applied_commands (id, appliedAt, ackedAt, result, resultSentAt)
     VALUES (?, ?, NULL, ?, ?)`,
  );
  const selectPendingCloudAcks = db.prepare(
    `SELECT id FROM cloud_applied_commands WHERE ackedAt IS NULL`,
  );
  const markCloudAckSent = db.prepare(`UPDATE cloud_applied_commands SET ackedAt = ? WHERE id = ?`);
  const selectPendingCloudResults = db.prepare(
    `SELECT id, result FROM cloud_applied_commands
      WHERE resultSentAt IS NULL AND result IS NOT NULL ORDER BY appliedAt`,
  );
  const markCloudResultSent = db.prepare(
    `UPDATE cloud_applied_commands SET resultSentAt = ? WHERE id = ?`,
  );

  return {
    addProject(input) {
      // Unspecified project fields inherit the user's global defaults (Phase 6). No
      // branching on a `kind` any more — a project simply carries whatever the caller
      // gave it, and empty fields are what make it a bare repo, a ticket project, or the
      // Personal board rather than a plan-driven one (see `hasPlan`/`hasRepo`/`ownsTickets`
      // in `@shared/model`).
      const defaults = getSettings();
      const ticketPrefix = normalizeTicketPrefix(input.ticketPrefix ?? '') ?? '';
      const path = input.path ?? '';
      const project: Project = {
        id: randomUUID(),
        // A project with no directory has nothing to be named after `basename('')` is
        // `''`, so it falls back to the ticket prefix rather than going nameless.
        name: input.name?.trim() || basename(path) || ticketPrefix,
        path,
        // `hostJoin`, not `path.join`: for a WSL project the path is a Linux one, and
        // joining it on Windows would produce `/home/you/repo\plan.md`. Only defaulted
        // when there is a directory to put it in — a project with no `path` stays
        // plan-less unless the caller names a `planPath` of its own.
        planPath: input.planPath ?? (path ? hostJoin(path, 'plan.md') : ''),
        defaultModel: input.defaultModel ?? defaults.defaultModel,
        // Seeded from the app-wide default like `defaultModel`, and null all the way down
        // unless someone has set one — a new project plans on what it executes on.
        //
        // `undefined` and `null` part company here, unlike every other field on this
        // object: the add dialogs offer "Same as steps execution" as a real choice and
        // submit it as `null`, so `??` would quietly hand that project the app-wide seed
        // the human just declined. Only a caller that omits the key gets the seed.
        planningModel:
          input.planningModel !== undefined
            ? input.planningModel
            : (defaults.defaultPlanningModel ?? null),
        defaultPermissionMode: input.defaultPermissionMode ?? defaults.defaultPermissionMode,
        concurrency: Math.max(1, Math.round(input.concurrency ?? defaults.concurrency)),
        useWorktrees: input.useWorktrees ?? true,
        baseBranch: input.baseBranch?.trim() ?? '',
        writeBackPlan: input.writeBackPlan ?? defaults.writeBackPlan,
        // Off unless asked for: releasing is the one thing a human is entitled to have
        // never happen by accident.
        autoRelease: input.autoRelease ?? false,
        // Off unless asked for, for the same reason: pushing a branch to somebody's forge
        // and opening a pull request on it is not something to start doing by surprise.
        autoCreatePr: input.autoCreatePr ?? false,
        // `null` unless the caller ruled: a new project inherits the app-wide switch and
        // keeps inheriting it, rather than freezing today's value into the row.
        autoIntegrate: input.autoIntegrate ?? null,
        // New projects are trusted as aligned; legacy projects backfill to false via
        // the migration above. A plan carrying `@needs:`/`@contract` is also confirmed
        // aligned on its next sync (see ipc `syncProjectPlan`).
        planAligned: input.planAligned ?? true,
        jiraEpicKeys: normalizeEpicKeys(input.jiraEpicKeys),
        ticketPrefix,
        target: input.target ?? defaults.defaultExecTarget,
        instructions: input.instructions?.trim() ?? '',
        color: input.color?.trim() ?? '',
        createdAt: Date.now(),
      };
      insertProject.run({
        ...project,
        useWorktrees: project.useWorktrees ? 1 : 0,
        writeBackPlan: project.writeBackPlan ? 1 : 0,
        autoRelease: project.autoRelease ? 1 : 0,
        autoCreatePr: project.autoCreatePr ? 1 : 0,
        autoIntegrate: project.autoIntegrate === null ? null : project.autoIntegrate ? 1 : 0,
        planAligned: project.planAligned ? 1 : 0,
        // A derived legacy label — nothing in this build reads it back (`rowToProject`
        // skips it), kept only for whatever outside this build still looks at the column.
        kind: project.planPath ? 'plan' : project.path ? 'agent' : 'ticket',
        jiraEpicKeys: JSON.stringify(project.jiraEpicKeys),
        // '' goes in as NULL: the partial unique index ignores NULLs, and every project
        // that is not a ticket project would otherwise collide with the next one on ''.
        ticketPrefix: project.ticketPrefix || null,
        // The allocator starts at zero, so the first key this project ever issues is `-1`.
        ticketSeq: 0,
        target: formatExecTarget(project.target),
      });
      return project;
    },

    listProjects() {
      return (selectProjects.all() as ProjectRow[]).map(rowToProject);
    },

    getProject(id) {
      const row = selectProject.get(id) as ProjectRow | undefined;
      return row ? rowToProject(row) : undefined;
    },

    removeProject(id) {
      deleteProject.run(id);
    },

    setWriteBack(id, enabled) {
      updateWriteBack.run(enabled ? 1 : 0, id);
    },

    setPlanAligned(id, aligned) {
      updatePlanAligned.run(aligned ? 1 : 0, id);
    },

    updateProject(id, patch) {
      // Build a dynamic UPDATE from only the provided fields (like updateTask).
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.name !== undefined) {
        sets.push(`name = @name`);
        params.name = patch.name;
      }
      if (patch.path !== undefined) {
        sets.push(`path = @path`);
        params.path = patch.path;
      }
      if (patch.planPath !== undefined) {
        sets.push(`planPath = @planPath`);
        params.planPath = patch.planPath;
      }
      if (patch.defaultModel !== undefined) {
        sets.push(`defaultModel = @defaultModel`);
        params.defaultModel = patch.defaultModel;
      }
      // `null` is a value the caller may really mean ("plan on the execution model again"),
      // so this too is tested against `undefined` rather than falsiness.
      if (patch.planningModel !== undefined) {
        sets.push(`planningModel = @planningModel`);
        params.planningModel = patch.planningModel ?? null;
      }
      if (patch.defaultPermissionMode !== undefined) {
        sets.push(`defaultPermissionMode = @defaultPermissionMode`);
        params.defaultPermissionMode = patch.defaultPermissionMode;
      }
      if (patch.concurrency !== undefined) {
        sets.push(`concurrency = @concurrency`);
        params.concurrency = Math.max(1, Math.round(patch.concurrency));
      }
      if (patch.useWorktrees !== undefined) {
        sets.push(`useWorktrees = @useWorktrees`);
        params.useWorktrees = patch.useWorktrees ? 1 : 0;
      }
      if (patch.baseBranch !== undefined) {
        sets.push(`baseBranch = @baseBranch`);
        params.baseBranch = patch.baseBranch.trim();
      }
      if (patch.writeBackPlan !== undefined) {
        sets.push(`writeBackPlan = @writeBackPlan`);
        params.writeBackPlan = patch.writeBackPlan ? 1 : 0;
      }
      if (patch.autoCreatePr !== undefined) {
        sets.push(`autoCreatePr = @autoCreatePr`);
        params.autoCreatePr = patch.autoCreatePr ? 1 : 0;
      }
      if (patch.autoRelease !== undefined) {
        sets.push(`autoRelease = @autoRelease`);
        params.autoRelease = patch.autoRelease ? 1 : 0;
      }
      // `null` is a value the caller may really mean here ("this project follows the app
      // setting again"), which is why it is tested against `undefined` rather than falsiness.
      if (patch.autoIntegrate !== undefined) {
        sets.push(`autoIntegrate = @autoIntegrate`);
        params.autoIntegrate = patch.autoIntegrate === null ? null : patch.autoIntegrate ? 1 : 0;
      }
      if (patch.planAligned !== undefined) {
        sets.push(`planAligned = @planAligned`);
        params.planAligned = patch.planAligned ? 1 : 0;
      }
      if (patch.jiraEpicKeys !== undefined) {
        sets.push(`jiraEpicKeys = @jiraEpicKeys`);
        params.jiraEpicKeys = JSON.stringify(normalizeEpicKeys(patch.jiraEpicKeys));
      }
      if (patch.target !== undefined) {
        sets.push(`target = @target`);
        params.target = formatExecTarget(patch.target);
      }
      if (patch.instructions !== undefined) {
        sets.push(`instructions = @instructions`);
        params.instructions = patch.instructions.trim();
      }
      if (patch.color !== undefined) {
        sets.push(`color = @color`);
        params.color = patch.color.trim();
      }
      // The prefix is the one patch field that rewrites OTHER rows: every ticket carries a
      // denormalised `ticketKey`, so renaming `TM` to `PLAT` has to re-key them or the
      // board would go on showing a prefix the project no longer has. The numbers are
      // untouched — those are what a ticket durably IS.
      //
      // Clearing it is refused rather than obeyed once the project has issued keys: a key
      // is a permanent name, and there is no way to write "no prefix" onto `TM-14` that
      // leaves it still called anything. The returned project says what actually stuck.
      const before = selectProject.get(id) as ProjectRow | undefined;
      let rekeyTo: string | null = null;
      if (before && patch.ticketPrefix !== undefined) {
        const wanted = normalizeTicketPrefix(patch.ticketPrefix);
        const issued = (countProjectTickets.get(id) as { n: number }).n;
        if (wanted !== null || issued === 0) {
          if (wanted !== (before.ticketPrefix ?? null)) {
            sets.push(`ticketPrefix = @ticketPrefix`);
            params.ticketPrefix = wanted;
            rekeyTo = wanted;
          }
        }
      }
      if (sets.length > 0) {
        const write = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`);
        // One transaction, so a rename that collides with another project's prefix (the
        // partial unique index) leaves the tickets under the name they already had rather
        // than half re-keyed.
        db.transaction(() => {
          write.run(params);
          if (rekeyTo !== null) rekeyProjectTickets.run({ id, prefix: rekeyTo });
        })();
      }
      const row = selectProject.get(id) as ProjectRow | undefined;
      return row ? rowToProject(row) : undefined;
    },

    getTasks,

    getTask,

    updateTask(id, patch) {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      // Columns patchable through this method. `"order"` needs quoting so it's kept
      // out of this set; status/sessionId plus the external-linkage fields are all
      // plain columns whose param name matches the column name. `parentTaskId` is
      // deliberately absent — a step belongs to the card it was created under, and
      // re-parenting would silently move it between worktrees.
      const columns = [
        'status',
        'sessionId',
        'title',
        'description',
        'statusNote',
        'statusNoteAt',
        'externalSource',
        'externalKey',
        'externalId',
        'externalUrl',
        'externalStatus',
        'externalStatusCategory',
        'externalPriority',
        'externalType',
        'externalLabel',
        'externalParentKey',
        'externalEpicName',
        'externalSprint',
        'externalDescription',
        'preBlockStatus',
        'preRunStatus',
        'lastReadCommentAt',
        'latestCommentAt',
        'projectTagId',
        'agentProjectId',
        'agentMode',
        'agentModel',
        'agentPlan',
        'agentBranch',
        'landedAt',
        'chainLandedAt',
        'workedAt',
        'stoppedAt',
        // Native tickets. `ticketKey`/`ticketNumber` are deliberately absent, for the same
        // kind of reason `parentTaskId` is: a key is a permanent name, and the only thing
        // allowed to rewrite one is a prefix rename, which re-keys the whole project at
        // once. `labels` is absent too, but only because it needs encoding — see below.
        'issueType',
        'epicTaskId',
        'milestoneId',
        'storyPoints',
        'estimateDays',
        'startAt',
        'dueAt',
        'assigneeId',
        'reporterId',
      ] as const;
      for (const col of columns) {
        const value = (patch as Record<string, unknown>)[col];
        if (value !== undefined) {
          sets.push(`${col} = @${col}`);
          params[col] = value;
        }
      }
      // Handled apart from the loop above: SQLite has no boolean, and better-sqlite3
      // refuses to bind one — while `null` here is a value the caller may really mean
      // ("this card follows its project again"), not an absent field.
      if (patch.autoCreatePr !== undefined) {
        sets.push(`autoCreatePr = @autoCreatePr`);
        params.autoCreatePr = patch.autoCreatePr === null ? null : patch.autoCreatePr ? 1 : 0;
      }
      if (patch.autoRelease !== undefined) {
        sets.push(`autoRelease = @autoRelease`);
        params.autoRelease = patch.autoRelease === null ? null : patch.autoRelease ? 1 : 0;
      }
      if (patch.autoIntegrate !== undefined) {
        sets.push(`autoIntegrate = @autoIntegrate`);
        params.autoIntegrate = patch.autoIntegrate === null ? null : patch.autoIntegrate ? 1 : 0;
      }
      // Apart from the loop for the other reason a column can be: it is a JSON array in one
      // column, not a scalar, so the loop above would bind an Array and better-sqlite3
      // refuses anything that is not a number, string, bigint, Buffer or null.
      if (patch.labels !== undefined) {
        sets.push(`labels = @labels`);
        params.labels = JSON.stringify(normalizeLabels(patch.labels));
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return getTask(id);
    },

    getBoardTasks,

    getArchivedTasksFor,

    getAllBoardTasks,

    getAllArchivedBoardTasks,

    // The Personal three, now wrappers on the general form above. They stay hard-wired to
    // PERSONAL_PROJECT_ID rather than growing an argument, and that is what keeps the JIRA
    // sync structurally unable to see a ticket project: it calls
    // `getPersonalTasksForSync()`, which cannot be pointed anywhere else.
    getPersonalTasks() {
      return getBoardTasks(PERSONAL_PROJECT_ID);
    },

    getPersonalTasksForSync() {
      return getTasks(PERSONAL_PROJECT_ID);
    },

    getArchivedTasks() {
      return getArchivedTasksFor(PERSONAL_PROJECT_ID);
    },

    archiveTask(id, at, reason = null) {
      const task = getTask(id);
      // A step is not on the board — it is drawn under its parent — so it has no independent
      // way off it. Archiving one would leave a row `getArchivedTasks` shows with no card to
      // restore it through, and which the retention sweep (cards only) would never collect.
      if (!task || task.parentTaskId || task.archivedAt != null) return undefined;
      archiveTaskStmt.run({ id, at, reason });
      return getTask(id);
    },

    unarchiveTask(id) {
      if (!getTask(id)) return undefined;
      unarchiveTaskStmt.run({ id });
      return getTask(id);
    },

    pruneArchivedBefore(cutoff) {
      const ids = (selectArchivedBefore.all(cutoff) as Array<{ id: string }>).map((r) => r.id);
      for (const id of ids) deleteTaskDeep(id);
      return ids.length;
    },

    upsertJiraTask(task) {
      const existing = selectTask.get(task.id) as TaskRow | undefined;
      if (existing) {
        // Note the filing column (`projectTagId`), the agent-delegation columns
        // (`agentProjectId`, `agentMode`, `agentModel`, `agentPlan`, `agentBranch`), the
        // subtask columns (`parentTaskId`, `description`) and the card's own progress note
        // (`statusNote`, `statusNoteAt`) are deliberately absent from the UPDATE: a JIRA
        // re-sync refreshes tracker fields only and must never clear a human's agent
        // assignment, the branch it runs on, the plan that assignment produced, the steps
        // derived from it, or what they last said about where the card is.
        //
        // `archivedAt` and `archivedReason` are absent for the same reason and one sharper
        // still: whether a card is on the board is not a tracker field at all — JIRA has never
        // heard of it, so a row built from an issue carries `archivedAt: null` whether or not
        // the card is archived, and listing them here would mean any sync that so much as
        // touched a removed card put it silently back on the board. Archiving and restoring go
        // through `archiveTask` / `unarchiveTask`, which write those two columns and nothing
        // else.
        db.prepare(
          `UPDATE tasks SET
             phase = @phase, title = @title, status = @status, "order" = @order, source = @source,
             externalSource = @externalSource, externalKey = @externalKey, externalId = @externalId,
             externalUrl = @externalUrl, externalStatus = @externalStatus,
             externalStatusCategory = @externalStatusCategory, externalPriority = @externalPriority,
             externalType = @externalType, externalLabel = @externalLabel,
             externalParentKey = @externalParentKey, externalEpicName = @externalEpicName,
             externalSprint = @externalSprint,
             externalDescription = @externalDescription,
             preBlockStatus = @preBlockStatus, preRunStatus = @preRunStatus,
             retainedSince = @retainedSince,
             lastReadCommentAt = @lastReadCommentAt,
             latestCommentAt = @latestCommentAt
           WHERE id = @id`,
        ).run(taskToRow(task));
      } else {
        insertTask.run(taskToRow(task));
      }
      return getTask(task.id) as Task;
    },

    createTask(projectId, input) {
      const title = input.title.trim();
      if (!title) return undefined;
      const task: Task = {
        id: randomUUID(),
        projectId,
        phase: input.phase?.trim() || '',
        title,
        status: 'pending',
        sessionId: null,
        order: (nextOrder.get(projectId) as { next: number }).next,
        source: 'adhoc',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
        type: input.type ?? null,
        // The card's own brief, in the field every other surface reads a card's
        // description from — see the interface above.
        externalDescription: input.description?.trim() || null,
        projectTagId: input.projectTagId ?? null,
      };
      insertTask.run(taskToRow(task));
      return task;
    },

    getSubtasks(parentId) {
      return (selectSubtasks.all(parentId) as TaskRow[]).map(rowToTask);
    },

    addSubtask(parentId, input) {
      const title = input.title.trim();
      if (!title) return undefined;
      const parent = getTask(parentId);
      // Steps are one level deep by design: a step of a step has no meaning for the
      // sequential runner (and would make "the parent's worktree" ambiguous).
      if (!parent || parent.parentTaskId) return undefined;
      const description = input.description?.trim() || null;
      const currentRound = Math.max(1, (maxSubtaskRound.get(parentId) as { round: number }).round);
      const task: Task = {
        id: randomUUID(),
        // The step lives on the parent's board, so it travels with the card and is
        // never picked up by a project queue's `selectNextPending`.
        projectId: parent.projectId,
        phase: parent.phase,
        title,
        status: 'pending',
        sessionId: null,
        // Ordered among its siblings, not among the board's cards.
        order: (nextSubtaskOrder.get(parentId) as { next: number }).next,
        source: 'adhoc',
        dependsOn: [],
        isContract: false,
        isScaffold: false,
        type: parent.type ?? null,
        parentTaskId: parentId,
        description,
        // Inherit where the parent runs; the mode is forced, see the interface.
        agentProjectId: parent.agentProjectId ?? null,
        // But NOT its model. A parent is usually the card that was planned, and planning
        // is the expensive half of the split — inheriting that model would silently bill
        // every step at it. NULL means "follow the project's execution model", and a step
        // that genuinely needs a different one is overridden one step at a time.
        agentModel: null,
        agentMode: 'bypassPermissions',
        // A caller that knows which planning round it is filling (`approvePlan`) says so;
        // everyone else — the "Add step…" form above all — joins the round already in
        // progress, because a step typed by hand belongs with the ones it is typed among.
        planRound: input.round ?? currentRound,
      };
      insertTask.run(taskToRow(task));
      return task;
    },

    maxSubtaskRound(parentId) {
      return (maxSubtaskRound.get(parentId) as { round: number }).round;
    },

    deleteTask(id) {
      // Explicit delete (the human said so): also drops its timeline + transcript, and its
      // steps. The one path that is still a real delete — see `Task.archivedAt` for why a
      // sync no longer takes this one. (The plan-sync path never calls it either, so plan
      // history is unaffected.)
      deleteTaskDeep(id);
    },

    syncTasksFromPlan(projectId, parsed) {
      const desired = reconcileTasks(projectId, getTasks(projectId), parsed);
      // Replace the project's task set with the reconciled list, in one transaction.
      //
      // The DELETE cascades chain links away, and a task the reconciler KEPT comes back
      // with the same id — so its arrows have to be re-drawn, or every save of a plan
      // file would quietly erase the chain drawn over that project. Only links whose
      // both ends survive are restored; one pointing at a task the plan dropped is a
      // genuine cascade and stays gone.
      //
      // Attachments are the same shape and need the same treatment, in the same
      // transaction and for a sharper reason: the bytes live on disk, where no cascade can
      // reach them, so losing the rows would leave a directory of files nothing points at
      // and no way to get them back. Their ids are preserved along with them, so a
      // `vipper-attachment://a/<id>` an open pane is already showing stays valid.
      const replace = db.transaction((tasks: Task[]) => {
        const links = (selectTaskLinksForProject.all(projectId, projectId) as TaskLinkRow[]).map(
          rowToTaskLink,
        );
        const attachments = selectAttachmentsForProject.all(projectId) as TaskAttachment[];
        deleteTasks.run(projectId);
        for (const t of tasks) insertTask.run(taskToRow(t));
        for (const link of links) {
          if (!selectTask.get(link.fromTaskId) || !selectTask.get(link.toTaskId)) continue;
          insertTaskLink.run(link);
        }
        for (const attachment of attachments) {
          if (!selectTask.get(attachment.taskId)) continue;
          insertAttachment.run(attachment);
        }
      });
      replace(desired);
      return desired;
    },

    appendTaskEvent(projectId, taskId, runId, event) {
      insertEvent.run({
        projectId,
        taskId,
        runId,
        event: JSON.stringify(event),
        createdAt: Date.now(),
      });
    },

    getTaskHistory(taskId) {
      const rows = selectEvents.all(taskId) as Array<{ event: string }>;
      const events: SessionEvent[] = [];
      for (const row of rows) {
        try {
          events.push(JSON.parse(row.event) as SessionEvent);
        } catch {
          // Skip a corrupt row rather than break the whole transcript.
        }
      }
      return events;
    },

    appendTokenUsage(sample) {
      insertUsage.run({
        source: sample.source,
        projectId: sample.projectId,
        taskId: sample.taskId,
        runId: sample.runId,
        inputTokens: sample.inputTokens,
        outputTokens: sample.outputTokens,
        cacheCreationTokens: sample.cacheCreationTokens,
        cacheReadTokens: sample.cacheReadTokens,
        totalTokens: sample.totalTokens,
        costUsd: sample.costUsd ?? null,
        createdAt: sample.createdAt,
      });
    },

    getUsageSamples(sinceMs) {
      return selectUsageSince.all(sinceMs) as UsageSample[];
    },

    getWindowCost(sinceMs) {
      const row = selectUsageCostSince.get(sinceMs) as { cost: number } | undefined;
      return row?.cost ?? 0;
    },

    getWindowTokens(fromMs, toMs) {
      const row = selectUsageTokensBetween.get(fromMs, toMs) as { tokens: number } | undefined;
      return row?.tokens ?? 0;
    },

    addComment(projectId, taskId, body) {
      const text = body.trim();
      if (!text) return undefined;
      const createdAt = Date.now();
      const { lastInsertRowid } = insertActivity.run({
        projectId,
        taskId,
        kind: 'comment',
        body: text,
        fromStatus: null,
        toStatus: null,
        createdAt,
      });
      return { kind: 'comment', id: Number(lastInsertRowid), body: text, createdAt };
    },

    addChatMessage(projectId, taskId, body) {
      const text = body.trim();
      if (!text) return undefined;
      const createdAt = Date.now();
      const { lastInsertRowid } = insertActivity.run({
        projectId,
        taskId,
        kind: 'chat',
        body: text,
        fromStatus: null,
        toStatus: null,
        createdAt,
      });
      return { kind: 'chat', id: Number(lastInsertRowid), body: text, createdAt };
    },

    addStatusNote(projectId, taskId, body) {
      const text = body.trim();
      if (!text) return undefined;
      const createdAt = Date.now();
      const { lastInsertRowid } = insertActivity.run({
        projectId,
        taskId,
        kind: 'status-note',
        body: text,
        fromStatus: null,
        toStatus: null,
        createdAt,
      });
      return { kind: 'status-note', id: Number(lastInsertRowid), body: text, createdAt };
    },

    recordStatusChange(projectId, taskId, from, to) {
      insertActivity.run({
        projectId,
        taskId,
        kind: 'status',
        body: null,
        fromStatus: from,
        toStatus: to,
        createdAt: Date.now(),
      });
    },

    deleteComment(commentId) {
      const row = selectActivityRow.get(commentId) as { kind: string } | undefined;
      // Only delete comments — status entries are an immutable audit trail.
      if (row?.kind === 'comment') deleteActivity.run(commentId);
    },

    getTaskActivity(taskId) {
      const entries: TaskActivityEntry[] = [];
      const activity = selectActivity.all(taskId) as Array<{
        id: number;
        kind: string;
        body: string | null;
        fromStatus: string | null;
        toStatus: string | null;
        createdAt: number;
      }>;
      for (const r of activity) {
        if (r.kind === 'comment' && r.body !== null) {
          entries.push({ kind: 'comment', id: r.id, body: r.body, createdAt: r.createdAt });
        } else if (r.kind === 'chat' && r.body !== null) {
          entries.push({ kind: 'chat', id: r.id, body: r.body, createdAt: r.createdAt });
        } else if (r.kind === 'status-note' && r.body !== null) {
          entries.push({ kind: 'status-note', id: r.id, body: r.body, createdAt: r.createdAt });
        } else if (r.kind === 'status' && r.toStatus !== null) {
          entries.push({
            kind: 'status',
            id: r.id,
            from: r.fromStatus as TaskStatus | null,
            to: r.toStatus as TaskStatus,
            createdAt: r.createdAt,
          });
        }
      }
      const events = selectEventsFull.all(taskId) as Array<{
        id: number;
        event: string;
        createdAt: number;
      }>;
      for (const r of events) {
        try {
          entries.push({
            kind: 'event',
            id: r.id,
            event: JSON.parse(r.event) as SessionEvent,
            createdAt: r.createdAt,
          });
        } catch {
          // Skip a corrupt row rather than break the whole timeline.
        }
      }
      return mergeActivity(entries);
    },

    saveLimitGate(state) {
      if (state === null) deleteState.run(LIMIT_GATE_KEY);
      else upsertState.run(LIMIT_GATE_KEY, JSON.stringify(state));
    },

    saveAuthGate(state) {
      if (state === null) deleteState.run(AUTH_GATE_KEY);
      else upsertState.run(AUTH_GATE_KEY, JSON.stringify(state));
    },

    loadAuthGate() {
      const row = selectState.get(AUTH_GATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.value) as AuthState;
      } catch {
        return null; // corrupt/legacy value — treat as signed in, and let a run say otherwise
      }
    },

    loadLimitGate() {
      const row = selectState.get(LIMIT_GATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.value) as LimitState;
      } catch {
        return null; // corrupt/legacy value — treat as no gate
      }
    },

    saveParkedRuns(runs) {
      if (runs.length === 0) deleteState.run(PARKED_RUNS_KEY);
      else upsertState.run(PARKED_RUNS_KEY, JSON.stringify(runs));
    },

    loadParkedRuns() {
      const row = selectState.get(PARKED_RUNS_KEY) as { value: string } | undefined;
      if (!row) return [];
      try {
        const parsed = JSON.parse(row.value) as ParkedRun[];
        // A recipe with no task to attach to can never be claimed, and would sit in the
        // table for ever; a non-array value is a rot we treat as nothing saved.
        return Array.isArray(parsed) ? parsed.filter((r) => typeof r?.taskId === 'string') : [];
      } catch {
        return []; // corrupt/legacy value — every parked run falls back to ordinary work
      }
    },

    getSettings,

    saveSettings(settings) {
      upsertState.run(SETTINGS_KEY, JSON.stringify(settings));
    },

    listMergeRequests() {
      return (selectMergeRequests.all() as MergeRequestRow[]).map(rowToMergeRequest);
    },

    upsertMergeRequest(mr) {
      upsertMergeRequestStmt.run({
        ...mr,
        draft: mr.draft ? 1 : 0,
        changesRequested: mr.changesRequested ? 1 : 0,
        hasConflicts: mr.hasConflicts ? 1 : 0,
        issueKeys: JSON.stringify(mr.issueKeys),
        pipelineStages: JSON.stringify(mr.pipelineStages ?? []),
      });
    },

    deleteMergeRequests(ids) {
      for (const id of ids) deleteMergeRequestStmt.run(id);
    },

    listTaskLinks() {
      return (selectTaskLinks.all() as TaskLinkRow[]).map(rowToTaskLink);
    },

    addTaskLink(fromTaskId, toTaskId, gate) {
      const row: TaskLinkRow = {
        id: randomUUID(),
        fromTaskId,
        toTaskId,
        gate,
        createdAt: Date.now(),
      };
      // The foreign keys reject an unknown card, and the unique index a repeated arrow;
      // either way the caller gets "no link" rather than an exception out of a drag.
      try {
        if (insertTaskLink.run(row).changes === 0) return undefined;
      } catch {
        return undefined;
      }
      return rowToTaskLink(row);
    },

    deleteTaskLink(id) {
      deleteTaskLinkStmt.run(id);
    },

    setTaskLinkGate(id, gate) {
      updateTaskLinkGate.run(gate, id);
      const row = selectTaskLink.get(id) as TaskLinkRow | undefined;
      return row ? rowToTaskLink(row) : undefined;
    },

    // --- Native tickets (Phase 24). ---

    createTicket(projectId, input) {
      return createTicketTx(projectId, input);
    },

    listPeople() {
      return (selectPeople.all() as PersonRow[]).map(rowToPerson);
    },

    addPerson(input) {
      const name = input.name.trim();
      if (!name) return undefined;
      const person: Person = {
        id: randomUUID(),
        name,
        email: input.email?.trim() ?? '',
        // Seeded from the name when none was given, and editable from that moment on —
        // `initials` is stored precisely because a deriver cannot tell two "Anna K"s apart.
        initials: input.initials?.trim() || seedInitials(name),
        color: input.color?.trim() ?? '',
        isMe: input.isMe ?? false,
        createdAt: Date.now(),
      };
      // Clearing the old "me" in the same transaction is not politeness — the partial
      // unique index refuses the insert otherwise, and the person would simply not appear.
      db.transaction(() => {
        if (person.isMe) clearIsMe.run();
        insertPerson.run({
          ...person,
          email: person.email || null,
          color: person.color || null,
          // By hand, and this is the one that bites: better-sqlite3 refuses to bind a
          // boolean at all, so a `true` here throws rather than storing a 1.
          isMe: person.isMe ? 1 : 0,
        });
      })();
      return person;
    },

    updatePerson(id, patch) {
      const existing = selectPerson.get(id) as PersonRow | undefined;
      if (!existing) return undefined;
      const next: PersonRow = {
        ...existing,
        name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
        email: patch.email !== undefined ? patch.email.trim() || null : existing.email,
        initials:
          patch.initials !== undefined
            ? patch.initials.trim() || existing.initials
            : existing.initials,
        color: patch.color !== undefined ? patch.color.trim() || null : existing.color,
        isMe: patch.isMe !== undefined ? (patch.isMe ? 1 : 0) : existing.isMe,
      };
      db.transaction(() => {
        if (next.isMe === 1) clearIsMe.run();
        db.prepare(
          `UPDATE people SET name = @name, email = @email, initials = @initials,
             color = @color, isMe = @isMe WHERE id = @id`,
        ).run(next);
      })();
      const row = selectPerson.get(id) as PersonRow | undefined;
      return row ? rowToPerson(row) : undefined;
    },

    deletePerson(id) {
      deletePersonTx(id);
    },

    listMilestones(projectId) {
      return (selectMilestones.all(projectId) as MilestoneRow[]).map(rowToMilestone);
    },

    addMilestone(projectId, input) {
      const name = input.name.trim();
      if (!name) return undefined;
      if (!selectProject.get(projectId)) return undefined;
      const milestone: Milestone = {
        id: randomUUID(),
        projectId,
        name,
        description: input.description?.trim() ?? '',
        dueAt: input.dueAt ?? null,
        color: input.color?.trim() ?? '',
        closed: input.closed ?? false,
        createdAt: Date.now(),
      };
      insertMilestone.run({
        ...milestone,
        description: milestone.description || null,
        color: milestone.color || null,
        closed: milestone.closed ? 1 : 0,
      });
      return milestone;
    },

    updateMilestone(id, patch) {
      const existing = selectMilestone.get(id) as MilestoneRow | undefined;
      if (!existing) return undefined;
      const next: MilestoneRow = {
        ...existing,
        name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
        description:
          patch.description !== undefined ? patch.description.trim() || null : existing.description,
        // `null` is a value the caller may really mean here ("this milestone has no date
        // again"), so it is tested against `undefined` rather than falsiness.
        dueAt: patch.dueAt !== undefined ? patch.dueAt : existing.dueAt,
        color: patch.color !== undefined ? patch.color.trim() || null : existing.color,
        closed: patch.closed !== undefined ? (patch.closed ? 1 : 0) : existing.closed,
      };
      db.prepare(
        `UPDATE milestones SET name = @name, description = @description, dueAt = @dueAt,
           color = @color, closed = @closed WHERE id = @id`,
      ).run(next);
      const row = selectMilestone.get(id) as MilestoneRow | undefined;
      return row ? rowToMilestone(row) : undefined;
    },

    deleteMilestone(id) {
      deleteMilestoneTx(id);
    },

    listTicketLabels(projectId) {
      return (selectTicketLabels.all(projectId) as TicketLabelRow[]).map(rowToTicketLabel);
    },

    addTicketLabel(projectId, input) {
      const name = input.name.trim();
      if (!name) return undefined;
      if (!selectProject.get(projectId)) return undefined;
      const label: TicketLabel = {
        id: randomUUID(),
        projectId,
        name,
        color: input.color?.trim() ?? '',
        createdAt: Date.now(),
      };
      const { changes } = insertTicketLabel.run({ ...label, color: label.color || null });
      // The unique (projectId, name) index said this project already has that label. A
      // refusal, not an error — the caller wanted a label of that name and there is one.
      return changes > 0 ? label : undefined;
    },

    updateTicketLabel(id, patch) {
      const existing = selectTicketLabel.get(id) as TicketLabelRow | undefined;
      if (!existing) return undefined;
      const next: TicketLabelRow = {
        ...existing,
        name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
        color: patch.color !== undefined ? patch.color.trim() || null : existing.color,
      };
      updateTicketLabelTx(next, existing.name);
      const row = selectTicketLabel.get(id) as TicketLabelRow | undefined;
      return row ? rowToTicketLabel(row) : undefined;
    },

    deleteTicketLabel(id) {
      const row = selectTicketLabel.get(id) as TicketLabelRow | undefined;
      if (!row) return;
      deleteTicketLabelTx(row);
    },

    listTicketLinks() {
      return (selectTicketLinks.all() as TicketLinkRow[]).map(rowToTicketLink);
    },

    addTicketLink(fromTaskId, toTaskId, type) {
      // A ticket cannot be related to itself, and both ends must exist — the foreign keys
      // would refuse the second anyway, but as a throw rather than as an answer.
      if (fromTaskId === toTaskId) return undefined;
      if (!selectTask.get(fromTaskId) || !selectTask.get(toTaskId)) return undefined;
      const link: TicketLink = {
        id: randomUUID(),
        fromTaskId,
        toTaskId,
        type: isTicketLinkType(type) ? type : 'relates',
        createdAt: Date.now(),
      };
      const { changes } = insertTicketLink.run(link);
      return changes > 0 ? link : undefined;
    },

    deleteTicketLink(id) {
      deleteTicketLinkStmt.run(id);
    },

    // The eight columns ARE `TaskAttachment`, in order, so these rows need no mapper —
    // unlike a link's `gate`, nothing here is a string the schema could disagree with. The
    // one wrinkle is `cloudBlobAt`, which reads back as `null` rather than absent; the type
    // says `number | null` for exactly that, and every reader tests it for truthiness.
    listAttachments() {
      return selectAttachments.all() as TaskAttachment[];
    },

    attachmentsForTask(taskId) {
      return selectAttachmentsForTask.all(taskId) as TaskAttachment[];
    },

    getAttachment(id) {
      return selectAttachment.get(id) as TaskAttachment | undefined;
    },

    addAttachment(input) {
      const row: TaskAttachment = {
        ...input,
        id: randomUUID(),
        createdAt: Date.now(),
        // Explicit, never left absent: better-sqlite3 binds by named parameter and refuses an
        // object missing one the statement names. A brand-new attachment is by definition not
        // in the cloud yet, so `null` is also the honest value.
        cloudBlobAt: input.cloudBlobAt ?? null,
      };
      // The foreign key rejects an unknown task and the unique index a name already used
      // on it; either way the caller gets "no attachment" rather than an exception out of
      // a file drop. Same contract as `addTaskLink`.
      try {
        if (insertAttachment.run(row).changes === 0) return undefined;
      } catch {
        return undefined;
      }
      return row;
    },

    deleteAttachment(id) {
      const row = selectAttachment.get(id) as TaskAttachment | undefined;
      if (!row) return undefined;
      deleteAttachmentStmt.run(id);
      return row;
    },

    markAttachmentUploaded(id, at) {
      markAttachmentUploadedStmt.run(at, id);
    },

    saveAttention(item, context) {
      upsertAttentionStmt.run({
        id: item.id,
        runId: item.runId,
        taskId: item.taskId,
        projectId: item.projectId,
        taskTitle: item.taskTitle,
        kind: item.kind,
        prompt: item.prompt,
        options: JSON.stringify(item.options ?? []),
        toolName: item.toolName,
        reason: item.reason,
        worktreePath: item.worktreePath ?? null,
        branch: item.branch ?? null,
        plan: item.plan ?? null,
        steps: JSON.stringify(item.steps ?? []),
        questions: JSON.stringify(item.questions ?? []),
        context: context == null ? null : JSON.stringify(context),
        createdAt: item.createdAt,
      });
    },

    deleteAttention(id) {
      deleteAttentionStmt.run(id);
    },

    listAttention() {
      const rows = selectAttentionStmt.all() as AttentionRow[];
      return rows.map((r) => ({
        item: {
          id: r.id,
          runId: r.runId,
          taskId: r.taskId,
          projectId: r.projectId,
          taskTitle: r.taskTitle,
          kind: r.kind as AttentionItem['kind'],
          prompt: r.prompt,
          options: parseStringArray(r.options),
          toolName: r.toolName,
          reason: r.reason,
          worktreePath: r.worktreePath,
          branch: r.branch,
          plan: r.plan,
          steps: parseStringArray(r.steps),
          questions: parseJsonColumn<AttentionItem['questions']>(r.questions) ?? [],
          createdAt: r.createdAt,
        },
        context: parseJsonColumn<unknown>(r.context) ?? null,
      }));
    },

    setMergeRequestName(id, name) {
      // Blank means "back to the upstream title", so it is stored as NULL rather than as an
      // empty string that `mrLabel` would then have to treat as a name.
      setMrName.run(name?.trim() ? name.trim() : null, id);
      const row = selectMergeRequest.get(id) as MergeRequestRow | undefined;
      return row ? rowToMergeRequest(row) : undefined;
    },

    markMergeRequestRead(id, at) {
      markMrRead.run(at, id);
      const row = selectMergeRequest.get(id) as MergeRequestRow | undefined;
      return row ? rowToMergeRequest(row) : undefined;
    },

    markMergeRequestEventsSeen(id, at) {
      markMrEventsSeen.run(at, id);
      const row = selectMergeRequest.get(id) as MergeRequestRow | undefined;
      return row ? rowToMergeRequest(row) : undefined;
    },

    saveGitLabToken(value) {
      upsertState.run(GITLAB_TOKEN_KEY, value);
    },

    loadGitLabToken() {
      const row = selectState.get(GITLAB_TOKEN_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    clearGitLabToken() {
      deleteState.run(GITLAB_TOKEN_KEY);
    },

    saveGitLabIdentity(cache) {
      upsertState.run(GITLAB_IDENTITY_KEY, JSON.stringify(cache));
    },

    loadGitLabIdentity() {
      const row = selectState.get(GITLAB_IDENTITY_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as GitLabIdentityCache;
        return typeof parsed?.baseUrl === 'string' && typeof parsed?.username === 'string'
          ? parsed
          : null;
      } catch {
        return null; // corrupt value — re-fetch
      }
    },

    saveGitHubToken(value) {
      upsertState.run(GITHUB_TOKEN_KEY, value);
    },

    loadGitHubToken() {
      const row = selectState.get(GITHUB_TOKEN_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    clearGitHubToken() {
      deleteState.run(GITHUB_TOKEN_KEY);
    },

    saveGitHubIdentity(cache) {
      upsertState.run(GITHUB_IDENTITY_KEY, JSON.stringify(cache));
    },

    loadGitHubIdentity() {
      const row = selectState.get(GITHUB_IDENTITY_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as GitHubIdentityCache;
        return typeof parsed?.baseUrl === 'string' && typeof parsed?.login === 'string'
          ? parsed
          : null;
      } catch {
        return null; // corrupt value — re-fetch
      }
    },

    saveJiraToken(value) {
      upsertState.run(JIRA_TOKEN_KEY, value);
    },

    loadJiraToken() {
      const row = selectState.get(JIRA_TOKEN_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    clearJiraToken() {
      deleteState.run(JIRA_TOKEN_KEY);
    },

    saveCloudPat(value) {
      upsertState.run(CLOUD_PAT_KEY, value);
    },

    loadCloudPat() {
      const row = selectState.get(CLOUD_PAT_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    clearCloudPat() {
      deleteState.run(CLOUD_PAT_KEY);
    },

    clearLegacyCloudSignIn() {
      const row = selectState.get(IAM_REFRESH_TOKEN_KEY) as { value: string } | undefined;
      if (!row) return false;
      deleteState.run(IAM_REFRESH_TOKEN_KEY);
      return true;
    },

    loadCloudClientId() {
      const row = selectState.get(CLOUD_CLIENT_ID_KEY) as { value: string } | undefined;
      if (row) return row.value;
      const id = randomUUID();
      upsertState.run(CLOUD_CLIENT_ID_KEY, id);
      return id;
    },

    loadCloudCursor() {
      const row = selectState.get(CLOUD_CURSOR_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    saveCloudCursor(cursor) {
      upsertState.run(CLOUD_CURSOR_KEY, cursor);
    },

    saveJiraEpicField(cache) {
      upsertState.run(JIRA_EPIC_FIELD_KEY, JSON.stringify(cache));
    },

    loadJiraEpicField() {
      const row = selectState.get(JIRA_EPIC_FIELD_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as JiraEpicFieldCache;
        return typeof parsed?.baseUrl === 'string' ? parsed : null;
      } catch {
        return null; // corrupt value — re-discover
      }
    },

    saveJiraSprintField(cache) {
      upsertState.run(JIRA_SPRINT_FIELD_KEY, JSON.stringify(cache));
    },

    loadJiraSprintField() {
      const row = selectState.get(JIRA_SPRINT_FIELD_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as JiraSprintFieldCache;
        return typeof parsed?.baseUrl === 'string' ? parsed : null;
      } catch {
        return null; // corrupt value — re-discover
      }
    },

    saveJiraIdentity(cache) {
      upsertState.run(JIRA_IDENTITY_KEY, JSON.stringify(cache));
    },

    loadJiraIdentity() {
      const row = selectState.get(JIRA_IDENTITY_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as JiraIdentityCache;
        return typeof parsed?.baseUrl === 'string' && typeof parsed?.displayName === 'string'
          ? parsed
          : null;
      } catch {
        return null; // corrupt value — re-fetch
      }
    },

    saveJiraLastQuery(jql) {
      upsertState.run(JIRA_LAST_QUERY_KEY, jql);
    },

    loadJiraLastQuery() {
      const row = selectState.get(JIRA_LAST_QUERY_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    saveGitHubLastQuery(query) {
      upsertState.run(GITHUB_LAST_QUERY_KEY, query);
    },

    loadGitHubLastQuery() {
      const row = selectState.get(GITHUB_LAST_QUERY_KEY) as { value: string } | undefined;
      return row?.value ?? null;
    },

    saveWindowState(state) {
      upsertState.run(WINDOW_STATE_KEY, JSON.stringify(state));
    },

    loadWindowState() {
      const row = selectState.get(WINDOW_STATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return null; // corrupt value — sanitizeWindowState would reject it anyway
      }
    },

    getCloudDelta(sinceSeq, limit) {
      const rows = selectCloudOutboxSince.all(
        sinceSeq,
        Math.max(limit, 0) * OUTBOX_READ_MULTIPLE,
      ) as CloudOutboxRow[];
      return shapeCloudDelta(rows, limit);
    },

    pruneCloudOutbox(throughSeq) {
      deleteCloudOutboxThrough.run(throughSeq);
    },

    getCloudCommandOutcome(id) {
      const row = selectCloudCommandOutcome.get(id) as { result: string | null } | undefined;
      if (!row) return null;
      // A row written before the ledger stored results (or by a kind that stores none) is
      // still "applied" — it just has nothing to replay beyond that fact.
      if (row.result === null) return { taskId: null, projectId: null, ok: true, reason: null };
      try {
        return JSON.parse(row.result) as StoredCloudOutcome;
      } catch {
        return { taskId: null, projectId: null, ok: true, reason: null };
      }
    },

    recordCloudCommandApplied(id, outcome, awaited) {
      const now = Date.now();
      insertCloudCommandApplied.run(id, now, JSON.stringify(outcome), awaited ? null : now);
    },

    getPendingCloudAcks() {
      return (selectPendingCloudAcks.all() as Array<{ id: string }>).map((row) => row.id);
    },

    markCloudAcksSent(ids) {
      if (ids.length === 0) return;
      const ackedAt = Date.now();
      db.transaction(() => {
        for (const id of ids) markCloudAckSent.run(ackedAt, id);
      })();
    },

    getPendingCloudResults() {
      const rows = selectPendingCloudResults.all() as Array<{ id: string; result: string }>;
      const pending: PendingCloudResult[] = [];
      for (const row of rows) {
        try {
          pending.push({ commandId: row.id, ...(JSON.parse(row.result) as StoredCloudOutcome) });
        } catch {
          // A corrupt row must not wedge the queue behind it forever — it is dropped from
          // the wire, and its `resultSentAt` is stamped so it is never read again.
          markCloudResultSent.run(Date.now(), row.id);
        }
      }
      return pending;
    },

    markCloudResultsSent(ids) {
      if (ids.length === 0) return;
      const sentAt = Date.now();
      db.transaction(() => {
        for (const id of ids) markCloudResultSent.run(sentAt, id);
      })();
    },

    // Annotated rather than inferred: a generic method gets no usable contextual type from
    // the object literal's `Store` annotation here, so without this `fn` is an implicit
    // `any` and the ban above would be guarding a signature that had quietly gone untyped.
    // The rest parameter is `SyncOnly<T>` for assignability alone — it is never read, and
    // by construction it is always empty in any call that compiles.
    runInTransaction<T>(fn: () => T, ..._syncOnly: SyncOnly<T>): T {
      return db.transaction(fn)();
    },

    isOpen() {
      return db.open;
    },

    close() {
      if (db.open) db.close();
    },
  };
}
