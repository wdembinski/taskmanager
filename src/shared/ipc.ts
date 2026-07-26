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
import type { SessionEvent, SessionEventEnvelope, StartSessionRequest } from './session';
import type {
  AddProjectInput,
  AssignAgentInput,
  BoardColumn,
  ManualStatus,
  PlanValidation,
  Project,
  ProjectPatch,
  ProjectWithTasks,
  Task,
  TaskActivityEntry,
  TaskType,
} from './model';
import type { ActiveRun, SchedulerChange, TaskChange } from './scheduler';
import type { AttentionAnswer, AttentionItem } from './attention';
import type { LimitState } from './limit';
import type { AppSettings } from './settings';
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

/** Snapshot of the JIRA connection's configuration state (for the Settings UI). */
export interface JiraConfigStatus {
  /** Whether the integration is switched on. */
  enabled: boolean;
  /** Whether a token has been stored (never the token itself). */
  hasToken: boolean;
  /** Whether the OS secure store is available to encrypt the token. */
  encryptionAvailable: boolean;
  deployment: 'server' | 'cloud';
  baseUrl: string;
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
  /** Check whether the Claude CLI is installed and logged in on this machine. */
  'claude:getStatus': () => Promise<ClaudeStatus>;
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
   * Create an ad-hoc task in a project (Phase 8) — no plan line required, so
   * plan-less projects are usable and you can add work on the fly. Returns the task.
   */
  'task:create': (
    projectId: string,
    input: { title: string; phase?: string; type?: TaskType | null },
  ) => Promise<Task>;
  /** Delete a task (and its history). Rejects if it is currently running. */
  'task:delete': (taskId: string) => Promise<void>;
  /**
   * Set a task's status by hand (Phase 9 to-do list). Only `MANUAL_STATUSES` are
   * accepted, and only when the task isn't mid-run. Records the change on the task's
   * activity timeline and returns the updated task.
   */
  'task:setStatus': (taskId: string, status: ManualStatus) => Promise<Task>;
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
  /** Post a comment to the linked JIRA issue; also marks the task's comments as read. */
  'jira:addComment': (taskId: string, body: string) => Promise<void>;
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
}

/** Convenience: the set of valid invoke channel names. */
export type IpcInvokeChannel = keyof IpcApi;

/** Convenience: the set of valid event channel names. */
export type IpcEventChannel = keyof IpcEvents;
