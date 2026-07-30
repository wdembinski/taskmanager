/**
 * Shared IPC contract — the "API" between the UI and the orchestration engine.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * In Electron the UI (renderer) and the engine (main process) are separate
 * programs that cannot call each other's functions directly. They talk by
 * sending messages over "channels" (think: named mailboxes). This file is the
 * single source of truth for:
 *   - the channel NAMES (so a typo can't silently break a call), and
 *   - the TYPES of what each channel sends and returns.
 *
 * Both sides import these types, so if the engine changes a return shape, the
 * UI stops type-checking until it's updated. That is exactly what we want.
 *
 * There are two directions of communication:
 *   - INVOKE  : UI asks the engine to do something and awaits a reply
 *               (request/response, like an HTTP call). See `IpcApi` below.
 *   - EVENTS  : the engine pushes updates to the UI at any time
 *               (e.g. "a new line of Claude output arrived"). See `IpcEvents`.
 *
 * Phase 0 only needs a couple of channels to prove the wiring works; later
 * phases add project/task/session channels here.
 */
import type {
  ClaudeModel,
  PermissionMode,
  SessionEvent,
  SessionEventEnvelope,
  StartSessionRequest,
} from './session';
import type {
  AddProjectInput,
  AssignAgentInput,
  BoardColumn,
  ChatSendResult,
  JiraStatusCategory,
  ManualStatus,
  PlanValidation,
  Project,
  ProjectPatch,
  ProjectWithTasks,
  Task,
  TaskActivityEntry,
  TaskType,
} from './model';
import type { ExecTarget, TargetReadiness } from './execTarget';
import type { ActiveRun, SchedulerChange, TaskChange } from './scheduler';
import type { AttentionAnswer, AttentionItem } from './attention';
import type { LimitState } from './limit';
import type { MergeRequest } from './mergeRequest';
import type { AppSettings } from './settings';
import type { UpdateState } from './update';
import type { UsageSample, UsageSeriesPoint, UsageSummary } from './usage';

/** Result of checking whether the local `claude` CLI is installed and logged in. */
export interface ClaudeStatus {
  /** True if a `claude` binary was found and responded to `--version`. */
  installed: boolean;
  /** The reported CLI version, if installed (e.g. "2.1.200"). */
  version?: string;
  /**
   * Whether the CLI appears to be authenticated with a subscription login
   * (an `~/.claude/.credentials.json` exists). This is a best-effort hint —
   * it does NOT prove the login is still valid.
   */
  authenticated: boolean;
  /** Whether an ANTHROPIC_API_KEY is set. We warn if so, to avoid API billing. */
  apiKeyDetected: boolean;
  /** Human-readable explanation shown in the UI when something is off. */
  message: string;
}

/**
 * One Claude conversation that already exists on disk for a project's directory
 * (Phase 8 B2), as offered by the "attach existing session" pick-list.
 */
export interface ClaudeSessionSummary {
  /** The id `claude --resume` takes — the transcript's filename. */
  sessionId: string;
  /** ISO timestamp of the conversation's first entry. */
  startedAt: string;
  /** ISO timestamp of its last activity, used to sort newest-first. */
  lastAt: string;
  /**
   * The opening human prompt, collapsed to one line, so a conversation can be
   * recognized without opening it. Empty when none could be read.
   */
  preview: string;
}

/** Snapshot of the JIRA connection's configuration state (for the Settings UI). */
export interface JiraConfigStatus {
  /** Whether the integration is switched on. */
  enabled: boolean;
  /** Whether a token has been stored (never the token itself). */
  hasToken: boolean;
  /** Whether the OS secure store is available to encrypt the token. */
  encryptionAvailable: boolean;
  /**
   * Linux only: no keyring was found (WSL, headless, a minimal desktop), so the token
   * is encrypted with Electron's built-in fixed password instead — obfuscated on disk,
   * not protected from anyone with access to the machine. The Settings pane says so.
   */
  plainTextStorage: boolean;
  deployment: 'server' | 'cloud';
  baseUrl: string;
}

/**
 * One workflow status the connected JIRA instance defines — what the Settings status
 * map offers instead of making you type names from memory.
 *
 * `category` is what the status would map to WITHOUT an override, so the form can show
 * you that "Code Review" lands in In Progress by default and is therefore exactly the
 * kind of status worth mapping.
 */
export interface JiraStatusOption {
  name: string;
  category: JiraStatusCategory;
}

/**
 * The status list plus why it might be empty. `error` is null on success — including a
 * genuine success that returned nothing — and carries the reason otherwise ("JIRA is
 * off", "no token stored", or the instance's own message).
 */
export interface JiraStatusList {
  statuses: JiraStatusOption[];
  error: string | null;
}

/** A JIRA project the Add-task dialog can create an issue in. */
export interface JiraProjectOption {
  key: string;
  name: string;
}

/** An issue type within a project. Subtask types are never offered. */
export interface JiraIssueTypeOption {
  id: string;
  name: string;
  iconUrl: string | null;
}

/** One person the @mention picker can offer. `id` is a Cloud accountId or a DC username. */
export interface JiraUserOption {
  id: string | null;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

/** A person named in a comment, as a range into its text. */
export interface JiraCommentMention {
  start: number;
  end: number;
  id: string | null;
  displayName: string;
}

/** Everything a composed JIRA comment carries. */
export interface JiraCommentDraft {
  text: string;
  mentions?: JiraCommentMention[];
  /** Absolute paths, read and uploaded by main. */
  attachmentPaths?: string[];
}

/** Result of a JIRA "Test connection" attempt. */
export interface JiraTestResult {
  ok: boolean;
  /** The authenticated user's display name, on success. */
  displayName?: string;
  /** Human-readable detail (error text on failure, a greeting on success). */
  message: string;
}

/** Basic facts about the running app, shown in the UI footer / About. */
export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: NodeJS.Platform;
}

/**
 * INVOKE channels: request → response.
 *
 * Each key is a channel name; the function type documents its arguments and the
 * value it resolves to. The preload bridge and the main-process handlers are
 * both derived from this one interface (see src/preload/index.ts and
 * src/main/ipc.ts), so they can never drift apart.
 */
export interface IpcApi {
  /** Return version/runtime info about the desktop app itself. */
  'app:getInfo': () => Promise<AppInfo>;
  /**
   * Whether the Claude CLI is ready on the machines the user's projects actually run
   * on — not merely on this one, which would warn forever for someone whose CLI lives
   * only inside a WSL distro.
   */
  'claude:getStatus': () => Promise<ClaudeStatus>;
  /**
   * The Claude conversations already on disk for a working directory, newest first,
   * so adopting one is a pick rather than a pasted UUID (Phase 8 B2). `target` says
   * which machine ran them — a WSL project's transcripts live in that distro.
   *
   * Best-effort: this reads an undocumented CLI layout and returns an empty list
   * rather than failing when it is absent, so the manual paste path always stands.
   */
  'claude:listSessions': (cwd: string, target?: ExecTarget) => Promise<ClaudeSessionSummary[]>;

  /** Installed WSL distros, for the execution-target picker. Empty when WSL is absent. */
  'exec:listDistros': () => Promise<string[]>;
  /**
   * Whether an execution target can actually run tasks, and what is missing if not.
   * The target may be a machine the app has never touched, so this is reported in the
   * UI rather than discovered when a task fails.
   */
  'exec:readiness': (target: ExecTarget) => Promise<TargetReadiness>;
  /**
   * The machines the user's projects actually run on, so Settings can report each of
   * them rather than only the default for new projects.
   */
  'exec:targetsInUse': () => Promise<ExecTarget[]>;
  /** Start one Claude session for a task. Resolves with a run id to track it. */
  'session:start': (request: StartSessionRequest) => Promise<{ runId: string }>;
  /** Stop a running session by its run id (kills the underlying process). */
  'session:stop': (runId: string) => Promise<void>;
  /**
   * Push a message into a running session's open input stream (Phase 4), so a
   * human's answer to a question or approval continues the SAME session — no
   * restart, no lost context. No-op if the run is unknown or already exited.
   */
  'session:answer': (runId: string, message: string) => Promise<void>;

  /** Open a native folder picker. Resolves to the chosen path, or null if cancelled. */
  'project:pickDirectory': () => Promise<string | null>;
  /** Open a native file picker (markdown), for choosing a custom plan file (Phase 8). */
  'project:pickFile': () => Promise<string | null>;
  /** Add a project, parse its plan into tasks, and return it with those tasks. */
  'project:add': (input: AddProjectInput) => Promise<ProjectWithTasks>;
  /** List every project, each bundled with its current tasks. */
  'project:list': () => Promise<ProjectWithTasks[]>;
  /** Remove a project and all its tasks. */
  'project:remove': (id: string) => Promise<void>;
  /** Re-read a project's plan file and reconcile it into the task list. */
  'project:syncPlan': (id: string) => Promise<Task[]>;
  /** Toggle whether completing a task ticks its checkbox back into the plan file. */
  'project:setWriteBack': (id: string, enabled: boolean) => Promise<void>;
  /**
   * Set a project's team-orchestration alignment flag (backward-compat nudge).
   * Passing `true` dismisses the "align this plan" prompt for a legacy project; the
   * flag is purely a UI hint and never changes how the project runs.
   */
  'project:setAligned': (id: string, aligned: boolean) => Promise<void>;
  /**
   * Edit an existing project's name / plan file / model / permission mode /
   * write-back (Phase 8). Returns the updated project, or null if unknown. Model
   * and mode changes take effect on the next task run.
   */
  'project:update': (id: string, patch: ProjectPatch) => Promise<Project | null>;
  /** Parse a project's plan file and check its `@needs:` dependencies (resolve + no cycles). */
  'project:validatePlan': (id: string) => Promise<PlanValidation>;
  /**
   * Launch an AI pass that reads the plan and adds `@needs:` dependency annotations,
   * writing the file back for the user to review. Returns the run id so the UI can
   * show its live transcript; the plan watcher re-syncs once the file changes.
   */
  'project:alignPlan': (id: string) => Promise<{ runId: string }>;

  /**
   * List the agent projects — repo directories a My Tasks card can be delegated to
   * (`kind: 'agent'`). Deliberately separate from `project:list`, which returns only
   * the legacy plan-driven projects shown on the Projects tab.
   */
  'agentProject:list': () => Promise<Project[]>;
  /**
   * Create an agent project from a folder (+ optional name, epic keys, defaults).
   * No plan file is parsed or watched. Returns the created project.
   */
  'agentProject:add': (input: AddProjectInput) => Promise<Project>;
  /** Edit an agent project (folder, name, epic keys, model, mode). Null if unknown. */
  'agentProject:update': (id: string, patch: ProjectPatch) => Promise<Project | null>;
  /** Remove an agent project. Rejects while one of its runs is still live. */
  'agentProject:remove': (id: string) => Promise<void>;

  /**
   * Start (or resume) a project's queue: the scheduler runs its `pending` tasks
   * in order, one session at a time, until the queue drains or is paused/stopped.
   */
  'scheduler:start': (projectId: string) => Promise<void>;
  /** Stop starting new tasks for a project, but let any in-flight task finish. */
  'scheduler:pause': (projectId: string) => Promise<void>;
  /** Stop a project's queue and terminate any of its running sessions. */
  'scheduler:stop': (projectId: string) => Promise<void>;
  /** Snapshot of tasks currently executing, so the Board can wire live transcripts on load. */
  'scheduler:activeRuns': () => Promise<ActiveRun[]>;
  /** Snapshot of each project's run state, so the Board's buttons survive a remount. */
  'scheduler:states': () => Promise<SchedulerChange[]>;
  /** Run a single task ad-hoc (independent of its project's queue). Returns its run id. */
  'task:run': (taskId: string) => Promise<{ runId: string }>;
  /**
   * Merge a finished card's branch back into its base, on the human's say-so (Phase 17).
   *
   * Integration is manual unless `AppSettings.autoIntegrate` is on, because merging at the
   * moment the agent stops is merging at the moment the work has been reviewed least.
   * Resolves once the merge has been STARTED; its outcome arrives as a task note, or as an
   * inbox item when it conflicts.
   */
  'task:integrate': (taskId: string) => Promise<void>;
  /**
   * Create an ad-hoc task in a project (Phase 8) — no plan line required, so
   * plan-less projects are usable and you can add work on the fly. Returns the task.
   */
  'task:create': (
    projectId: string,
    input: { title: string; phase?: string; type?: TaskType | null },
  ) => Promise<Task>;
  /** Delete a task (and its history, and any steps under it). Rejects if it is running. */
  'task:delete': (taskId: string) => Promise<void>;
  /**
   * A card's steps, in execution order (Phase 11). Empty for a card that has none.
   */
  'task:subtasks': (parentTaskId: string) => Promise<Task[]>;
  /**
   * Append a step to a card — either from an approved plan or written by hand. The
   * step inherits the parent's agent project and model and runs in
   * `bypassPermissions`. Rejects if the parent is unknown or is itself a step.
   * Returns the created step.
   */
  'task:addSubtask': (
    parentTaskId: string,
    input: { title: string; description?: string | null },
  ) => Promise<Task>;
  /**
   * Edit a step's title and/or brief. Rejects while the step is mid-run (its prompt
   * is built from the brief, so changing it under a live session is meaningless).
   * Returns the updated step.
   */
  'task:updateSubtask': (
    taskId: string,
    patch: { title?: string; description?: string | null },
  ) => Promise<Task>;
  /**
   * Set a task's status by hand (Phase 9 to-do list). Only `MANUAL_STATUSES` are
   * accepted, and only when the task isn't mid-run. Records the change on the task's
   * activity timeline and returns the updated task.
   */
  'task:setStatus': (taskId: string, status: ManualStatus) => Promise<Task>;
  /**
   * Rewrite the card's description — the text the agent's prompt quotes as the ticket
   * body. For a JIRA card this edits the app's copy only: nothing is written back to
   * the tracker, and the next sync replaces it with whatever the issue says (the pane
   * says so). Empty clears it. Returns the updated task.
   */
  'task:setDescription': (taskId: string, description: string) => Promise<Task>;
  /**
   * Set a task's priority by name (`null` clears it). Unlike the description, this
   * one DOES write back: for a JIRA card the issue is updated first and the local row
   * only follows if JIRA accepted, so the two can never disagree. Allowed mid-run —
   * priority is not scheduler state.
   */
  'task:setPriority': (taskId: string, priority: string | null) => Promise<Task>;
  /**
   * Post a free-text progress note on a card: it becomes the card's headline
   * (`Task.statusNote`, shown on the board) and is filed on the timeline, so the ones
   * it replaced are still readable. Empty text clears the headline without filing
   * anything. Never leaves the app — this is a note to yourself, not a JIRA comment.
   */
  'task:setStatusNote': (taskId: string, note: string) => Promise<Task>;
  /**
   * Tag a card with the project it belongs to (`null` untags it) — WITHOUT starting
   * anything. Writes `Task.projectTagId`, which is the whole point: this used to set
   * the same `agentProjectId` that `task:assignAgent` sets, so filing a card gave it
   * the agent glyph and made the pane offer to *reassign* something nobody had
   * assigned. Saying "this is a Billing card" is filing, not delegating, and the two
   * are not the same click. The card's board (`projectId`) never changes.
   */
  'task:setProject': (taskId: string, projectTagId: string | null) => Promise<Task>;
  /**
   * Change the model / permission mode a delegated card runs with, WITHOUT restarting
   * it (unlike `task:assignAgent`). A live run keeps what it started with — these are
   * captured on the run — so the change applies to the next one.
   */
  'task:setAgentOptions': (
    taskId: string,
    options: { model?: ClaudeModel | null; mode?: PermissionMode | null },
  ) => Promise<Task>;
  /** The task's unified activity timeline (comments + status changes + AI transcript). */
  'task:activity': (taskId: string) => Promise<TaskActivityEntry[]>;
  /** Add a human progress comment to a task; returns the created timeline entry. */
  'task:addComment': (taskId: string, body: string) => Promise<TaskActivityEntry>;
  /** Delete one comment by its id. */
  'task:deleteComment': (commentId: number) => Promise<void>;
  /**
   * Adopt an existing Claude conversation (Phase 8): set a task's `sessionId` to a
   * session-id you already have, and re-queue it to `pending`, so the next run
   * RESUMES that conversation (`claude --resume`) instead of starting fresh.
   * Rejects if the task is currently running. Returns the updated task, or null.
   */
  'task:attachSession': (taskId: string, sessionId: string) => Promise<Task | null>;
  /**
   * A task's persisted transcript — every normalized event from all of its runs,
   * in order (Phase 6). Lets a view show past output instead of a blank pane.
   */
  'task:history': (taskId: string) => Promise<SessionEvent[]>;
  /**
   * Remove a task's leftover git worktree/branch (team orchestrator): a manual sweep
   * for a failed/abandoned task whose worktree the orchestrator deliberately kept.
   * No-op for non-worktree projects. Safe only when the task isn't mid-run.
   */
  'task:cleanupWorktree': (taskId: string) => Promise<void>;

  /**
   * Delegate a My Tasks card to an agent: persist the assignment (agent project +
   * optional per-assignment model/mode), record the human's instructions as a comment
   * on the task's timeline, and start the run in the agent project's repo. The card
   * stays on the Personal board; only the RUN happens in the other project. Rejects if
   * the task is already mid-run, the target isn't an agent project, or a usage limit is
   * holding all work. Returns the updated task.
   */
  'task:assignAgent': (taskId: string, input: AssignAgentInput) => Promise<Task>;
  /**
   * Stop the agent working on one card (leaving its branch/worktree in place for a
   * later resume). No-op if nothing is running for that task. Returns the updated task.
   */
  'task:stopAgent': (taskId: string) => Promise<Task>;
  /**
   * Say something to the agent working this card (Phase 12) — the card's half of a
   * conversation, not an answer to a question it asked. The message is recorded on the
   * timeline as a `chat` entry and delivered to the live session's open input stream.
   * A card whose STEP is running routes to that step (the result says which task got
   * it). Never rejects for an expected condition: "nothing is running", "answer the
   * pending permission first" and friends come back as `{ status: 'refused', reason }`
   * so the UI can explain itself.
   */
  'task:chat': (taskId: string, message: string) => Promise<ChatSendResult>;

  /** Snapshot of everything currently waiting on a human (seed the inbox on load). */
  'attention:list': () => Promise<AttentionItem[]>;
  /**
   * Answer one inbox item. For a `permission` item this releases (or vetoes) the
   * blocked tool; for a `question` it pushes the reply into the session. Either
   * way the item clears and its task returns to `running`.
   */
  'attention:answer': (itemId: string, answer: AttentionAnswer) => Promise<void>;

  /**
   * The active usage-limit gate (Phase 5), or `null` if no limit is in force —
   * used to seed the countdown banner when a view mounts. Live changes arrive on
   * the `limit:changed` event.
   */
  'limit:current': () => Promise<LimitState | null>;

  /**
   * Lift the usage-limit gate immediately (the banner's "Resume now") — for a false
   * trip or a limit that has already cleared. Resumes parked tasks and clears the
   * gate; the UI updates via the `limit:changed` → `null` event.
   */
  'limit:resumeNow': () => Promise<void>;

  /**
   * The rolled-up token usage for a range (Performance dashboard): totals, the
   * per-source (task vs orchestrator) split, the project → task drill-down, live
   * burn rate, cost, and running-low state. `sinceMs` is the range start (epoch ms);
   * pass 0 for all-time. Computed by the app from the CLI's own token counts. Live
   * changes arrive via the `usage:sample` event.
   */
  'usage:summary': (sinceMs: number) => Promise<UsageSummary>;
  /**
   * The token-over-time series behind the live area chart: totals bucketed into
   * `bucketMs` windows from `sinceMs` to now. Used to seed the chart on mount.
   */
  'usage:series': (sinceMs: number, bucketMs: number) => Promise<UsageSeriesPoint[]>;

  /** The current global app settings (Phase 6). */
  'settings:get': () => Promise<AppSettings>;
  /** Persist the global app settings; scheduler knobs take effect on the next task. */
  'settings:save': (settings: AppSettings) => Promise<void>;

  /** Whether JIRA is enabled, has a stored token, and can encrypt one (Settings UI). */
  'jira:getConfigStatus': () => Promise<JiraConfigStatus>;
  /**
   * Store the JIRA Personal Access Token, encrypted via the OS secure store. Rejects
   * (ok:false) if the OS secure store is unavailable — never persists it in plaintext.
   */
  'jira:setCredentials': (pat: string) => Promise<{ ok: boolean; message: string }>;
  /** Remove the stored JIRA token. */
  'jira:clearCredentials': () => Promise<void>;
  /** Verify the base URL + token by calling `/myself`; returns the display name. */
  'jira:testConnection': () => Promise<JiraTestResult>;

  // --- GitLab. Mirrors the JIRA channels above, one auth mode simpler. ---
  /** Whether GitLab is enabled, has a stored token, and can encrypt one. */
  'gitlab:getConfigStatus': () => Promise<JiraConfigStatus>;
  /** Store the GitLab personal access token, encrypted via the OS secure store. */
  'gitlab:setCredentials': (token: string) => Promise<{ ok: boolean; message: string }>;
  /** Remove the stored GitLab token. */
  'gitlab:clearCredentials': () => Promise<void>;
  /** Verify base URL + token by calling `/user`; returns the username. */
  'gitlab:testConnection': () => Promise<JiraTestResult>;
  /** Fetch merge requests and reconcile them onto the board. Returns the full list. */
  'gitlab:sync': () => Promise<MergeRequest[]>;
  /**
   * Every stored merge request, for the whole board in one call.
   *
   * Deliberately NOT hung off `Task`: `issueToTask` rebuilds the whole task literal on
   * every JIRA sync and `upsertJiraTask` writes the whole row, so an MR array living
   * there would be clobbered every poll. The board holds the array and derives its own
   * `Map<taskId, MergeRequest[]>`, exactly as it does for `board:tasks`.
   */
  'gitlab:mergeRequests': () => Promise<MergeRequest[]>;
  /** Mark an MR's discussion read (clears the comment half of its attention). */
  /**
   * Rename a merge request **in this app only** — pass null or blank to go back to the
   * upstream title. Never written to GitLab, and preserved across syncs.
   */
  'gitlab:setMergeRequestName': (mrId: string, name: string | null) => Promise<MergeRequest[]>;
  'gitlab:markRead': (mrId: string) => Promise<MergeRequest[]>;
  /** Acknowledge an MR's pipeline/approval events (the other half, tracked separately). */
  'gitlab:markEventsSeen': (mrId: string) => Promise<MergeRequest[]>;
  /**
   * The connected instance's priority names, most urgent first — what the detail
   * pane's priority dropdown offers for a JIRA card, since only names this instance
   * has can be written back. Cached per base URL. Empty when JIRA is off or the call
   * failed; the caller falls back to `DEFAULT_PRIORITIES` rather than showing nothing.
   */
  'jira:priorities': () => Promise<string[]>;
  /**
   * Every workflow status the connected instance defines, with the column each would
   * fall into on its own — what the Settings status map offers so the names don't have
   * to be typed from memory. Cached per base URL. Empty when JIRA is off, no token is
   * stored, or the call failed; the field stays free-text either way, so a status the
   * instance won't tell us about can still be mapped by hand.
   *
   * Returns the failure alongside the list rather than throwing: an empty table is a
   * shrug unless it can say WHY it is empty, and the status-map viewer is exactly the
   * screen where a silent empty state hides a misconfiguration.
   */
  'jira:statuses': () => Promise<JiraStatusList>;
  /** Every task on the standalone Personal board (JIRA tickets + internal ad-hoc). */
  'board:tasks': () => Promise<Task[]>;
  /**
   * Fetch the user's JIRA issues (per the configured JQL) and reconcile them into the
   * Personal board, preserving internal-only state. Returns the board's full task list.
   */
  'jira:sync': () => Promise<Task[]>;
  /**
   * Move a task to a board column via drag-and-drop. Applies the status/JIRA-transition
   * rules (TO DO → IN PROGRESS transitions JIRA; to/from Blocked never does). If a
   * required JIRA transition fails, the local status is left unchanged and this rejects.
   */
  'task:move': (taskId: string, toColumn: BoardColumn) => Promise<Task>;
  /** Fetch the linked JIRA issue's comments as timeline entries (empty for non-JIRA tasks). */
  'jira:fetchComments': (taskId: string) => Promise<TaskActivityEntry[]>;
  /**
   * Post a comment to the linked JIRA issue; also marks the task's comments as read.
   *
   * `mentions` are ranges into `text` (see `renderer/chat/mentions.ts`), not an inline
   * syntax. `attachmentPaths` are file paths on the machine the app runs on — the
   * renderer never ships bytes over IPC; main reads them and uploads. Files are attached
   * to the ISSUE and then cited from the comment, because a true inline media node needs
   * an Atlassian media-services token exchange a REST client cannot perform.
   */
  'jira:addComment': (taskId: string, body: JiraCommentDraft) => Promise<void>;
  /**
   * People matching a partial name, for the @mention picker. Scoped to the task's issue
   * when there is one, because global user search is permission-restricted on many Cloud
   * sites. Fails soft to `[]` — an empty picker still lets you type a plain name.
   */
  'jira:searchUsers': (taskId: string, query: string) => Promise<JiraUserOption[]>;
  /**
   * Open the OS file picker and return the chosen absolute paths. In main because the
   * renderer has no filesystem access and no business having any.
   */
  'jira:pickAttachments': () => Promise<string[]>;
  /**
   * Projects you may create an issue in. Cached per site; fails soft to `[]` — and an
   * empty list is a real answer (create-meta is permission-filtered), not a bug.
   */
  'jira:projects': () => Promise<JiraProjectOption[]>;
  /** Issue types available in one project. Cached per site+project; fails soft. */
  'jira:issueTypes': (projectKey: string) => Promise<JiraIssueTypeOption[]>;
  /**
   * Create a JIRA issue and put it on the Personal board.
   *
   * A separate channel from `task:create`, which is a purely local write that hardcodes
   * `source: 'adhoc'` and is used by other screens. The created issue is read back and
   * run through the same `issueToTask` a sync uses, so the new card is identical to a
   * synced one — hand-building the Task would make it mutate on the first poll.
   */
  'jira:createTask': (input: {
    projectKey: string;
    issueTypeId: string;
    summary: string;
    description?: string;
  }) => Promise<Task>;
  /** Mark a JIRA task's comments as read (clears the unread border); returns the task. */
  'jira:markRead': (taskId: string) => Promise<Task>;

  /** Frameless-window controls, driven by the renderer's custom title bar. */
  'window:minimize': () => Promise<void>;
  /** Toggle maximize/restore. */
  'window:toggleMaximize': () => Promise<void>;
  /** Close the window (quits the app). */
  'window:close': () => Promise<void>;
  /** Whether the window is currently maximized (seed the restore/maximize icon). */
  'window:isMaximized': () => Promise<boolean>;

  /**
   * The auto-updater's current state, for seeding the status bar and the Settings block
   * on mount. Live changes arrive on `update:changed`.
   */
  'update:get': () => Promise<UpdateState>;
  /**
   * Check the release feed now (Settings' "Check now"). Resolves with the state after
   * the check was *started* — the result arrives over `update:changed`, since a download
   * outlives the call. No-op on an install that can't update itself.
   */
  'update:check': () => Promise<UpdateState>;
  /**
   * Quit and apply the downloaded update. Does nothing until a download has finished,
   * so the button can be shown optimistically.
   */
  'update:install': () => Promise<void>;
}

/**
 * EVENT channels: the engine → UI push notifications. Phase 0 has none yet;
 * later phases add e.g. 'session:output', 'attention:new', 'limit:changed'.
 * Declared as an (initially empty) map so the preload/renderer typings are ready.
 */
export interface IpcEvents {
  /** A normalized event from a running Claude session (see SessionEventEnvelope). */
  'session:event': SessionEventEnvelope;
  /** A task's status/sessionId changed (with its live runId while executing). */
  'task:changed': TaskChange;
  /** A project's queue moved between running/paused/idle. */
  'scheduler:changed': SchedulerChange;
  /** A task needs a human: a permission request or a clarifying question. */
  'attention:new': AttentionItem;
  /** An inbox item was answered/cleared, so the UI can remove it. */
  'attention:resolved': { id: string };
  /**
   * The account-wide usage-limit gate changed (Phase 5): a `LimitState` when a
   * limit engages (or its parked set/reset time changes), or `null` when it
   * clears and work resumes. Drives the global countdown banner.
   */
  'limit:changed': LimitState | null;
  /**
   * A token-usage sample was just recorded (Performance dashboard): one turn's spend
   * from a task or the orchestrator. The dashboard appends it to its live buffer and
   * recomputes the burn rate. Carries enough to update the chart without re-querying.
   */
  'usage:sample': UsageSample;
  /** The frameless window was maximized (true) or restored (false) — updates the title-bar icon. */
  'window:maximizedChanged': boolean;
  /**
   * A project's task list changed as a whole (Phase 8): the plan file was edited
   * (by a human or the agent mid-run) and re-synced live, or a task was created/
   * deleted. Carries the project's full, current task list so the UI can replace it.
   */
  'project:tasksChanged': { projectId: string; tasks: Task[] };
  /**
   * The merge-request list changed — a GitLab sync landed, or a read marker moved.
   * Mirrors `project:tasksChanged`: the whole list, so the board replaces rather than
   * patches.
   */
  'gitlab:mergeRequestsChanged': MergeRequest[];
  /**
   * Settings changed in the MAIN process rather than on the Settings screen — the
   * engine learning a JIRA status→column mapping from a successful drag, for one.
   *
   * Both `Settings` and `MyTasks` load the whole `AppSettings` blob at mount and save
   * it back whole, so without this push the next save from either screen would write
   * a stale copy back over anything the engine had learned since.
   */
  'settings:changed': AppSettings;
  /**
   * The auto-updater moved: a check started, a version was found, a download progressed,
   * or a build is ready to install on quit. Carries the whole state, so the UI replaces
   * rather than merges.
   */
  'update:changed': UpdateState;
}

/** Convenience: the set of valid invoke channel names. */
export type IpcInvokeChannel = keyof IpcApi;

/** Convenience: the set of valid event channel names. */
export type IpcEventChannel = keyof IpcEvents;
