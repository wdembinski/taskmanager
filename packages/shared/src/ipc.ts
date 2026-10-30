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
  DiscoveredModel,
  GitPreflight,
  JiraStatusCategory,
  ManualStatus,
  Milestone,
  MilestoneInput,
  ModelResolution,
  Person,
  PersonInput,
  PersonPatch,
  PlanValidation,
  Project,
  ProjectPatch,
  ProjectWithTasks,
  Task,
  TaskActivityEntry,
  TaskType,
  TicketGraphPosition,
  TicketInput,
  TicketLabel,
  TicketLabelInput,
  TicketLink,
  TicketLinkType,
  TicketPatch,
} from './model';
import type { AddAgentProfileInput, AgentProfile, AgentProfilePatch } from './agent';
import type { AiReview, AiReviewRefusal } from './aiReview';
import type { NativeMaterial } from './canvas';
import type { PastedAttachment, TaskAttachment, UploadedAttachment } from './attachments';
import type { IssuePage, IssueProviderId, IssueQuery } from './issues';
import type { GitGraph } from './gitGraph';
import type { ExecTarget, TargetReadiness } from './execTarget';
import type { ActiveRun, RunOutcome, SchedulerChange, TaskChange } from './scheduler';
import type { VariantCount, VariantSummaryRow } from './variants';
import type { AttentionAnswer, AttentionItem } from './attention';
import type { AuthState } from './auth';
import type { LimitState } from './limit';
import type { MergeRequest } from './mergeRequest';
import type { SignOffStatus } from './visualSignOff';
import type {
  DiffContextResult,
  DiffFileResult,
  DiffImageResult,
  DiffSide,
  DiffSummaryResult,
  ReviewAddResult,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentPatch,
  ReviewDeleteResult,
  ReviewQueuesSnapshot,
  ReviewSendResult,
  ReviewUpdateResult,
  ReviewViewedMark,
} from './review';
import type { LinkGate, LinkResult, TaskLink } from './taskChain';
import type { TicketLinkResult } from './ticketLinks';
import type { AppSettings } from './settings';
import type { SyncState } from './sync';
import type { UpdateState } from './update';
import type { Automation, AutomationRun } from './automation';
import type {
  DailyUsagePoint,
  SessionStat,
  UsageDailyOptions,
  UsageQuotas,
  UsageSample,
  UsageSeriesPoint,
  UsageSummary,
} from './usage';
import type {
  ActivityCursor,
  ActivityOverview,
  ActivityPage,
  ActivityPeriod,
  ActivityQuery,
  ActivityRow,
} from './activity';
import type {
  RepoSkillDetail,
  RepoSkillSummary,
  Skill,
  SkillDraft,
  SkillExportResult,
  SkillImportRequest,
  SkillImportResult,
  SkillSaveResult,
} from './skills';
import type {
  WorkflowApplyResult,
  WorkflowDoc,
  WorkflowDraft,
  WorkflowExportResult,
  WorkflowImportRequest,
  WorkflowImportResult,
  WorkflowSaveResult,
} from './workflow';
import type { BoardReviewRecord } from './boardReview';
import type { TaskBundle, TaskDelta, TaskSummary } from './taskSummary';
import type {
  ArchivedListing,
  ArchiveResult,
  ArchiveTarget,
  OpenTicketsChoice,
} from './trackerArchive';

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
  /**
   * What `@shared/autoMerge`'s `autoMergePrerequisites` found missing for each project with
   * "Merge on green" switched on whose `origin` belongs to this forge — GitHub's and
   * GitLab's own `testConnection` handlers fill this in, never JIRA's. Absent
   * (not just empty) when nothing was checked, so Settings can tell "no projects to check"
   * apart from "checked, nothing missing" without a third state on `missing`. Deliberately
   * independent of {@link ok}: a missing prerequisite is never a reason to fail the token
   * check that is the rest of this result.
   */
  prerequisites?: { project: string; missing: string[] }[];
}

/**
 * Snapshot of the desktop's cloud personal-access-token state (for the Settings UI).
 *
 * The cloud follows the exact same four-channel convention as JIRA/GitLab/GitHub now — a
 * pasted credential, not a sign-in — so this is shaped like `JiraConfigStatus` where the two
 * overlap (`hasToken`, `encryptionAvailable`, `plainTextStorage`) plus the finer-grained facts
 * only a cloud connection needs: whether the stored token has actually been used successfully.
 */
export interface CloudConfigStatus {
  /** Whether a token has been stored (never the token itself). */
  hasToken: boolean;
  /** Whether the OS secure store is available to encrypt the token. */
  encryptionAvailable: boolean;
  /** Linux only: no keyring found, so the token is obfuscated rather than encrypted — see
   *  `JiraConfigStatus.plainTextStorage`. */
  plainTextStorage: boolean;
  /**
   * `CloudTokenProvider.state()` — mirrors its `CloudAuthState` (kept as a plain string union
   * here rather than imported, since main's provider must not become a dependency of shared).
   */
  authState: 'no-token' | 'stored' | 'active' | 'rejected';
  /** `CloudTokenProvider.explain()`, but only when `authState` names an actual problem
   *  (`'rejected'`) — null otherwise, including while merely `'no-token'`. */
  authError: string | null;
  /** When a request last succeeded using the current token, or null if it never has
   *  (including right after a fresh paste, before the first sync). */
  lastAcceptedAt: number | null;
  /**
   * True for the rest of this app run if a pre-PAT vipper.iam refresh token was found (and
   * dropped) on startup — see `Store.clearLegacyCloudSignIn`. Lets Settings tell a returning
   * signed-in user their sign-in was replaced, rather than leaving them to notice a blank
   * field and wonder what they did wrong.
   */
  legacySignInRetired: boolean;
}

/**
 * Snapshot of the private update feed's token (for the Settings UI) — the same
 * `hasToken`/`encryptionAvailable`/`plainTextStorage` trio as `JiraConfigStatus`, plus which
 * source is actually feeding the updater right now.
 */
export interface UpdateTokenStatus {
  /** Whether a token has been stored (never the token itself). */
  hasToken: boolean;
  /** Whether the OS secure store is available to encrypt the token. */
  encryptionAvailable: boolean;
  /** Linux only: no keyring found, so the token is obfuscated rather than encrypted — see
   *  `JiraConfigStatus.plainTextStorage`. */
  plainTextStorage: boolean;
  /**
   * Mirrors main's own `UpdateTokenSource` (`apps/client/src/main/updateFeed.ts`), kept as a
   * plain string union here rather than imported, since main must not become a dependency of
   * shared.
   */
  source: 'stored' | 'gh' | 'none';
}

/** Basic facts about the running app, shown in the UI footer / About. */
export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: NodeJS.Platform;
  /**
   * The desktop's machine name (`os.hostname()`) — where its agents run. Relayed, so the web
   * reads the desktop's own; optional because a desktop older than the field never sends it.
   */
  hostname?: string;
}

/**
 * One board `board:tasks`/`board:archived`'s `scope` may select — what a scope picker
 * offers. The Personal board first, then every OTHER project with no plan file (a bare
 * repo or a ticket project): the ones a human arranges by hand rather than a queue the
 * scheduler drains top-to-bottom. `color` is the same board-stripe hex as `Project.color`
 * (`''` for none); Personal always carries `''`.
 */
export interface BoardScope {
  id: string;
  name: string;
  color: string;
  /**
   * Whether this board owns tickets (`Project.ticketPrefix` set) — the one fact the
   * Add-task dialog's merged "Project / Board" picker routes on: `ticket:create` when
   * true, `task:create` when not. Personal always carries `false` — it owns no tickets.
   */
  ownsTickets: boolean;
  /**
   * This board's own `Project.archivedAt` — `null` for Personal, which can never be
   * archived. Lets a scope picker drop archived boards via `pickableProjects` while
   * still keeping one already selected visible.
   */
  archivedAt?: number | null;
}

/**
 * The commit message a forge itself would propose for merging one MR/PR, and the method
 * that proposal was rendered for — GitHub's `getMergeProposal` / GitLab's `getMergeProposal`
 * verbatim, unioned into one shape since the merge dialog asks the same two questions of
 * either forge.
 *
 * `method` is read off the SAME toggles the merge call itself resolves (GitHub's
 * `pickMergeMethod`, GitLab's `mergeMethod`/`squashOnMerge`), so the proposal and the merge
 * can never disagree about which one applies. `rebase` (GitHub) and `ff` (GitLab) create no
 * merge commit, so neither forge has a message to propose for them and `message` is null.
 *
 * `message` is also null when the proposal could not be read at all — an older instance, a
 * token without the scope GraphQL needs — so the dialog can fall back to an empty, editable
 * field rather than inventing a message. See `ConfirmMergeDialog`'s `loadProposal`.
 */
export interface MergeProposal {
  method: 'merge' | 'squash' | 'rebase' | 'ff';
  message: string | null;
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
  /**
   * The desktop's cached read of what the installed CLI actually offers right now —
   * one {@link DiscoveredModel} per catalog entry plus any live alias the CLI names
   * that the static catalog doesn't already carry, in catalog order. Answered from an
   * in-memory cache seeded from disk at boot, so opening a model picker never waits on
   * a subprocess; pass `{ refresh: true }` to force a fresh sweep (a few seconds, zero
   * tokens — `/model` is a local meta-command like `/usage`).
   */
  'model:catalog': (opts?: { refresh: boolean }) => Promise<DiscoveredModel[]>;
  /**
   * Resolve ONE model id the same way, for the model picker's "Custom…" box — a value
   * that was never in `MODEL_CATALOG` and so was never part of the cached sweep above.
   */
  'model:resolve': (id: ClaudeModel) => Promise<ModelResolution>;

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
  /**
   * Add a project — a plan-driven queue, a bare repo, a ticket project, or any mix of the
   * three, since capabilities are derived from which fields are set (see `hasPlan` /
   * `hasRepo` / `ownsTickets` in `@shared/model`) rather than from a `kind` the caller picks.
   * A project with no folder is legal: `path` is optional on {@link AddProjectInput}. Parses
   * a plan into tasks when one exists, and returns it with those tasks (empty otherwise).
   */
  'project:add': (input: AddProjectInput) => Promise<ProjectWithTasks>;
  /**
   * Every project, each bundled with its current tasks — every SHAPE of project (plan-driven,
   * bare repo, ticket project) in the one list, since none of them is a special case any more.
   * The lone exclusion is the built-in Personal board (`PERSONAL_PROJECT_ID`): it is the
   * standalone My Tasks board rather than something to list or manage as a project.
   */
  'project:list': () => Promise<ProjectWithTasks[]>;
  /** Remove a project and all its tasks. Rejects while one of its runs is still live. */
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
   * Edit an existing project's name / folder / plan file / ticket prefix / model /
   * permission mode / write-back (Phase 8) — every shape of project through the one patch,
   * since none of them is a special case. Returns the updated project, or null if unknown.
   * Model and mode changes take effect on the next task run.
   */
  'project:update': (id: string, patch: ProjectPatch) => Promise<Project | null>;
  /**
   * "Review open tickets" (`@shared/boardReview`): start ONE read-only agent run over the
   * project's open tickets, or return the one already running. `reviewId` is null, with
   * `error`, when it was refused (no project, or no repo).
   */
  'project:reviewTickets': (id: string) => Promise<{ reviewId: string | null; error?: string }>;
  /** Stop the project's running ticket review, if any — it settles as failed. */
  'project:stopReview': (id: string) => Promise<void>;
  /** The project's latest ticket review, or null if it was never reviewed. */
  'project:boardReview': (id: string) => Promise<BoardReviewRecord | null>;
  /**
   * Apply ONE recommendation of a stored ticket review — `recId` is the ticket's ref
   * (`BoardReviewRecommendation.id`). Refused, never thrown, for an already-applied item or
   * a ticket no longer on the board; the outcome is stored on the review either way.
   */
  'project:applyReviewItem': (
    reviewId: string,
    recId: string,
  ) => Promise<{ ok: boolean; message: string }>;
  /** Parse a project's plan file and check its `@needs:` dependencies (resolve + no cycles). */
  'project:validatePlan': (id: string) => Promise<PlanValidation>;
  /**
   * Inspect a candidate project FOLDER's git state, before the project is saved — so the
   * add/edit form can say "this isn't a repo" or "this repo has no commits yet" while you can
   * still do something about it, instead of the first delegated task dying on `git worktree
   * add`. Takes a raw path + target rather than a project id precisely because the project may
   * not exist yet. Read-only: it never writes to the folder.
   */
  'project:gitPreflight': (path: string, target: ExecTarget) => Promise<GitPreflight>;

  /**
   * The project repository's recent history, laid out in lanes and ready to draw.
   *
   * The board shows what the app believes about a card; this shows what actually happened in
   * the repo — which branches exist, which forked from where, and which have merged back into
   * base. The refs come back role-marked (`base`, `card`), so a branch can be labelled with
   * the CARD it belongs to instead of a name like `orch/abc123`.
   *
   * `limit` caps the commits read (newest first); omit it for a sensible default. Never
   * rejects: a folder that isn't a repository, has no commits, or has gone missing comes back
   * as an empty graph with `reason` set, exactly like `project:gitPreflight`.
   */
  'git:graph': (projectId: string, limit?: number) => Promise<GitGraph>;
  /**
   * Prepare the plan for parallel work, in two halves.
   *
   * The app does the mechanical half itself, before returning: it inserts the `@contract`
   * task into every milestone that fans out, and scaffolds `CONTRACT.md`. `contractPhases`
   * names the milestones it edited (empty when there was nothing to insert).
   *
   * Only the dependency judgement is worth a model, so an AI pass that adds `@needs:`
   * annotations starts ONLY when there is judgement left to make. `runId` is that run — for
   * the UI to show its live transcript — or `null` when no session was started at all.
   *
   * Either way the plan watcher re-syncs once the file changes.
   */
  'project:alignPlan': (id: string) => Promise<{ runId: string | null; contractPhases: string[] }>;

  // --- Agent profiles (cloud as central control for projects, step 7) -------
  // A reusable run configuration a ticket can be queued against (`@shared/agent`). Unlike
  // an ordinary project, a profile has no local row — it lives on the server only — so
  // every one of these calls the cloud API directly, the same way `AssignmentPoller` does.
  // Rejects with "Not signed in…" / "Cloud sync isn’t set up…" exactly as those calls do
  // when there is no token or no server configured. `defaultProjectId` names one of the
  // projects `project:list` already returns — there is no separate project list for it,
  // now that the single-board refactor folded agent/plan/ticket projects into one kind.
  'agentProfile:list': () => Promise<AgentProfile[]>;
  /** Create a profile. */
  'agentProfile:add': (input: AddAgentProfileInput) => Promise<AgentProfile>;
  /** Edit a profile's name, model, permission mode, or default project. */
  'agentProfile:update': (id: string, patch: AgentProfilePatch) => Promise<AgentProfile>;
  /** Remove a profile. Rejects while a queued, claimed, or running assignment against it exists. */
  'agentProfile:remove': (id: string) => Promise<void>;

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
  /**
   * The task ids whose branch is being merged **right now**, so a board that mounts
   * mid-merge shows the spinner too. Live changes arrive on `task:integrating`.
   *
   * A merge is the one long job that changes nothing observable while it runs — no run,
   * no status, no transcript line — so without this the UI has no way to know it started.
   */
  'scheduler:integrating': () => Promise<string[]>;
  /**
   * Run a single task ad-hoc (independent of its project's queue).
   *
   * Resolves to the live run's id, or — for the one refusal the card itself records
   * (`CARD_RECORDS_PARK`, i.e. a usage limit) — to `{ refused: 'limit' }`: the card is
   * parked in the gate and starts by itself at the reset, so that is an outcome, not a
   * failure. The other five refusals reject with `RUN_REFUSAL_MESSAGE[refused]`, because
   * nothing will happen until a human does something about them.
   */
  'task:run': (taskId: string) => Promise<RunOutcome>;
  /**
   * Merge a finished card's branch back into its base, on the human's say-so (Phase 17).
   *
   * Integration is manual unless auto-merge is on for the card — its own answer, else its
   * project's, else the app-wide `AppSettings.autoIntegrate` (`@shared/integrate`) —
   * because merging at the moment the agent stops is merging at the moment the work has
   * been reviewed least.
   * Resolves once the merge has been STARTED; its outcome arrives as a task note, or as an
   * inbox item when it conflicts.
   *
   * That "started, not finished" is why `task:integrating` exists: the card is in the set
   * before this resolves and leaves it when the merge settles, which is what the button's
   * spinner and the card's "Merging branch…" are driven from.
   */
  'task:integrate': (taskId: string) => Promise<void>;
  /**
   * Push this card's branch to its remote and open a pull/merge request against base.
   *
   * The other half of `task:integrate`, and its alternative rather than its sequel: a card
   * whose work goes out as a PR is NOT merged locally, or the pull request would be for
   * changes base already has.
   *
   * Resolves with the PR's URL, how a human writes it (`#12` / `!12`), and whether it was
   * **already open** — pressing the button twice is ordinary, and the second press reports
   * the existing one rather than failing. Every refusal arrives as a thrown sentence naming
   * the wall it hit: no remote, no token for that forge, nothing committed on the branch.
   *
   * A row is written into the card's merge requests before this resolves, so the card shows
   * the PR immediately instead of after the next sync.
   */
  'task:createPullRequest': (
    taskId: string,
  ) => Promise<{ url: string; ref: string; existed: boolean }>;
  /**
   * Whether a project has release instructions on disk (`RELEASE.md` at its root).
   *
   * A question about the FILE SYSTEM, which the renderer cannot see, and the reason the
   * Details Panel can say "this repo has no RELEASE.md yet" instead of offering a switch
   * that would quietly do nothing. Answered fresh on every ask — the file appears the
   * moment someone writes it, and a cached "no" would outlive that.
   */
  'project:hasReleaseDoc': (projectId: string) => Promise<boolean>;
  /**
   * Create an ad-hoc task in a project (Phase 8) — no plan line required, so
   * plan-less projects are usable and you can add work on the fly. Returns the task.
   */
  'task:create': (
    projectId: string,
    input: {
      title: string;
      phase?: string;
      type?: TaskType | null;
      /**
       * The card's brief — what it is and what "done" means. Stored where every other
       * surface already reads a CARD's description from (`Task.externalDescription`,
       * which `task:setDescription` writes and the agent's prompt quotes), so a card
       * given one at creation is indistinguishable from one given it afterwards.
       * `Task.description` is deliberately NOT it: that field is a STEP's brief.
       */
      description?: string;
      /**
       * File the new card under a project — `Task.projectTagId`, the same tagging
       * `task:setProject` does. Filing, never delegation: nothing is started, and the
       * card's own `projectId` (its board) is untouched. Rejects an id that is not an
       * agent project, exactly as `task:setProject` does.
       */
      projectTagId?: string | null;
    },
  ) => Promise<Task>;
  /**
   * Create a native ticket directly on a project's board (Phase 24, wired to the Add-task
   * dialog's Board picker) — the ticket-project counterpart to `task:create`. Allocates the
   * next key under the project's `ticketPrefix` via `store.createTicket`.
   *
   * Rejects an unknown project and a plan-driven one (that board's cards come from its plan
   * file, not a manual add) with a clear reason; a blank title or a project with no ticket
   * prefix to allocate from come back as the one generic refusal `store.createTicket` already
   * gives `undefined` for. Rejects a dangling or unfileable `projectTagId`, exactly as
   * `task:create` does.
   */
  'ticket:create': (projectId: string, input: TicketInput) => Promise<Task>;
  /** Delete a task (and its history, and any steps under it). Rejects if it is running. */
  'task:delete': (taskId: string) => Promise<void>;
  /**
   * A card's steps, in execution order (Phase 11). Empty for a card that has none.
   */
  'task:subtasks': (parentTaskId: string) => Promise<Task[]>;
  /**
   * One card in full (F29.2) — the heavy text a list's card summary leaves out, read when the
   * card opens: the card, its parent when it is a step, and its own steps in execution order.
   * Null when no such card exists.
   */
  'task:get': (id: string) => Promise<TaskBundle | null>;
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
   * Rewrite the card's title. For a JIRA or GitHub card this edits the app's copy
   * only: the next sync overwrites it with the issue's own summary, the same
   * bargain `task:setDescription` strikes. Rejects a blank title. Returns the
   * updated task.
   */
  'task:setTitle': (taskId: string, title: string) => Promise<Task>;
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
   * Raise an owner decision on a card (`Task.decisionQuestion`), or withdraw it with `null`.
   * A blank question counts as `null`. While a decision is open the card is never ready,
   * Start refuses it and the plan queue skips it. Re-asking keeps the original
   * `decisionAskedAt`. Withdrawing re-asks the chain. Returns the updated task.
   */
  'task:setDecision': (taskId: string, question: string | null) => Promise<Task>;
  /**
   * Answer a card's open decision: clears the flag and files `Decision needed: <question>`
   * and `Answer: <answer>` as a LOCAL comment — never posted to the tracker — which the next
   * planning run reads like any other note. Then re-asks the chain, so a successor held only
   * by this decision releases. Rejects a blank answer and a card with no open decision.
   */
  'task:answerDecision': (
    taskId: string,
    answer: string,
  ) => Promise<{ task: Task; comment: TaskActivityEntry }>;
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
   * Move a card onto a DIFFERENT board — the sibling of `task:setProject` above, and its
   * opposite number: that one tags a card with `projectTagId` and leaves `Task.projectId`
   * (the board it actually lives on) untouched; this one moves `projectId` itself, which is
   * what changes WHERE the card lives. Under the hood this is `Store.moveTaskToBoard` — see
   * its docstring for the re-keying rule (a destination that owns tickets always allocates a
   * fresh number off its own counter; a keyless one freezes the key as it was) — with
   * `projectTagId` dragged along so the filing tag never keeps pointing at a board the card
   * has left.
   *
   * `boardId` names any real project, Personal included: every project is a valid board now,
   * with no narrower `ownsBoard` gate on top. Refused for a card mid-run, for a card resting
   * on a plan-driven board (that board's cards come from its plan file, not a manual move),
   * and for a card synced from JIRA or GitHub (its board is recomputed from its Project tag
   * on every poll, so a move made here would not survive the next sync). A no-op, not a
   * refusal, if `boardId` already names the card's own board.
   */
  'task:setBoard': (taskId: string, boardId: string) => Promise<Task>;
  /**
   * Change the model / permission mode a delegated card runs with, WITHOUT restarting
   * it (unlike `task:assignAgent`). A live run keeps what it started with — these are
   * captured on the run — so the change applies to the next one.
   */
  'task:setAgentOptions': (
    taskId: string,
    options: {
      model?: ClaudeModel | null;
      /**
       * Model this card's planning runs use, overriding the agent project's planning
       * model. `null` hands the decision back to `agentModel` and, through it, the
       * project's planning/execution models — see `resolveRunModel`.
       */
      planningModel?: ClaudeModel | null;
      mode?: PermissionMode | null;
      /**
       * Release this card after its branch merges (`@shared/release`). `null` hands the
       * decision back to the agent project's own preference, which is what an untouched
       * card does — so the switch has an off, an on, and a "whatever the project says".
       */
      autoRelease?: boolean | null;
      /**
       * Open a PR/MR for this card when its work finishes, instead of merging it here
       * (`@shared/pullRequest`). `null` hands the decision back to the agent project's own
       * preference, which is what an untouched card does.
       */
      autoCreatePr?: boolean | null;
      /**
       * Merge this card's branch as soon as its work finishes (`@shared/integrate`). `null`
       * hands the decision back to the agent project — and through it to the app-wide
       * setting — which is what an untouched card does.
       */
      autoIntegrate?: boolean | null;
    },
  ) => Promise<Task>;
  /** The task's unified activity timeline (comments + status changes + AI transcript). */
  'task:activity': (taskId: string) => Promise<TaskActivityEntry[]>;
  /** Add a human progress comment to a task; returns the created timeline entry. */
  'task:addComment': (taskId: string, body: string) => Promise<TaskActivityEntry>;
  /**
   * A human's verdict on the card's own "Visual sign-off" panel (`@shared/visualSignOff`) —
   * posts the same kind of comment `task:addComment` does (`formatSignOff`), then, when the
   * card's project has "merge on green" on, asks the forge to arm auto-merge (`approved`) or
   * withdraw it (`needs-changes`) on the card's open pull/merge request. `screens` names the
   * rows flagged by a `needs-changes` verdict; omitted (or ignored) for `approved`.
   */
  'task:visualSignOff': (
    taskId: string,
    status: SignOffStatus,
    screens?: readonly string[],
  ) => Promise<TaskActivityEntry>;
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
   * What a card's agent changed (F6): the file list of the three-dot diff from the base
   * branch's merge base to the card's worktree — uncommitted and untracked work included —
   * or to its branch when the worktree is gone. Answers `landed`, `conflicted` or
   * `no-branch` as data instead of a diff, so "nothing changed" and "this already merged"
   * never read the same. Never a git error for an expected state.
   */
  'task:diffSummary': (taskId: string) => Promise<DiffSummaryResult>;
  /**
   * One file's hunks out of the diff the human loaded as `diffId` — one file per call, so a
   * relayed answer stays bounded. `stale` when the worktree moved on since; a patch over
   * `DIFF_FILE_MAX_BYTES` comes back `tooLarge` with no hunks.
   */
  'task:diffFile': (taskId: string, diffId: string, path: string) => Promise<DiffFileResult>;
  /**
   * Both sides of one image file in the diff `diffId`, base64; a side over
   * `DIFF_IMAGE_MAX_BYTES` comes back `tooLarge` instead. `stale` as for `task:diffFile`.
   */
  'task:diffImage': (taskId: string, diffId: string, path: string) => Promise<DiffImageResult>;
  /** Every draft and sent comment on a card's review, in no particular order. */
  'review:list': (taskId: string) => Promise<ReviewComment[]>;
  /**
   * Add one review comment, anchored to a line (or range, via `start`) in `diffId`. `stale`
   * when the worktree has moved on since `diffId`, same as `task:diffFile`.
   */
  'review:add': (input: ReviewCommentInput) => Promise<ReviewAddResult>;
  /**
   * Edit a draft comment's body, its anchor, or both. Refused `sent` once the comment has
   * gone out in a review message — it is no longer a draft to edit — or `stale` when an
   * anchor move names a `diffId` the worktree has moved on since.
   */
  'review:update': (
    taskId: string,
    id: string,
    patch: ReviewCommentPatch,
  ) => Promise<ReviewUpdateResult>;
  /** Remove a draft comment. Refused `sent` once it has gone out in a review message. */
  'review:delete': (taskId: string, id: string) => Promise<ReviewDeleteResult>;
  /**
   * Batch every open draft comment on a card into one follow-up and send it down the same
   * chat path a human's own message takes — landing on the card's live step when it is
   * running an approved plan. `note` becomes the message's optional overall note. Refused
   * `nothing-to-send` once every draft has already gone out, or `landed`/`conflicted`/
   * `no-branch` when there is no diff left to put in the message's header, on top of
   * whatever `task:chat` itself can refuse with.
   */
  'review:send': (taskId: string, note?: string) => Promise<ReviewSendResult>;

  /**
   * Every review queue's cached rows (F15.9), answered synchronously, with a background
   * refresh fired beside it — `ReviewQueueService.open()`'s own contract: this never waits
   * on a forge. The fresh answer lands over `review:queues:changed` once the refresh does.
   * Each queue is capped at `REVIEW_QUEUE_MAX_ROWS`, named in `truncated` when it was.
   */
  'review:queues': () => Promise<ReviewQueuesSnapshot>;
  /**
   * The Reviews pane's own "Refresh" button: awaits a full refresh of every queue, THEN
   * answers with the snapshot — unlike `review:queues`, which never waits on one. Same cap
   * and `truncated` rule.
   */
  'review:refreshQueues': () => Promise<ReviewQueuesSnapshot>;
  /**
   * A review subject's file list (F15.10) — any of the three `ReviewSource`s the diff might
   * live in, decided by `ReviewSubjectService`. `task:diffSummary` is now this channel's
   * `task`-only special case, routed through the very same service.
   */
  'review:subjectSummary': (subjectId: string) => Promise<DiffSummaryResult>;
  /** One file's hunks out of a review subject's diff — `task:diffFile`, widened to any subject. */
  'review:subjectFile': (
    subjectId: string,
    diffId: string,
    path: string,
  ) => Promise<DiffFileResult>;
  /** Both sides of one image file in a review subject's diff — `task:diffImage`, widened. */
  'review:subjectImage': (
    subjectId: string,
    diffId: string,
    path: string,
  ) => Promise<DiffImageResult>;
  /**
   * Lines read for context expansion, from one side of a review subject's diff at `path`,
   * between `from` and `to` (both 1-based and inclusive). `stale` as for `review:subjectFile`.
   */
  'review:context': (
    subjectId: string,
    diffId: string,
    path: string,
    side: DiffSide,
    from: number,
    to: number,
  ) => Promise<DiffContextResult>;
  /** Every file a review subject has marked read, in no particular order. */
  'review:viewed': (subjectId: string) => Promise<ReviewViewedMark[]>;
  /**
   * Mark one file read on a review subject's diff — or, with `blobSha: null`, clear that
   * mark. Answers with the subject's marks after the write, like `review:viewed`, so a
   * caller never has to re-read to see its own change.
   */
  'review:setViewed': (
    subjectId: string,
    path: string,
    blobSha: string | null,
  ) => Promise<ReviewViewedMark[]>;

  /**
   * Start an AI review of a review subject (F16.11), on the human's behalf. Answers with the
   * new review's row — never its findings, which land later as AI drafts through the review
   * reads — or, when nothing was spent and no row was made, an `AiReviewRefusal` naming why
   * (`no-capability` for a `forge-api` PR, `too-large` over the caps, and so on).
   */
  'aiReview:start': (subjectId: string) => Promise<AiReview | AiReviewRefusal>;
  /** Cancel a queued, running or parked AI review. `false` when there was none to cancel. */
  'aiReview:cancel': (id: string) => Promise<boolean>;
  /** Every AI review of one review subject, in no particular order. */
  'aiReview:list': (subjectId: string) => Promise<AiReview[]>;
  /** One AI review's row — its status and cost — or `null` when there is no such review. */
  'aiReview:get': (id: string) => Promise<AiReview | null>;

  /**
   * Delegate a My Tasks card to an agent: persist the assignment (agent project +
   * optional per-assignment model/mode), record the human's instructions as a comment
   * on the task's timeline, and start the run in the agent project's repo. The card
   * stays on the Personal board; only the RUN happens in the other project. Rejects if the
   * task is already mid-run, the target isn't an agent project, or the start hit a wall the
   * human has to clear.
   *
   * A usage limit is NOT one of those: the assignment stuck and the engine parked the card
   * behind the gate, so this resolves with the delegated task (carrying `blocked-by-limit`)
   * rather than throwing. Delegating a card while the account is walled is a perfectly good
   * thing to want — the work is queued for the reset, and telling the human it failed would
   * be describing an accepted card as a rejected one.
   */
  'task:assignAgent': (taskId: string, input: AssignAgentInput) => Promise<Task>;
  /**
   * Stop the agent working on one card (leaving its branch/worktree in place for a
   * later resume). No-op if nothing is running for that task. Returns the updated task.
   */
  'task:stopAgent': (taskId: string) => Promise<Task>;
  /**
   * The exact inverse of `task:stopAgent`: put a stopped card back to work, **in the session
   * it was stopped in**. Its stopped steps are re-queued, so a card executing a plan carries
   * on at the step that was interrupted rather than starting its own session beside the
   * chain, and the agent is rejoined by `--resume` where there is a conversation to rejoin.
   *
   * Rejects with the reason it could not start (`RUN_REFUSAL_MESSAGE`) — the same walls
   * `task:run` names, minus the usage limit: that one parks the card (`CARD_RECORDS_PARK`)
   * and starts it by itself at the reset, so it resolves with the re-read task, which now
   * carries `blocked-by-limit` for the pane to explain. Returns the updated task either
   * way, so a caller that catches still has the card.
   */
  'task:resumeAgent': (taskId: string) => Promise<Task>;
  /**
   * Start a ×2/×3 variant group on a card (F10): the same delegation `task:assignAgent`
   * carries out — project/model/mode, instructions on the timeline, the attachments copied
   * across — but fanned out over `count` hidden rows instead of running the card itself.
   * Each row gets its own id, worktree, branch and session, so `RunRefusal
   * 'already-running'` keeps meaning exactly what it means today. Rejects the same way
   * `task:assignAgent` does if the card cannot run at all, or if it cannot lead a group
   * (already a variant row, a step, mid-run, or filed nowhere runnable).
   *
   * A usage limit is NOT one of those: as with `task:assignAgent`, the group sticks and
   * the engine parks whichever rows a gate is holding, so this resolves with the leader and
   * its rows (one or more carrying `blocked-by-limit`) rather than throwing.
   */
  'task:startVariants': (
    leaderId: string,
    count: VariantCount,
    input: AssignAgentInput,
  ) => Promise<{ leader: Task; rows: Task[] }>;
  /**
   * The compare view's rows for one leader's variant group (F10.4): each live row's
   * status, total cost, diff stat and a one-line gist of its last result, sorted A, B, C
   * (unlabelled last). Read-only, so a browser tab may call it directly. Rejects
   * `'Task not found.'` for an unknown leader; `[]` for a leader with no live rows.
   */
  'variants:summary': (leaderId: string) => Promise<VariantSummaryRow[]>;
  /**
   * Keep one variant and discard the rest (F10.6): stop the OTHER live rows, remove their
   * worktrees, archive them `'variant-discarded'`, and set `pickedVariantId` so every later
   * "where is this card's work" question — merge, PR, auto-release, a step's chain — resolves
   * through the picked row from here on. The picked row itself is left running if it still
   * is; only the losers are touched.
   *
   * Re-picking the SAME id is a no-op: resolves with the leader unchanged, writes no new
   * timeline note. A DIFFERENT id once already picked rejects with
   * `VARIANT_PICK_REFUSAL_MESSAGE['already-merged' | 'already-picked']`, depending on
   * whether the pick has landed; naming an id that is not a live row of this leader (or an
   * unknown/archived leader) rejects with the sibling messages for `'not-a-variant'` /
   * `'unknown-task'`. See `@shared/variants`'s `planVariantPick`.
   */
  'variants:pick': (leaderId: string, variantId: string) => Promise<Task>;
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
  /**
   * Ask a card's agent to plan the NEXT round of steps (Phase 18). Runs one turn in
   * `plan` mode — whatever mode the card is otherwise assigned — so the agent finishes
   * with `ExitPlanMode` and the plan reaches the inbox for approval instead of being
   * written as prose into the chat, where nothing can turn it into steps.
   *
   * `note` is the human's brief for what the round should cover. Refusals come back as
   * data (`{ status: 'refused', reason }`), same as `task:chat`, so the panel can explain
   * why the button did nothing.
   *
   * `opts.replaceRound` (Phase 20) re-plans a FUTURE phase in place instead of appending a
   * new one: the named round's steps are what the agent is told to replace, and approving
   * the result swaps them out — unless the phase started in the meantime, in which case it
   * lands as a new round instead (see `ChatRefusal['phase-started']`).
   */
  'task:replan': (
    taskId: string,
    note?: string,
    opts?: { replaceRound?: number },
  ) => Promise<ChatSendResult>;

  /** Snapshot of everything currently waiting on a human (seed the inbox on load). */
  'attention:list': () => Promise<AttentionItem[]>;
  /**
   * Answer one inbox item. For a `permission` item this releases (or vetoes) the
   * blocked tool; for a `question` it pushes the reply into the session. Either
   * way the item clears and its task returns to `running`.
   */
  'attention:answer': (itemId: string, answer: AttentionAnswer) => Promise<void>;
  /**
   * "Make this a decision on the card": turn a `question` item a PLANNING run raised
   * (`AttentionItem.duringPlanning`) into the card's owner decision — the prompt and its
   * options become `Task.decisionQuestion` — resolve the item, and stop the planning run so
   * the card returns to its resting status. Rejects with a plain sentence for any other item.
   * Resolves to the updated card.
   */
  'attention:toDecision': (itemId: string) => Promise<Task>;
  /**
   * Grant a parked gate's command permission to run on THIS desktop (F8.8) — the only path
   * that may add a hash to `AppSettings.trustedGateCommands`. Separate from
   * `attention:answer` (rather than one more `AttentionAnswer` decision carried over it)
   * because trust is a fact about the machine running the command, and this channel is
   * `host-only` for exactly that reason: a browser tab relaying `GATE_TRUST_ACTION.trust`
   * through `attention:answer` is refused and re-parks the same ask instead.
   */
  'gate:trust': (itemId: string) => Promise<void>;
  /**
   * Drop exactly ONE inbox item, without answering it — the inbox's own per-item Dismiss,
   * as opposed to `task:dismissAttention` which sweeps a whole card and its steps. Same two
   * exceptions as the sweep: a held tool is released as a deny rather than abandoned, and a
   * `merge-conflict` item is refused outright since its answer is what finishes the rebase.
   * Rejects (rather than silently no-op'ing) when the item is unknown or refused, so the UI
   * can say why the button did nothing.
   */
  'attention:dismiss': (itemId: string) => Promise<void>;

  /**
   * **Hush a card that is shouting.** Everything the inbox holds for it and its steps is
   * dropped, its ticket comments are marked read and its merge requests are marked read
   * and seen — one call, because "stop telling me about this" is one decision and a human
   * should not have to hunt down each of the five things that could be saying it.
   *
   * Closing a card does this by itself (`task:setStatus` / `task:move` to Done); this is
   * the way to do it for a card that is still OPEN — you have read the comment, you know
   * about the pipeline, and you are getting to it.
   *
   * Not the same as answering. An agent still parked on a question is told the human
   * dismissed it and to stop rather than being left holding the tool; a **merge conflict**
   * is deliberately not dismissable, since its answer is what finishes the rebase.
   *
   * Returns the task, whose read markers may have moved. The inbox and the merge-request
   * list announce themselves on `attention:resolved` / `mergeRequests:changed`.
   */
  'task:dismissAttention': (taskId: string) => Promise<Task>;

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
   * The active sign-in gate (`@shared/auth`), or `null` when the sign-in is believed
   * good — seeds the banner and the status bar's dot on mount. Live changes arrive on
   * the `auth:changed` event.
   */
  'auth:current': () => Promise<AuthState | null>;

  /**
   * Open an interactive `claude` session so the user can sign in. There is no headless
   * form of that flow — it wants a browser and a terminal — so the app's whole job here
   * is to put the right window in front of the user. Resolves with `false` when it could
   * not open one (a remote exec host, a machine with no terminal), which is the banner's
   * cue to show the command instead of pretending the button worked.
   */
  'auth:signIn': () => Promise<boolean>;

  /**
   * The user says they have signed in: lift the gate and resume everything it held.
   * Nothing is verified first — if the credential is still dead the first resumed run
   * says so in about 150ms and the gate goes straight back up.
   */
  'auth:signedIn': () => Promise<void>;

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
  /**
   * How much of each metered window has been spent — the current session (the rolling
   * 5 hours) and the current week — against the budgets in Settings. Two SUMs over
   * `token_usage`, not the rows, because both the status bar and the Performance screen
   * poll this. Live changes arrive via the same `usage:sample` event.
   */
  'usage:quotas': () => Promise<UsageQuotas>;
  /**
   * Session-by-session history of how fast the account burns through its rolling
   * 5-hour token budget: one entry per reconstructed past session (see `SessionStat`),
   * each with how long it took to exhaust the budget measured two ways — processing
   * time alone and full wall-clock time. Behind the Performance screen's two "time to
   * exhaust a session" charts. Live changes arrive via the same `usage:sample` event.
   */
  'usage:sessionStats': () => Promise<SessionStat[]>;
  /**
   * The zero-filled, one-point-per-local-day series behind the Performance screen's trend
   * chart: `opts.days` local days ending today, bucketed in the caller's own timezone
   * (`opts.tzOffsetMinutes`) — a server process has no timezone of its own to assume.
   */
  'usage:daily': (opts: UsageDailyOptions) => Promise<DailyUsagePoint[]>;

  /**
   * A keyset page of the cross-board activity log (F2 dashboard): everything that
   * happened, newest first. `query.cursor` resumes after an earlier page's last row; a
   * cursor that has gone stale (the log moved past it, or it was never one this file
   * produced) throws a user-facing error rather than silently restarting at page 1.
   */
  'activity:list': (query: ActivityQuery) => Promise<ActivityPage>;
  /**
   * The activity dashboard's headline tile for one of the three fixed trailing windows
   * (24h/7d/30d): how many runs are live right now, how many need a human, and the
   * outcome counts over the window.
   */
  'activity:overview': (period: ActivityPeriod) => Promise<ActivityOverview>;
  /**
   * The activity tab's unread baseline, persisted by the host (F2.13: desktop `app_state`;
   * F2.14: the browser's own localStorage, never through this channel). Null on a first-ever
   * visit — no baseline, the same reading the feed's own divider gives.
   */
  'activity:getLastSeen': () => Promise<ActivityCursor | null>;
  /**
   * Persists a newly-reported cursor and returns what actually got stored — `max(stored,
   * cursor)` by `(at, id)` (`laterActivityCursor`), never the raw value the caller just
   * reported. A caller that narrows the feed can report an older newest row than an earlier,
   * wider view already saw; the forward-only rule is what keeps that from un-reading anything.
   */
  'activity:setLastSeen': (cursor: ActivityCursor) => Promise<ActivityCursor>;

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
  /**
   * Fetch GitLab's merge requests and reconcile them onto the board. Returns the full
   * list — every provider's, since one board list holds them all.
   *
   * Stays in the `gitlab:` namespace on purpose: this is a *fetch* against one forge's
   * API, and each forge gets its own trigger. Only the read-and-annotate channels below
   * are provider-neutral, because they talk to the board's own table.
   */
  'gitlab:sync': () => Promise<MergeRequest[]>;

  // --- GitHub. The same four channels again, one forge over. -----------------
  //
  // `JiraConfigStatus` and `JiraTestResult` are reused verbatim, exactly as the GitLab
  // channels above do. The names have aged badly, but the shapes have not: "is it on, is
  // there a token, can this machine encrypt one" and "did the credential work, and who
  // does it say you are" are the same two questions for every integration, and a third
  // pair of identical interfaces would be three places to change the next time either
  // question grows a field.
  /** Whether GitHub is enabled, has a stored token, and can encrypt one. */
  'github:getConfigStatus': () => Promise<JiraConfigStatus>;
  /** Store the GitHub personal access token, encrypted via the OS secure store. */
  'github:setCredentials': (token: string) => Promise<{ ok: boolean; message: string }>;
  /** Remove the stored GitHub token. */
  'github:clearCredentials': () => Promise<void>;
  /** Verify base URL + token by calling `/user`; returns the login. */
  'github:testConnection': () => Promise<JiraTestResult>;
  /**
   * Fetch GitHub's pull requests and reconcile them onto the board. Returns the full list —
   * every provider's, exactly as `gitlab:sync` does, since one board list holds them all.
   */
  'github:sync': () => Promise<MergeRequest[]>;
  /**
   * The linked GitHub issue's comments as timeline entries (empty for non-GitHub tasks) —
   * `jira:fetchComments`, one tracker over, and the same read: the app fetches the thread
   * itself and the pane merges it in. Also keeps the unread marker honest, as that one does.
   */
  'github:fetchComments': (taskId: string) => Promise<TaskActivityEntry[]>;
  /**
   * Post a comment to the linked GitHub issue; also marks the task's comments as read.
   *
   * The draft shape is `JiraCommentDraft` verbatim — the same reuse, for the same reason, as
   * `JiraConfigStatus` above. Two of its three fields mean exactly what they do there:
   * `mentions` are ranges into `text` (never an inline syntax), which main resolves to the
   * `@login` GitHub itself understands, since a comment body here is plain **Markdown** and
   * needs no ADF built for it.
   *
   * `attachmentPaths` is the one field with no GitHub behind it and is **ignored**: uploading
   * a file to an issue is a browser-only route on github.com (there is no REST endpoint for
   * it), so the composer offers no attach button on a GitHub card. Silently dropping a path
   * would post the words without the file — see the handler, which refuses instead.
   */
  'github:addComment': (taskId: string, body: JiraCommentDraft) => Promise<void>;
  /**
   * People matching a partial name, for the @mention picker — scoped to the issue's own
   * repository, which is the only place GitHub can answer the question from. `id` carries the
   * **login**, because `@login` is what a Markdown body resolves; `displayName` carries it too,
   * so what the composer types into the text is already what GitHub will link.
   *
   * Fails soft to `[]` like its JIRA counterpart: an empty picker still lets you type a name.
   */
  'github:searchUsers': (taskId: string, query: string) => Promise<JiraUserOption[]>;
  /**
   * Mark a GitHub task's comments as read (clears the unread border); returns the task.
   *
   * An alias of `jira:markRead`, which was never tracker-specific (it touches nothing but our
   * own two markers). It exists so a GitHub card's pane does not have to invoke a channel
   * named for the other tracker, and both names go through one implementation.
   */
  'github:markRead': (taskId: string) => Promise<Task>;

  // --- Merge requests, whichever forge they came from -----------------------
  /**
   * Every stored merge request, for the whole board in one call — GitLab's and GitHub's
   * together, because `MergeRequest` carries its `provider` and every consumer (the card
   * rows, `mergeBlockers`, `chainNeedsAttention`, `sortCards`) reads them the same way.
   * Two lists would mean two of each of those.
   *
   * Deliberately NOT hung off `Task`: `issueToTask` rebuilds the whole task literal on
   * every JIRA sync and `upsertJiraTask` writes the whole row, so an MR array living
   * there would be clobbered every poll. The board holds the array and derives its own
   * `Map<taskId, MergeRequest[]>`, exactly as it does for `board:tasks`.
   */
  'mr:mergeRequests': () => Promise<MergeRequest[]>;
  /**
   * Link an MR/PR a human opened themselves — pasted as a URL — to a card, rather than one
   * this app pushed the branch and opened itself (`task:createPullRequest`). Parses the URL
   * into forge coordinates, fetches it in full and reconciles it exactly as the corresponding
   * sync would, then stamps `taskId`/`openedForTaskId` onto the target card: the human
   * pointing at a URL beats whatever key-matching a sync would otherwise have guessed.
   *
   * Throws a sentence naming the wall: not a recognisable MR/PR URL, that forge not enabled,
   * no token saved, or the forge itself could not find it.
   */
  'mr:link': (taskId: string, url: string) => Promise<MergeRequest>;

  // --- Cloud personal access token — the same four-channel shape JIRA/GitLab/GitHub use. ---
  /** Whether a token is stored, and whether the OS secure store can encrypt one. */
  'cloud:getConfigStatus': () => Promise<CloudConfigStatus>;
  /**
   * Store the pasted personal access token, encrypted via the OS secure store — created on
   * the web app's Personal access tokens page, not minted here. Rejects (ok:false) if the OS
   * secure store is unavailable, or the paste is not `tmpat_`-shaped; never persists one in
   * plaintext.
   */
  'cloud:setCredentials': (token: string) => Promise<{ ok: boolean; message: string }>;
  /** Remove the stored token. */
  'cloud:clearCredentials': () => Promise<void>;
  /**
   * Walk the cloud mirror's chain — address, token, then an authenticated board read — and
   * report the first rung that fails. `cloudPoller` is silent by design (a failed tick is
   * counted and retried, never surfaced), so without this every misconfiguration looks the
   * same from the app: an empty board and no explanation.
   */
  'cloud:testConnection': () => Promise<JiraTestResult>;

  // --- Sync freshness (the status bar's countdown rings) --------------------
  /**
   * How stale the board's mirror is and when the next refresh is due — one shared clock,
   * with a row per integration underneath it for the things that still differ (which are
   * switched on, and which one's last attempt failed).
   */
  'sync:state': () => Promise<SyncState>;
  /**
   * Rename a merge request **in this app only** — pass null or blank to go back to the
   * upstream title. Never written back to the forge, and preserved across syncs.
   */
  'mr:setMergeRequestName': (mrId: string, name: string | null) => Promise<MergeRequest[]>;
  /** Mark an MR's discussion read (clears the comment half of its attention). */
  'mr:markRead': (mrId: string) => Promise<MergeRequest[]>;
  /** Acknowledge an MR's pipeline/approval events (the other half, tracked separately). */
  'mr:markEventsSeen': (mrId: string) => Promise<MergeRequest[]>;
  /**
   * Ask the forge to rebase this MR's source branch onto its target — GitLab's own rebase, or
   * GitHub's "update branch". Only meaningful while `mergeBlockers` reports `need-rebase`; the
   * forge queues the work rather than doing it inline, so the returned list reflects whatever
   * the immediate re-sync could see, not necessarily the finished rebase.
   */
  'mr:rebase': (mrId: string) => Promise<MergeRequest[]>;
  /**
   * Merge it — GitLab's own merge endpoint, or GitHub's. Only meaningful while
   * `mrReadyToMerge` says yes; the server re-checks that itself regardless, since the UI's
   * own read of readiness is advisory and may be stale by the time the click lands.
   *
   * `message`, when given and not blank, becomes the merge commit's message — the dialog's
   * edited copy of what `mr:mergeProposal` read. A missing or blank message sends none, which
   * is exactly today's call: the forge applies its own default, same as before this existed.
   */
  'mr:merge': (mrId: string, options?: { message?: string }) => Promise<MergeRequest[]>;
  /**
   * The commit message the forge itself would propose for merging this MR/PR, for the merge
   * dialog to prefill and let a human edit before pressing merge. See {@link MergeProposal}.
   *
   * Read-only and side-effect-free — unlike `mr:merge` it never re-checks `mrReadyToMerge`,
   * since showing a proposal is not the same claim as being ready to act on it.
   */
  'mr:mergeProposal': (mrId: string) => Promise<MergeProposal>;
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
  /**
   * The cards on a board. `scope` names which one: omitted (or `'all'`, the default) is
   * every board's cards unioned together — Personal plus every other project with no
   * plan file — and any other value is one board's own project id, `PERSONAL_PROJECT_ID`
   * included.
   *
   * Card summaries (F29.2), not full rows: a list draws none of the heavy fields, and
   * `task:get` reads them when a card opens.
   */
  'board:tasks': (scope?: string) => Promise<TaskSummary[]>;
  /**
   * The cards that have been taken OFF a board and not destroyed — most recently removed
   * first. The complement of `board:tasks`, same `scope` rule, and the list "Removed cards"
   * is drawn from.
   *
   * Every one still has its timeline, its files, its arrows and its transcript; `archivedAt`
   * says when it left and `archivedReason` says which question's answer took it. They are kept
   * for `ARCHIVE_RETENTION_DAYS` and then destroyed by the boot sweep.
   */
  'board:archived': (scope?: string) => Promise<Task[]>;
  /** The boards `board:tasks`/`board:archived`'s `scope` may select. See {@link BoardScope}. */
  'board:scopes': () => Promise<BoardScope[]>;

  /**
   * Edit a native ticket's own fields (type, epic, milestone, labels, estimate, dates,
   * assignee, reporter). Title, description and priority go through the channels every other
   * card already uses (`task:setDescription`, `task:setPriority`); this one is the twelve
   * ticket-only fields `TicketPatch` names. Same guards as `ticket:create`.
   */
  'ticket:update': (taskId: string, patch: TicketPatch) => Promise<Task>;

  /**
   * Everyone the app knows about, oldest first — app-wide, not per project (a person works
   * across repos, and "assigned to me" would otherwise have several answers).
   */
  'person:list': () => Promise<Person[]>;
  /** Add a person. Rejects on a blank name. */
  'person:add': (input: PersonInput) => Promise<Person>;
  /** Edit one. Null for an unknown id. Setting `isMe` clears it from whoever had it before. */
  'person:update': (id: string, patch: PersonPatch) => Promise<Person | null>;
  /**
   * Forget a person; every ticket that had them as assignee or reporter is nulled, not
   * cascaded away.
   */
  'person:remove': (id: string) => Promise<void>;
  /**
   * Mark this person as **you** — the shorthand for `person:update(id, { isMe: true })`. At
   * most one person may carry the flag; setting it here clears it from whoever had it, in the
   * same write. Null for an unknown id.
   */
  'person:setMe': (id: string) => Promise<Person | null>;

  /**
   * A project's label registry — what gives a chip its colour and the filter dropdown its
   * list. `projectId` omitted reads every ticket project's labels at once, the shape
   * `pollChannel` needs since it invokes with no arguments.
   */
  'label:list': (projectId?: string) => Promise<TicketLabel[]>;
  /**
   * Create or edit a label, one channel for both — matching `settings:save`, not an add/update
   * pair. `id` present edits that label (a rename rewrites the name on every ticket wearing
   * it); omitted creates one. Rejects on a blank name or a name already taken in the project.
   */
  'label:save': (
    projectId: string,
    input: TicketLabelInput & { id?: string },
  ) => Promise<TicketLabel>;
  /** Delete a label and strip its name from every ticket wearing it. */
  'label:remove': (id: string) => Promise<void>;

  /**
   * A project's milestones, earliest due first. Same optional `projectId` as `label:list`, and
   * for the same reason.
   */
  'milestone:list': (projectId?: string) => Promise<Milestone[]>;
  /**
   * Create or edit a milestone, one channel for both — see `label:save`. Rejects on a blank
   * name.
   */
  'milestone:save': (
    projectId: string,
    input: MilestoneInput & { id?: string },
  ) => Promise<Milestone>;
  /** Delete a milestone; every ticket planned for it is nulled, not cascaded away. */
  'milestone:remove': (id: string) => Promise<void>;

  /**
   * Archive a milestone, epic or ticket project. Refusals come back as data (`ArchiveResult`)
   * — the same shape `ticketLink:add`'s `TicketLinkResult` uses — rather than a rejected
   * promise, since "that's already archived" is something to tell the human, not an error.
   * `choice` says what to do with the target's still-open tickets; omitted, they are left
   * where they are. A successful change rides `milestone:changed` and `tasks:changed`
   * for the renderer to patch without a full refetch; archiving a project also needs a
   * `project:list` re-read, since the project row itself changed.
   */
  'archive:apply': (target: ArchiveTarget, choice?: OpenTicketsChoice) => Promise<ArchiveResult>;
  /**
   * Restore a milestone, epic or ticket project. Refusals come back as data (`ArchiveResult`)
   * — the same shape `ticketLink:add`'s `TicketLinkResult` uses — rather than a rejected
   * promise, since "that's not archived" is something to tell the human, not an error. A
   * successful change rides `milestone:changed` and `tasks:changed` for the renderer to
   * patch without a full refetch; restoring a project also needs a `project:list` re-read,
   * since the project row itself changed.
   */
  'archive:restore': (target: ArchiveTarget) => Promise<ArchiveResult>;
  /**
   * A project's archived rows for its "Archived" view, grouped by kind. Same optional
   * `projectId` as `label:list` and `milestone:list`, and for the same reason.
   */
  'archive:list': (projectId?: string) => Promise<ArchivedListing>;

  /** Every documented ticket relationship, oldest first — small enough to hand over whole. */
  'ticketLink:list': () => Promise<TicketLink[]>;
  /**
   * Document a relationship between two tickets. Refusals come back as data
   * (`TicketLinkResult`) — the same shape `chain:link`'s `LinkResult` uses — rather than a
   * rejected promise, since "those two already relate that way" is something to tell the
   * human, not an error.
   */
  'ticketLink:add': (
    fromTaskId: string,
    toTaskId: string,
    type: TicketLinkType,
  ) => Promise<TicketLinkResult>;
  /** Erase one link by id; no-op if it is already gone. */
  'ticketLink:remove': (id: string) => Promise<void>;

  /**
   * A project's saved Graph-view node positions — `GraphPane`'s own layout. Empty until a
   * node has been dragged; the caller grid-places whichever tickets are missing from it.
   */
  'ticketGraph:getLayout': (projectId: string) => Promise<TicketGraphPosition[]>;
  /**
   * Persist node positions for a project, one row per ticket. `GraphPane` debounces this on
   * node drag rather than calling it per pixel, and sends the whole visible layout each
   * time — there is no per-node granularity on this channel.
   */
  'ticketGraph:saveLayout': (projectId: string, positions: TicketGraphPosition[]) => Promise<void>;

  // --- Automations (F1): a run that starts because a clock said so, or a tracker did,
  // instead of a human pressing something. See `@shared/automation` for the model. ---------
  /** Every automation, in one call — small enough to hand over whole, like `chain:links`. */
  'automation:list': () => Promise<Automation[]>;
  /**
   * Create or edit an automation, one channel for both — but unlike `label:save` /
   * `milestone:save`, `id` is always present (the editor's draft needs one before the
   * first save). The handler decides create vs. edit by looking `id` up in the store:
   * found edits it, not found creates one (keeping `id` if non-empty, otherwise minting
   * one). Rejects with `validateAutomation`'s messages joined, since the editor calls
   * that same validator on every keystroke and this is its one authoritative recheck.
   */
  'automation:save': (automation: Automation) => Promise<Automation>;
  /** Delete an automation. Its past runs are deleted with it — `automation:runs` has nothing left to show. */
  'automation:delete': (id: string) => Promise<void>;
  /**
   * Flip an automation on or off without opening its editor — the board's own toggle.
   * Disabling never touches a firing already in flight; it only stops the next one.
   */
  'automation:setEnabled': (id: string, enabled: boolean) => Promise<Automation>;
  /**
   * Fire an automation right now, independent of its trigger — the editor's "Run now". Goes
   * through the same firing path a schedule tick or a tracker diff would, so its result is a
   * real `AutomationRun`, not a preview.
   */
  'automation:runNow': (id: string) => Promise<AutomationRun>;
  /**
   * One automation's run history, newest first, or every automation's when `automationId` is
   * null — the log behind the editor's "recent runs" list. `limit` caps how many come back.
   */
  'automation:runs': (automationId: string | null, limit: number) => Promise<AutomationRun[]>;

  // --- Skills (F7): the library a card or step carries into every turn of a run, plus a
  // read-only view of a project's own `.claude/skills`. See `@shared/skills` for the model. -
  /** Every library skill, name-sorted — small enough to hand over whole, like `chain:links`. */
  'skill:list': () => Promise<Skill[]>;
  /** One library skill by id, or `null` if it is gone — a picker resolving `Task.skillRefs`. */
  'skill:get': (id: string) => Promise<Skill | null>;
  /**
   * Create or edit a library skill, one channel for both: the handler mints `id` when the
   * draft has none, and keeps an existing row's `createdAt`. A name clash with a different
   * skill comes back as `{ ok: false, reason: 'name-taken' }` rather than a rejection, so the
   * editor can offer "replace" next to the field that caused it.
   */
  'skill:save': (input: SkillDraft) => Promise<SkillSaveResult>;
  /** Delete a library skill by id. A card's `skillRefs` are deliberately left dangling — see
   *  `Task.skillRefs` — so this never cascades into every task that named it. */
  'skill:delete': (id: string) => Promise<boolean>;
  /**
   * Import one or more `SKILL.md`-shaped files — a file picker, a folder, or pasted text,
   * per `request.source`. One result per candidate, so a bad file in a folder import never
   * costs the rest; `null` means the human cancelled the native dialog (never happens for a
   * `'text'` import, which opens none). Host-only: it opens a native file/folder picker.
   */
  'skill:import': (request: SkillImportRequest) => Promise<SkillImportResult[] | null>;
  /**
   * Write the named library skills to a folder the human picks, one `SKILL.md` per skill
   * under `<dir>/<name>/` — the CLI's own layout, so committing that folder under a project's
   * `.claude/skills` makes each one a repo skill too. `null` means the human cancelled the
   * folder picker. Host-only: it opens a native folder picker.
   */
  'skill:export': (ids: string[]) => Promise<SkillExportResult | null>;
  /**
   * A project's repo skills — whatever already lives under its `.claude/skills` in the
   * worktree. `[]` for an unknown project or one with no repo (nothing to read).
   */
  'skill:listRepo': (projectId: string) => Promise<RepoSkillSummary[]>;
  /**
   * One repo skill's full body, for F7.8's "Copy to library" — `null` for an unknown
   * project, a project with no repo, or a skill that is not actually there.
   */
  'skill:getRepo': (projectId: string, name: string) => Promise<RepoSkillDetail | null>;
  /**
   * Replace a task's own `skillRefs` wholesale — the assign dialog's and the step row's
   * write. Rejects with "Task not found." for an unknown id, like `task:setDescription`.
   */
  'task:setSkillRefs': (taskId: string, refs: string[]) => Promise<Task>;

  // --- Workflows (F8): a reusable, ordered recipe of steps a card can run, as data rather
  // than a one-off prompt. See `@shared/workflow` for the model and `workflow:apply`'s
  // refusals. ------------------------------------------------------------------------------
  /** Every workflow, name-sorted — small enough to hand over whole, like `skill:list`. */
  'workflow:list': () => Promise<WorkflowDoc[]>;
  /** One workflow by id, or `null` if it is gone. */
  'workflow:get': (id: string) => Promise<WorkflowDoc | null>;
  /**
   * Create or edit a workflow, one channel for both: the handler mints `id` when the draft
   * has none, same contract as `skill:save`. Rejects nothing — an invalid document comes
   * back as `{ ok: false, reason: 'invalid', issues }` from `validateWorkflow`, so an editor
   * can show every issue at once rather than catching a rejection.
   */
  'workflow:save': (draft: WorkflowDraft) => Promise<WorkflowSaveResult>;
  /** Delete a workflow by id. A card's `workflowId` is deliberately left in place — deleting
   *  the workflow never touches a card already applied from it. */
  'workflow:delete': (id: string) => Promise<boolean>;
  /**
   * Import one workflow document — a file the human picks, or pasted/parsed JSON, per
   * `request.source`. Always saves under a fresh id, so an import never overwrites an
   * existing workflow. `null` means the human cancelled the native dialog (never happens for
   * a `'text'` import, which opens none). Host-only: it opens a native file picker.
   */
  'workflow:import': (request: WorkflowImportRequest) => Promise<WorkflowImportResult | null>;
  /**
   * Write one workflow to a file the human picks, defaulted to `workflowFileName(doc.name)`.
   * `null` means the human cancelled the native dialog, or unknown id. Host-only: it opens a
   * native save-file picker.
   */
  'workflow:export': (id: string) => Promise<WorkflowExportResult | null>;
  /**
   * Turn a workflow into a fresh round of the card's own steps — the assign dialog's and the
   * agent panel's "Apply workflow". Never starts a run; Start already honours pending steps.
   * A value, not a throw, for every refusal `WorkflowApplyRefusal` names — the UI turns each
   * into a specific sentence, the same posture `ChatRefusal` takes for a chat send. Still
   * rejects with "Task not found." for an unknown id, and with "Stop the task before applying
   * a workflow." for a card an agent is actively working on, the same two cases every other
   * `task:*` write refuses by throwing rather than as a typed value.
   */
  'workflow:apply': (taskId: string, workflowId: string) => Promise<WorkflowApplyResult>;

  /**
   * Put a removed card back on the board, with the same id and everything hanging off it.
   * Returns the fresh board, so the caller does not have to ask for it again.
   *
   * Rejects for an unknown id, and for a card that was never off the board — a Restore that
   * silently did nothing would be indistinguishable from one that worked.
   */
  'task:restore': (taskId: string) => Promise<Task[]>;

  // --- The chain of execution (see `@shared/taskChain`) ---------------------
  /**
   * Every link on the board, in one call — the arrows, not the cards.
   *
   * Held as its own list for the same reason `mr:mergeRequests` is: the board derives
   * whatever per-card index it needs from it, and a JIRA sync (which rewrites whole task
   * rows every poll) cannot clobber something that does not live on `Task`.
   */
  'chain:links': () => Promise<TaskLink[]>;
  /**
   * Draw an arrow: `toTaskId` runs after `fromTaskId`. `gate` defaults to the strict
   * `after-merge`. Refusals (self, step, duplicate, cycle) come back as data — the
   * renderer's own `canLink` is for live feedback while dragging, this is the one that
   * decides. Returns the full link list on success.
   */
  'chain:link': (fromTaskId: string, toTaskId: string, gate?: LinkGate) => Promise<LinkResult>;
  /** Erase one arrow by id; returns the full list. */
  'chain:unlink': (linkId: string) => Promise<TaskLink[]>;
  /** Change one arrow's gate without redrawing it; returns the full list. */
  'chain:setGate': (linkId: string, gate: LinkGate) => Promise<TaskLink[]>;
  /**
   * Start a card now, despite a predecessor that has not finished — the human override.
   *
   * Some chains only ever wanted the ordering as a reminder, and for those, refusing to
   * start is an obstacle rather than a safeguard. The link is NOT removed: the ordering is
   * still recorded, this run simply went ahead of it. Resolves to a sentence saying why
   * nothing started, or null once a run is under way.
   */
  'chain:releaseNow': (taskId: string) => Promise<string | null>;
  /**
   * Release the cards an `after-merge` arrow out of a Done card is holding, by marking that
   * card landed without a merge — for a card moved to Done by hand, whose branch never merged
   * through the app (or which never had one). Files a note on its timeline and starts every
   * successor that is now ready. Resolves to the refusal sentence when nothing was released
   * (the card is missing, already landed, or not Done), or null once it was.
   */
  'chain:releaseLanded': (taskId: string) => Promise<string | null>;
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
   *
   * `adoptTaskId` names a card that already exists and should BECOME this issue's card,
   * rather than a second one appearing beside it. That is how the Add-task dialog offers
   * a ticket alongside everything else it asks for: the card is written locally first
   * (with its project, its type and its description) and the ticket is linked onto it, so
   * JIRA being unreachable costs you the ticket and not the card you just typed.
   */
  'jira:createTask': (input: {
    projectKey: string;
    issueTypeId: string;
    summary: string;
    description?: string;
    adoptTaskId?: string;
  }) => Promise<Task>;
  /** Mark a JIRA task's comments as read (clears the unread border); returns the task. */
  'jira:markRead': (taskId: string) => Promise<Task>;

  // --- Attachments (see `@shared/attachments`) ------------------------------
  /**
   * Every attachment on the board, in one call — the same shape as `chain:links`, and for
   * the same reason it gives: a JIRA sync rewrites whole task rows on every poll, so
   * anything hung off `Task` gets clobbered. The board indexes this by `taskId` itself.
   */
  'attachment:list': () => Promise<TaskAttachment[]>;
  /**
   * Open the OS file picker and return the chosen absolute paths — the exact shape and
   * the exact reason as `jira:pickAttachments`: the renderer has no filesystem access and
   * no business having any, so the only paths it ever holds are ones main just handed it,
   * on their way straight back to main.
   */
  'attachment:pick': () => Promise<string[]>;
  /**
   * Copy those files under `userData` and hang them off a task. **Paths, never bytes** —
   * an attachment can be a 30 MB video, and shipping it through the structured clone
   * would copy it twice through memory to reach a process that could simply read it.
   *
   * A copy rather than a reference, because the file the human picked can be moved,
   * renamed or deleted the minute after they picked it. Returns the whole list.
   */
  'attachment:add': (taskId: string, paths: string[]) => Promise<TaskAttachment[]>;
  /**
   * The same thing for a caller with no filesystem: attach files a browser already parked in
   * the cloud (`POST /v1/uploads`), named by their ticket ids.
   *
   * Its own channel rather than a second shape for `attachment:add`, because the two differ
   * in the one thing that matters about that handler — where the bytes come from. A path is
   * a fact about the machine the engine runs on and is trusted as such; an upload is bytes
   * and a `fileName` that arrived over the network from another machine, and the desktop
   * fetches them itself rather than being handed anything it must not have been handed.
   *
   * Relayed, and it is the first channel that is interesting BECAUSE it is relayed: a
   * browser is the only caller that can have an upload id at all (`attachment:pick` opens a
   * dialog on the desktop, which is why that one is host-only). Returns the whole list, like
   * every other `attachment:*` write, and reports partial failure the same way
   * `attachment:add` does — what landed is pushed, then it throws naming what did not.
   */
  'attachment:addUploaded': (
    taskId: string,
    uploads: UploadedAttachment[],
  ) => Promise<TaskAttachment[]>;
  /**
   * Write clipboard bytes to a temp file on THIS machine's disk and hand back where they
   * landed — nothing is read from a task, nothing is written to the database, and the
   * returned paths are not yet attachments. The caller (a description editor, the Add-task
   * dialog) turns them into real ones afterward through `attachment:add`, the same way a
   * picked file is: this channel only gets pasted bytes onto disk so that path can start.
   *
   * Its own channel rather than a bytes shape on `attachment:add`, for the reason
   * `attachment:addUploaded` already gives for itself: the two differ in the one thing that
   * matters about the handler — where the bytes come from — and that is the whole of what it
   * has to be careful about. Here they come from the renderer's own clipboard read, over a
   * structured clone bounded by `MAX_PASTE_BYTES`.
   *
   * Host-only (`'host-path'`): what comes back is a path on the desktop's own disk, which
   * means nothing in a browser. A browser pasting an image has its own route already —
   * `attachFiles` → `POST /v1/uploads` → `attachment:addUploaded` — chosen precisely so
   * pasted bytes never ride through the relay's `commands` audit table; relaying this
   * channel instead would push them through it after all.
   */
  'attachment:stagePasted': (files: PastedAttachment[]) => Promise<string[]>;
  /** Drop one attachment — the row and the bytes. Returns the whole list. */
  'attachment:remove': (id: string) => Promise<TaskAttachment[]>;
  /**
   * Open one in whatever the OS uses for it. By id, because the renderer never learns a
   * path; resolves to the OS's complaint, or null when it opened.
   */
  'attachment:open': (id: string) => Promise<string | null>;

  /** Frameless-window controls, driven by the renderer's custom title bar. */
  'window:minimize': () => Promise<void>;
  /** Toggle maximize/restore. */
  'window:toggleMaximize': () => Promise<void>;
  /** Close the window (quits the app). */
  'window:close': () => Promise<void>;
  /** Whether the window is currently maximized (seed the restore/maximize icon). */
  'window:isMaximized': () => Promise<boolean>;
  /**
   * The native Mica/Acrylic material this window was created with (F13.7), or `null` when
   * `windowMaterialFor` refused it and the renderer's own CSS glass pane is drawing the
   * chrome instead.
   */
  'window:nativeMaterial': () => Promise<NativeMaterial | null>;

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
  /** Whether the private feed has a token, can encrypt one, and which source feeds it now. */
  'update:getTokenStatus': () => Promise<UpdateTokenStatus>;
  /** Store the update token, encrypted via the OS secure store. */
  'update:setToken': (token: string) => Promise<{ ok: boolean; message: string }>;
  /** Remove the stored update token. */
  'update:clearToken': () => Promise<void>;

  // --- Issues (F5): the read-only browser over a tracker's open issues, and the ---------
  // one-click import that puts one on the board. See `@shared/issues` for the model.
  /**
   * One page of a tracker's issues matching `query`. The provider does the clamping
   * (`clampIssuePage`) before this resolves, so the size guarantee is the provider's, not
   * the caller's to enforce.
   */
  'issues:list': (query: IssueQuery) => Promise<IssuePage>;
  /**
   * Import one issue onto the board — the browser's "Add to board" / "Hand to agent"
   * actions. Idempotent by `(externalSource, externalKey)`: importing the same issue twice
   * returns the same card rather than creating a second one. Sets `Task.pinnedImport`, so
   * the next sync does not archive a card that was never inside its query to begin with.
   */
  'issues:import': (provider: IssueProviderId, key: string) => Promise<Task>;
}

/**
 * EVENT channels: the engine → UI push notifications. Phase 0 has none yet;
 * later phases add e.g. 'session:output', 'attention:new', 'limit:changed'.
 * Declared as an (initially empty) map so the preload/renderer typings are ready.
 */
export interface IpcEvents {
  /** A normalized event from a running Claude session (see SessionEventEnvelope). */
  'session:event': SessionEventEnvelope;
  /**
   * This run's stream has holes: events were coalesced away, shed under load, or lost with a
   * dropped connection between here and whoever is listening.
   *
   * Its own channel because a missing `session:event` is invisible by construction — a
   * transcript that is quietly three tool calls short looks exactly like one where the agent
   * did three fewer things. A consumer that gets this re-reads the transcript it knows is
   * incomplete (`task:activity`, which is the record; the live stream never was) instead of
   * rendering a plausible, wrong picture of the run.
   *
   * Nothing in the desktop emits it: an Electron IPC push does not drop events. It is for the
   * mirrored path, where the desktop's forwarder and the browser's receiver are separated by
   * a poll loop that can fall behind (`EventBatchRequest.gap`).
   */
  'session:gap': { runId: string };
  /** A task's status/sessionId changed (with its live runId while executing). */
  'task:changed': TaskChange;
  /**
   * The set of tasks whose branch is being merged changed — carries the WHOLE set, like
   * `chain:changed` and friends, so the UI replaces rather than patches.
   *
   * Its own channel rather than a flag on `TaskChange`, because a merge is precisely the
   * thing that does NOT change the task: the row is untouched from the moment Merge is
   * pressed until the merge lands, so there is no `task:changed` to hang it off. It is
   * also what tells an open detail pane to re-read its timeline when a merge finishes —
   * the outcome note is written straight to the DB and never streamed.
   */
  'task:integrating': string[];
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
   * The account-wide sign-in gate changed: an `AuthState` when the CLI proves it cannot
   * authenticate, or `null` when it can again and parked work resumes. Drives the
   * sign-in banner AND the status bar — a run's failure is harder evidence than
   * `claude:getStatus`'s check that a credentials file exists, which was true the whole
   * time the token inside it was expired.
   */
  'auth:changed': AuthState | null;
  /**
   * A token-usage sample was just recorded (Performance dashboard): one turn's spend
   * from a task or the orchestrator. The dashboard appends it to its live buffer and
   * recomputes the burn rate. Carries enough to update the chart without re-querying.
   */
  'usage:sample': UsageSample;
  /** The frameless window was maximized (true) or restored (false) — updates the title-bar icon. */
  'window:maximizedChanged': boolean;
  /**
   * Only the cards of one board that changed (F29.2), as summaries: the ones to insert or
   * replace, and the ids that left it. Sent after anything changes a board's list — a card
   * created, deleted, moved or archived, a plan's steps, a plan file edit, a tracker sync —
   * by `apps/client/src/main/taskDelta.ts`, which diffs the board against what it last sent. A list merges it with `applyTaskDelta`
   * (`@tm/ui/taskSummaryStore`); an open card re-reads its heavy half through `task:get`.
   */
  'tasks:changed': TaskDelta;
  /** A project's ticket review started, finished or failed — the row as it now stands. */
  'project:boardReviewChanged': { projectId: string; review: BoardReviewRecord };
  /**
   * Something happened during a sync that the human should know about but that did not fail
   * anything: JIRA answered a query short so nothing was removed, cards the search left out
   * turned out to still match it, a removal set too big to believe was refused.
   *
   * Its own channel rather than the board's error bar, and that is the point. None of these
   * is an error — the sync worked, the board is intact, and the message is describing a
   * decision the engine took to protect it. Showing that in red beside "Could not reach
   * JIRA" trains people to dismiss both without reading either.
   */
  'board:notice': { text: string; intent: 'warning' | 'error' };
  /**
   * The merge-request list changed — a forge sync landed, or a read marker moved.
   * The whole list, every provider's, so the board replaces rather than patches.
   */
  'mergeRequests:changed': MergeRequest[];
  /**
   * The chain changed — an arrow was drawn, erased, re-gated, or cascaded away with a
   * deleted card. Carries the whole list, exactly as `mergeRequests:changed` does,
   * so the board replaces rather than patches.
   */
  'chain:changed': TaskLink[];
  /**
   * The attachments changed — one was added, removed, or cascaded away with a deleted
   * card. The WHOLE list, like `chain:changed`, so every open pane replaces rather than
   * patches: a card's chips and a step's chips are two views of one list, and the card
   * detail pane is not the only screen that can change it.
   */
  'attachment:changed': TaskAttachment[];
  /**
   * A sync started, finished or failed — the whole state, so the status bar replaces rather
   * than patches. Pushed on every sync from either path (the button and the poller share
   * one body), and whenever settings change the interval out from under the countdown.
   */
  'sync:changed': SyncState;
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

  // --- Native tickets (Phase 24) ---------------------------------------------
  /**
   * A documented ticket relationship was added or removed — including cascaded away with a
   * deleted ticket. The whole list, like `chain:changed`.
   */
  'ticketLink:changed': TicketLink[];
  /** The person roster changed. The whole list, app-wide, like `chain:changed`. */
  'person:changed': Person[];
  /**
   * A project's label registry changed. The whole list across every ticket project, matching
   * what `label:list()` (no `projectId`) returns — the shape `polledEvents.ts` reproduces this
   * from.
   */
  'label:changed': TicketLabel[];
  /** A project's milestones changed. Same shape as `label:changed`, one table over. */
  'milestone:changed': Milestone[];

  /**
   * The automation list changed — one was saved, deleted, enabled/disabled, or fired. The
   * whole list, like `chain:changed`, so the board replaces rather than patches.
   */
  'automations:changed': Automation[];

  /**
   * One row was appended to the activity log (F2). Not relied on to keep a feed in sync —
   * `ipcEventFanout.ts` drops it; the Activity screen re-reads the whole page via
   * `activity:list` on the board's own poll cadence instead. The channel exists for F2.6's
   * recorder to push on, for whatever DOES want to react live (a toast, a badge count).
   */
  'activity:appended': ActivityRow;

  /**
   * One of the three review queues changed — a refresh landed, a card left `in-review`, or
   * a `mine`/`agent` row changed shape (F15.9). Carries the whole, already-deduped
   * snapshot, like `mergeRequests:changed` does for its own list, so every open Reviews
   * pane replaces rather than patches. Fired only when the deduped snapshot actually
   * differs from the previous one — a forge outage that changes nothing stays silent.
   */
  'review:queues:changed': ReviewQueuesSnapshot;
  /**
   * One AI review's row changed (F16.11) — it started, moved status, parked, or landed with
   * its cost and verdict. Carries the whole row, never findings: those arrive as drafts
   * through the review reads. A web viewer sees a review start and land through this.
   */
  'aiReview:changed': AiReview;
}

/** Convenience: the set of valid invoke channel names. */
export type IpcInvokeChannel = keyof IpcApi;

/** Convenience: the set of valid event channel names. */
export type IpcEventChannel = keyof IpcEvents;
