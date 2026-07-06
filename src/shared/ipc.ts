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
import type { SessionEventEnvelope, StartSessionRequest } from './session';
import type { AddProjectInput, ProjectWithTasks, Task } from './model';
import type { ActiveRun, SchedulerChange, TaskChange } from './scheduler';
import type { AttentionAnswer, AttentionItem } from './attention';
import type { LimitState } from './limit';

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
  /** Run a single task ad-hoc (independent of its project's queue). Returns its run id. */
  'task:run': (taskId: string) => Promise<{ runId: string }>;

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
}

/** Convenience: the set of valid invoke channel names. */
export type IpcInvokeChannel = keyof IpcApi;

/** Convenience: the set of valid event channel names. */
export type IpcEventChannel = keyof IpcEvents;
