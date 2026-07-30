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
  PERSONAL_PROJECT_ID,
  type Project,
  type ProjectPatch,
  type Task,
  type TaskActivityEntry,
  type TaskStatus,
  type TaskType,
} from '@shared/model';
import { formatExecTarget, parseExecTarget } from '@shared/execTarget';
import { hostJoin } from '@shared/wslPath';
import type { LimitState } from '@shared/limit';
import type { SessionEvent } from '@shared/session';
import type { UsageSample } from '@shared/usage';
import {
  type AppSettings,
  DEFAULT_BOARD_DISPLAY,
  DEFAULT_GITLAB_SETTINGS,
  DEFAULT_JIRA_SETTINGS,
  DEFAULT_SETTINGS,
} from '@shared/settings';
import { mergeActivity } from './activityMerge';
import type { JiraEpicFieldCache } from './jira/epicField';
import type { JiraSprintFieldCache } from './jira/jiraSprint';
import type { JiraIdentityCache } from './jira/identity';
import type { GitLabIdentityCache } from './gitlab/identity';
import type {
  MergeRequest,
  MergeRequestState,
  PipelineStage,
  PipelineStatus,
} from '@shared/mergeRequest';
import type { AttentionItem } from '@shared/attention';
import type { ParsedTask } from './planParser';
import { splitProjectTag } from './projectTagMigration';
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
}

/** A project row as stored; `writeBackPlan` is a 0/1 INTEGER (SQLite has no boolean). */
interface ProjectRow {
  id: string;
  name: string;
  path: string;
  planPath: string;
  defaultModel: string;
  defaultPermissionMode: string;
  concurrency: number;
  useWorktrees: number;
  writeBackPlan: number;
  planAligned: number;
  /** 'plan' | 'agent'; NULL is impossible (NOT NULL DEFAULT 'plan'), but old rows read back as 'plan'. */
  kind: string;
  /** JSON array of JIRA epic keys owned by an agent project; null for plan projects. */
  jiraEpicKeys: string | null;
  /** Serialized ExecTarget: 'local' or 'wsl:<distro>'. */
  target: string;
  /** Standing per-project instructions; null for projects that predate the field. */
  instructions: string | null;
  /** Hex colour for the board stripe; null for projects that predate the field. */
  color: string | null;
  createdAt: number;
}

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
        | 'lastReadCommentAt'
        | 'latestCommentAt'
        | 'projectTagId'
        | 'agentProjectId'
        | 'agentMode'
        | 'agentModel'
        | 'agentPlan'
        | 'agentBranch'
      >
    >,
  ): Task | undefined;
  /** All tasks on the built-in Personal board (JIRA + internal ad-hoc), ordered. */
  getPersonalTasks(): Task[];
  /** Insert a new JIRA-sourced task, or update the existing one with the same key. */
  upsertJiraTask(task: Task): Task;
  /** Create an ad-hoc task (Phase 8): appended after existing tasks, `source: 'adhoc'`. */
  createTask(
    projectId: string,
    input: { title: string; phase?: string; type?: TaskType | null },
  ): Task | undefined;
  /** A card's steps, in execution order (empty for a card with no subtasks). */
  getSubtasks(parentId: string): Task[];
  /**
   * Append one step to a card (Phase 11). The step lives on the parent's board and
   * inherits its delegation (agent project + model) so the chain runs in the parent's
   * repo, but always in `bypassPermissions` — the human approved the plan, so the
   * steps run unattended. Returns the created step, or undefined if the parent is
   * unknown, is itself a step, or the title is blank.
   */
  addSubtask(
    parentId: string,
    input: { title: string; description?: string | null },
  ): Task | undefined;
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
  /** Current app settings, with any unset field filled from `DEFAULT_SETTINGS` (Phase 6). */
  getSettings(): AppSettings;
  /** Persist the full app settings object. */
  saveSettings(settings: AppSettings): void;
  /** Persist the JIRA token (opaque, already encrypted by the caller). */
  /** Every stored merge request, newest activity first. */
  listMergeRequests(): MergeRequest[];
  /** Insert or update one merge request (by its stable `gl-{project}-{iid}` id). */
  upsertMergeRequest(mr: MergeRequest): void;
  /** Drop merge requests GitLab no longer lists. */
  deleteMergeRequests(ids: readonly string[]): void;

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
  markMergeRequestRead(id: string, at: number): MergeRequest | undefined;
  markMergeRequestEventsSeen(id: string, at: number): MergeRequest | undefined;
  /** The GitLab token ciphertext, beside the JIRA trio. */
  saveGitLabToken(value: string): void;
  loadGitLabToken(): string | null;
  clearGitLabToken(): void;
  /** Cache `GET /user` per instance, so notes can be attributed without a request each. */
  saveGitLabIdentity(cache: GitLabIdentityCache): void;
  loadGitLabIdentity(): GitLabIdentityCache | null;
  saveJiraToken(value: string): void;
  /** Load the stored JIRA token ciphertext, or null if none is set. */
  loadJiraToken(): string | null;
  /** Remove the stored JIRA token. */
  clearJiraToken(): void;
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
   * Remember the main window's geometry so the next launch opens where the last one
   * closed. Written on a debounce while the window moves, so it stays cheap.
   */
  saveWindowState(state: SavedWindowState): void;
  /**
   * The raw saved geometry, unvalidated — the displays it refers to may not exist any
   * more, so `sanitizeWindowState` is what turns this into something to apply.
   */
  loadWindowState(): unknown;
  close(): void;
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
      defaultPermissionMode TEXT NOT NULL,
      concurrency           INTEGER NOT NULL DEFAULT 1,
      useWorktrees          INTEGER NOT NULL DEFAULT 1,
      writeBackPlan         INTEGER NOT NULL DEFAULT 0,
      planAligned           INTEGER NOT NULL DEFAULT 0,
      kind                  TEXT NOT NULL DEFAULT 'plan',
      jiraEpicKeys          TEXT,
      target                TEXT NOT NULL DEFAULT 'local',
      instructions          TEXT,
      color                 TEXT,
      createdAt             INTEGER NOT NULL
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
      lastReadCommentAt      INTEGER,
      latestCommentAt        INTEGER,
      projectTagId           TEXT,
      agentProjectId         TEXT,
      agentMode              TEXT,
      agentModel             TEXT,
      agentPlan              TEXT,
      agentBranch            TEXT
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
      id                TEXT PRIMARY KEY,   -- gl-{projectId}-{iid}
      taskId            TEXT,               -- NULL = no board card claims it
      provider          TEXT NOT NULL,
      gitlabProjectId   INTEGER NOT NULL,
      projectPath       TEXT NOT NULL,
      iid               INTEGER NOT NULL,
      title             TEXT NOT NULL,
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
  `);

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

  // Migrate databases created before per-project colours. NULL reads back as '' — no
  // colour, hence no stripe — which is exactly how every board looked before.
  if (!projectColumns.some((c) => c.name === 'color')) {
    db.exec(`ALTER TABLE projects ADD COLUMN color TEXT`);
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
  ] as Array<[string, string]>) {
    if (!taskColumns.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
  }
  // Created after the migration above, not in the schema block: on a pre-Phase-11 database
  // the column does not exist until the ALTER has run.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId, "order")`);

  // Seed the built-in Personal board project (idempotent). It hosts the standalone
  // My Tasks board (JIRA tickets + internal ad-hoc tasks); it has no repo/plan, so
  // it is hidden from the Projects tab and skipped by the plan watcher/scheduler.
  // createdAt = 0 keeps the seed deterministic (no Date.now at open).
  db.prepare(
    `INSERT INTO projects
       (id, name, path, planPath, defaultModel, defaultPermissionMode,
        concurrency, useWorktrees, writeBackPlan, planAligned, createdAt)
     VALUES (@id, 'Personal', '', '', @defaultModel, @defaultPermissionMode, 1, 0, 0, 1, 0)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: PERSONAL_PROJECT_ID,
    defaultModel: DEFAULT_SETTINGS.defaultModel,
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

  const insertProject = db.prepare<[ProjectRow]>(
    `INSERT INTO projects (id, name, path, planPath, defaultModel, defaultPermissionMode, concurrency, useWorktrees, writeBackPlan, planAligned, kind, jiraEpicKeys, target, instructions, color, createdAt)
     VALUES (@id, @name, @path, @planPath, @defaultModel, @defaultPermissionMode, @concurrency, @useWorktrees, @writeBackPlan, @planAligned, @kind, @jiraEpicKeys, @target, @instructions, @color, @createdAt)`,
  );
  const selectProjects = db.prepare(`SELECT * FROM projects ORDER BY createdAt`);
  const selectProject = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`);
  const updateWriteBack = db.prepare(`UPDATE projects SET writeBackPlan = ? WHERE id = ?`);
  const updatePlanAligned = db.prepare(`UPDATE projects SET planAligned = ? WHERE id = ?`);
  const selectTasks = db.prepare(`SELECT * FROM tasks WHERE projectId = ? ORDER BY "order"`);
  const selectTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
  const deleteTasks = db.prepare(`DELETE FROM tasks WHERE projectId = ?`);
  const insertTask = db.prepare<[TaskRow]>(
    `INSERT INTO tasks
       (id, projectId, phase, title, status, sessionId, "order", source, dependsOn, isContract, isScaffold, type,
        parentTaskId, description, statusNote, statusNoteAt,
        externalSource, externalKey, externalId, externalUrl, externalStatus, externalStatusCategory,
        externalPriority, externalType, externalLabel, externalParentKey, externalEpicName, externalSprint,
        externalDescription,
        preBlockStatus, lastReadCommentAt, latestCommentAt, agentProjectId, agentMode, agentModel,
        agentPlan, agentBranch)
     VALUES
       (@id, @projectId, @phase, @title, @status, @sessionId, @order, @source, @dependsOn, @isContract, @isScaffold, @type,
        @parentTaskId, @description, @statusNote, @statusNoteAt,
        @externalSource, @externalKey, @externalId, @externalUrl, @externalStatus, @externalStatusCategory,
        @externalPriority, @externalType, @externalLabel, @externalParentKey, @externalEpicName, @externalSprint,
        @externalDescription,
        @preBlockStatus, @lastReadCommentAt, @latestCommentAt, @agentProjectId, @agentMode, @agentModel,
        @agentPlan, @agentBranch)`,
  );
  const deleteTask = db.prepare(`DELETE FROM tasks WHERE id = ?`);
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

  /** Where the main window was, and whether it was maximized, when we last looked. */
  const WINDOW_STATE_KEY = 'window.state';

  /** Guard for the one-shot `agentProjectId` → `projectTagId` back-fill below. */
  const PROJECT_TAG_SPLIT_KEY = 'migration.projectTagSplit';

  /** The GitLab PAT ciphertext, and the cached `GET /user` for the configured instance. */
  const GITLAB_TOKEN_KEY = 'gitlab.pat';
  const GITLAB_IDENTITY_KEY = 'gitlab.identity';

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
    provider: string;
    gitlabProjectId: number;
    projectPath: string;
    iid: number;
    title: string;
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
      if (Array.isArray(parsed)) issueKeys = parsed.filter((k): k is string => typeof k === 'string');
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
      provider: 'gitlab',
      gitlabProjectId: r.gitlabProjectId,
      projectPath: r.projectPath,
      iid: r.iid,
      title: r.title,
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
      issueKeys,
      latestNoteAt: r.latestNoteAt,
      lastReadAt: r.lastReadAt,
      lastEventAt: r.lastEventAt,
      lastEventSeenAt: r.lastEventSeenAt,
      updatedAt: r.updatedAt,
      syncedAt: r.syncedAt,
    };
  }

  const selectMergeRequests = db.prepare(
    `SELECT * FROM merge_requests ORDER BY updatedAt DESC`,
  );
  const selectMergeRequest = db.prepare(`SELECT * FROM merge_requests WHERE id = ?`);
  const upsertMergeRequestStmt = db.prepare(
    `INSERT INTO merge_requests
       (id, taskId, provider, gitlabProjectId, projectPath, iid, title, webUrl,
        sourceBranch, targetBranch, state, draft, pipelineStatus, pipelineStages,
        pipelineUrl,
        approvalsRequired, approvalsGiven, changesRequested, issueKeys,
        latestNoteAt, lastReadAt, lastEventAt, lastEventSeenAt, updatedAt, syncedAt)
     VALUES
       (@id, @taskId, @provider, @gitlabProjectId, @projectPath, @iid, @title, @webUrl,
        @sourceBranch, @targetBranch, @state, @draft, @pipelineStatus, @pipelineStages,
        @pipelineUrl,
        @approvalsRequired, @approvalsGiven, @changesRequested, @issueKeys,
        @latestNoteAt, @lastReadAt, @lastEventAt, @lastEventSeenAt, @updatedAt, @syncedAt)
     ON CONFLICT(id) DO UPDATE SET
       taskId = excluded.taskId, projectPath = excluded.projectPath,
       title = excluded.title, webUrl = excluded.webUrl,
       sourceBranch = excluded.sourceBranch, targetBranch = excluded.targetBranch,
       state = excluded.state, draft = excluded.draft,
       pipelineStatus = excluded.pipelineStatus,
       pipelineStages = excluded.pipelineStages, pipelineUrl = excluded.pipelineUrl,
       approvalsRequired = excluded.approvalsRequired,
       approvalsGiven = excluded.approvalsGiven,
       changesRequested = excluded.changesRequested, issueKeys = excluded.issueKeys,
       latestNoteAt = excluded.latestNoteAt, lastReadAt = excluded.lastReadAt,
       lastEventAt = excluded.lastEventAt, lastEventSeenAt = excluded.lastEventSeenAt,
       updatedAt = excluded.updatedAt, syncedAt = excluded.syncedAt`,
  );
  const deleteMergeRequestStmt = db.prepare(`DELETE FROM merge_requests WHERE id = ?`);

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
      defaultPermissionMode: r.defaultPermissionMode as Project['defaultPermissionMode'],
      concurrency: r.concurrency,
      useWorktrees: r.useWorktrees !== 0,
      writeBackPlan: r.writeBackPlan !== 0,
      planAligned: r.planAligned !== 0,
      kind: r.kind === 'agent' ? 'agent' : 'plan',
      jiraEpicKeys: parseStringArray(r.jiraEpicKeys),
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
      lastReadCommentAt: task.lastReadCommentAt ?? null,
      latestCommentAt: task.latestCommentAt ?? null,
      projectTagId: task.projectTagId ?? null,
      agentProjectId: task.agentProjectId ?? null,
      agentMode: task.agentMode ?? null,
      agentModel: task.agentModel ?? null,
      agentPlan: task.agentPlan ?? null,
      agentBranch: task.agentBranch ?? null,
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
      lastReadCommentAt: r.lastReadCommentAt,
      latestCommentAt: r.latestCommentAt,
      projectTagId: r.projectTagId,
      agentProjectId: r.agentProjectId,
      agentMode: (r.agentMode as Task['agentMode']) ?? null,
      agentModel: (r.agentModel as Task['agentModel']) ?? null,
      agentPlan: r.agentPlan,
      agentBranch: r.agentBranch,
    };
  }

  function getTasks(projectId: string): Task[] {
    return (selectTasks.all(projectId) as TaskRow[]).map(rowToTask);
  }

  function getTask(id: string): Task | undefined {
    const row = selectTask.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  return {
    addProject(input) {
      // Unspecified project fields inherit the user's global defaults (Phase 6).
      const defaults = getSettings();
      // An agent project is a bare repo directory: there is no plan file to parse or
      // tick checkboxes in, and each assigned card runs on its own branch, so those
      // three fields are forced rather than taken from the caller/global defaults.
      const isAgent = input.kind === 'agent';
      const project: Project = {
        id: randomUUID(),
        name: input.name?.trim() || basename(input.path),
        path: input.path,
        // `hostJoin`, not `path.join`: for a WSL project the path is a Linux one, and
        // joining it on Windows would produce `/home/you/repo\plan.md`.
        planPath: isAgent ? '' : (input.planPath ?? hostJoin(input.path, 'plan.md')),
        defaultModel: input.defaultModel ?? defaults.defaultModel,
        defaultPermissionMode: input.defaultPermissionMode ?? defaults.defaultPermissionMode,
        concurrency: Math.max(1, Math.round(input.concurrency ?? defaults.concurrency)),
        useWorktrees: isAgent ? true : (input.useWorktrees ?? true),
        writeBackPlan: isAgent ? false : (input.writeBackPlan ?? defaults.writeBackPlan),
        // New projects are trusted as aligned; legacy projects backfill to false via
        // the migration above. A plan carrying `@needs:`/`@contract` is also confirmed
        // aligned on its next sync (see ipc `syncProjectPlan`).
        planAligned: input.planAligned ?? true,
        kind: isAgent ? 'agent' : 'plan',
        jiraEpicKeys: normalizeEpicKeys(input.jiraEpicKeys),
        target: input.target ?? defaults.defaultExecTarget,
        instructions: input.instructions?.trim() ?? '',
        color: input.color?.trim() ?? '',
        createdAt: Date.now(),
      };
      insertProject.run({
        ...project,
        useWorktrees: project.useWorktrees ? 1 : 0,
        writeBackPlan: project.writeBackPlan ? 1 : 0,
        planAligned: project.planAligned ? 1 : 0,
        jiraEpicKeys: JSON.stringify(project.jiraEpicKeys),
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
      if (patch.writeBackPlan !== undefined) {
        sets.push(`writeBackPlan = @writeBackPlan`);
        params.writeBackPlan = patch.writeBackPlan ? 1 : 0;
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
      if (sets.length > 0) {
        db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
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
        'lastReadCommentAt',
        'latestCommentAt',
        'projectTagId',
        'agentProjectId',
        'agentMode',
        'agentModel',
        'agentPlan',
        'agentBranch',
      ] as const;
      for (const col of columns) {
        const value = (patch as Record<string, unknown>)[col];
        if (value !== undefined) {
          sets.push(`${col} = @${col}`);
          params[col] = value;
        }
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return getTask(id);
    },

    getPersonalTasks() {
      return getTasks(PERSONAL_PROJECT_ID);
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
             preBlockStatus = @preBlockStatus, lastReadCommentAt = @lastReadCommentAt,
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
        // Inherit where and how the parent runs; the mode is forced, see the interface.
        agentProjectId: parent.agentProjectId ?? null,
        agentModel: parent.agentModel ?? null,
        agentMode: 'bypassPermissions',
      };
      insertTask.run(taskToRow(task));
      return task;
    },

    deleteTask(id) {
      // Explicit delete (ad-hoc task): also drop its timeline + transcript. (The
      // plan-sync path never calls this, so plan history is unaffected.)
      // Deleting a card takes its steps with it — an orphaned step has no board
      // column of its own and would otherwise be unreachable in the UI.
      const clear = db.transaction((taskId: string) => {
        const children = (selectSubtaskIds.all(taskId) as Array<{ id: string }>).map((r) => r.id);
        for (const childId of [...children, taskId]) {
          deleteActivityForTask.run(childId);
          deleteEventsForTask.run(childId);
          deleteTask.run(childId);
        }
      });
      clear(id);
    },

    syncTasksFromPlan(projectId, parsed) {
      const desired = reconcileTasks(projectId, getTasks(projectId), parsed);
      // Replace the project's task set with the reconciled list, in one transaction.
      const replace = db.transaction((tasks: Task[]) => {
        deleteTasks.run(projectId);
        for (const t of tasks) insertTask.run(taskToRow(t));
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

    loadLimitGate() {
      const row = selectState.get(LIMIT_GATE_KEY) as { value: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.value) as LimitState;
      } catch {
        return null; // corrupt/legacy value — treat as no gate
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
        issueKeys: JSON.stringify(mr.issueKeys),
        pipelineStages: JSON.stringify(mr.pipelineStages ?? []),
      });
    },

    deleteMergeRequests(ids) {
      for (const id of ids) deleteMergeRequestStmt.run(id);
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

    close() {
      db.close();
    },
  };
}
