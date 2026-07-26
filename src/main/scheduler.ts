/**
 * The scheduler (Phase 3) — turns a project's static task list into a running
 * queue.
 *
 * WHAT IT DOES
 * ------------
 * When a project is "started", the scheduler repeatedly picks that project's next
 * `pending` task (in plan order) and runs it as ONE Claude session via the
 * SessionManager, honoring a concurrency limit (default 1 — strictly one task at
 * a time). It drives each task's status from the session's event stream:
 *
 *   start   → (still pending until the session says hello)
 *   started → running   + persist the session id immediately (so it can resume)
 *   result  → done / failed
 *   exited  → failed if it never produced a result and left non-zero
 *
 * As each task settles, the next pending one starts, until the queue drains (the
 * project goes idle) or the user pauses/stops it.
 *
 * PURE CORE
 * ---------
 * The scheduling *decision* (which task runs next) is the pure `selectNextPending`
 * function, unit-tested without a database or a real process. The class around it
 * only wires that decision to the store, the SessionManager, and the two UI
 * events (`task:changed`, `scheduler:changed`).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  ChatRefusal,
  ChatSendResult,
  Project,
  Task,
  TaskActivityEntry,
  TaskStatus,
} from '@shared/model';
import { chainInFlight, chatTarget } from '@shared/board';
import type { SchedulerState, TaskChange, SchedulerChange, ActiveRun } from '@shared/scheduler';
import type {
  ClaudeModel,
  PermissionMode,
  SessionEvent,
  StartSessionRequest,
} from '@shared/session';
import type { AttentionAnswer, AttentionItem, AttentionKind } from '@shared/attention';
import type { LimitState } from '@shared/limit';
import type { UsageSample, UsageSource } from '@shared/usage';
import {
  AGREE_SENTINEL,
  detectProposal,
  detectQuestion,
  detectResponse,
  NEEDS_INPUT_SENTINEL,
  OBJECT_SENTINEL,
  parseFileOwnership,
  PROPOSE_SENTINEL,
  siblingsAffectedByProposal,
  tallyConsensus,
  type DetectedProposal,
  type DetectedResponse,
  type OwnershipEntry,
} from './attention';
import {
  buildAgentSubtaskPrompt,
  buildAgentTaskPrompt,
  type AgentPromptComment,
} from './agentTaskPrompt';
import type { PermissionGate } from './claudeSession';
import { isBlockingLimitStatus, LimitGate } from './limitGate';
import type { PermissionRequest, PermissionDecisionResult } from './permissionBroker';
import { EXIT_PLAN_MODE_TOOL, evaluateToolUse } from './permissionPolicy';
import { tickPlanCheckbox } from './planParser';
import { extractPlanMarkdown, splitPlanIntoSteps } from './planToSubtasks';
import type { SessionManager } from './sessionManager';
import type { Store } from './store';
import type {
  IntegrationResult,
  LaunchTarget,
  WorktreeManager,
  WorktreePrep,
} from './worktreeManager';

/** Sent to Claude when a permission is denied with no note of its own. */
const DEFAULT_DENY_MESSAGE =
  'The human declined this action. Do not perform it — find a safer approach, or stop and explain.';

/**
 * Sent back to a planning session when the human APPROVES its plan (Phase 11). The
 * held `ExitPlanMode` is denied on purpose: approval means the orchestrator takes the
 * plan over and runs it as subtasks, one fresh session per step, so the session that
 * wrote the plan must stop rather than implement it. Its process is ended right after.
 */
const PLAN_HANDOVER_MESSAGE =
  'The human approved this plan. The orchestrator is now executing it as separate ' +
  'subtasks, one session per step, so do NOT implement it here. Stop now.';

/** Sent back when the human rejects a plan without giving a reason of their own. */
const PLAN_REJECTED_MESSAGE =
  'The human rejected this plan. Revise it — reconsider the approach and the breakdown ' +
  'into steps — then call ExitPlanMode again with the new plan.';

/** The comment filed on a parent card once the final step of its plan has merged. */
const PLAN_REVIEW_NOTE =
  'All steps of the approved plan are merged. Ready for review — move the card to Done ' +
  'yourself once you are happy with it.';

/** The nudge sent to a session we resume after a usage limit clears (Phase 5). */
const RESUME_NUDGE =
  'A usage limit interrupted you and it has now reset. Continue the task where you left off.';

/**
 * How many times the orchestrator lets the AGENT try to resolve a branch's rebase
 * conflicts (team-orchestrator conflict ladder, Rung 2) before parking it for a human
 * (Rung 3). Mechanical union-merge (Rung 1) runs first, inside the integration itself.
 */
const MAX_CONFLICT_FIX_ATTEMPTS = 2;

/**
 * The interactive actions offered when a failed task parks in the inbox (Phase A of
 * team orchestrator). The human picks one; `answerAttention` matches on the text.
 * Grouped so the option set can be built per failure kind.
 */
export const FAILURE_ACTION = {
  retry: 'Retry',
  retryFresh: 'Retry fresh (discard branch)',
  aiFix: 'AI fix & retry',
  retryIntegration: 'Retry integration',
  cleanup: 'Clean up & abandon',
  markDone: 'Mark done',
} as const;

/** Actions offered for a failed agent RUN vs. a failed branch INTEGRATION. */
const RUN_FAILURE_OPTIONS = [
  FAILURE_ACTION.retry,
  FAILURE_ACTION.retryFresh,
  FAILURE_ACTION.aiFix,
  FAILURE_ACTION.cleanup,
  FAILURE_ACTION.markDone,
];
const INTEGRATION_FAILURE_OPTIONS = [
  FAILURE_ACTION.retryIntegration,
  FAILURE_ACTION.cleanup,
  FAILURE_ACTION.markDone,
];

/** The interactive resolution actions offered for a parked failure, by kind. Pure. */
export function failureActionsFor(kind: 'run' | 'integration'): string[] {
  return kind === 'integration' ? [...INTEGRATION_FAILURE_OPTIONS] : [...RUN_FAILURE_OPTIONS];
}

/** Render a file list for a human-facing note: the first few paths, then "and N more". Pure. */
export function summarizeFiles(files: string[], max = 8): string {
  if (files.length <= max) return files.join(', ');
  return `${files.slice(0, max).join(', ')}, and ${files.length - max} more`;
}

/**
 * The two ways a human breaks a stalled cross-agent proposal (Phase D): accept it
 * (the proposer updates CONTRACT.md and teammates re-read) or keep the current
 * contract (the proposer proceeds without the change). Matched by text in
 * `answerAttention`, same shape as the failure actions.
 */
export const PROPOSAL_ACTION = {
  accept: 'Accept proposal',
  keep: 'Keep current contract',
} as const;

/**
 * How long a single consensus round waits for the affected teammates to weigh in
 * before escalating to the human (Phase D). Agents mid-tool may answer slowly, so
 * this is generous; non-responders are counted as objections when it fires.
 */
const NEGOTIATION_TIMEOUT_MS = 120_000;

/**
 * Whether a failed task should be auto-retried, given how many auto-retries have
 * already been spent and the configured cap. Pure, so the decision is testable.
 */
export function shouldAutoRetry(attemptsSpent: number, maxAutoRetries: number): boolean {
  return attemptsSpent < Math.max(0, maxAutoRetries);
}

/** Minimal shape the selection logic needs — kept tiny so tests don't build full tasks. */
export interface Schedulable {
  id: string;
  status: TaskStatus;
  order: number;
  /** The task's title, so `@needs:` dependencies (referenced by title) can be resolved. */
  title: string;
  /** Titles this task depends on; it isn't eligible until all of them are `done`. */
  dependsOn: string[];
  /** The heading this task lives under — the scope for a contract's implicit prereq. */
  phase: string;
  /** True when this task authors the milestone's shared CONTRACT.md (`@contract`). */
  isContract: boolean;
  /** True when this task lays down the milestone's shared scaffold/root (`@scaffold`). */
  isScaffold: boolean;
}

/**
 * Pick the next task to run: the lowest-`order` **eligible** task. A task is
 * eligible when it is `pending`, not already in flight, and every one of its
 * `@needs:` dependencies is satisfied. Returns `null` when nothing is runnable.
 * Pure and side-effect free.
 *
 * A dependency (referenced by title) is *satisfied* only when at least one task
 * bears that title and **every** task with that title is `done` — so duplicate
 * titles must all complete, and an unknown/misspelled title is never satisfied
 * (the task waits; the plan validator surfaces the dangling reference).
 *
 * `inFlight` holds ids of tasks the scheduler has already handed to a session but
 * whose `started` event hasn't landed yet — without it, the same task could be
 * picked twice in the brief window before its status flips to `running`.
 *
 * Contract-first (Phase C): a `@contract` task is an **implicit prerequisite of
 * every other task under the same phase/heading**. While such a contract task is
 * not yet `done`, its non-contract siblings are held — so the contract runs first,
 * and (being the only eligible task in its phase until it completes) alone. This is
 * on top of, not instead of, explicit `@needs:` gating.
 *
 * Scaffold-first (Phase D): a `@scaffold` task gates the whole phase the same way, but
 * ahead of even the contract task — it lays down the shared repo root before anything
 * else builds on it. So the order within a phase is: scaffold (alone) → contract (alone)
 * → the parallel siblings.
 */
export function selectNextPending<T extends Schedulable>(
  tasks: readonly T[],
  inFlight: ReadonlySet<string>,
): T | null {
  // Tally completion per title so a dependency is satisfied only when all tasks
  // sharing that title are done.
  const byTitle = new Map<string, { total: number; done: number }>();
  for (const task of tasks) {
    const entry = byTitle.get(task.title) ?? { total: 0, done: 0 };
    entry.total += 1;
    if (task.status === 'done') entry.done += 1;
    byTitle.set(task.title, entry);
  }
  const satisfied = (title: string): boolean => {
    const entry = byTitle.get(title);
    return entry !== undefined && entry.total > 0 && entry.done === entry.total;
  };

  // Phases that still have an unfinished scaffold / contract task gate their other tasks.
  const phasesAwaitingScaffold = new Set<string>();
  const phasesAwaitingContract = new Set<string>();
  for (const task of tasks) {
    if (task.isScaffold && task.status !== 'done') phasesAwaitingScaffold.add(task.phase);
    if (task.isContract && task.status !== 'done') phasesAwaitingContract.add(task.phase);
  }

  let best: T | null = null;
  for (const task of tasks) {
    if (task.status !== 'pending' || inFlight.has(task.id)) continue;
    if (!task.dependsOn.every(satisfied)) continue;
    // Scaffold goes first: hold everything else in the phase (even the contract task)
    // until the scaffold task is done.
    if (!task.isScaffold && phasesAwaitingScaffold.has(task.phase)) continue;
    // Then contract: hold the ordinary siblings while the phase's contract is outstanding.
    if (!task.isContract && !task.isScaffold && phasesAwaitingContract.has(task.phase)) continue;
    if (best === null || task.order < best.order) best = task;
  }
  return best;
}

/**
 * The prompt handed to Claude for one task. Pure, so it reads clearly and is stable.
 *
 * Two shaping options, mutually exclusive:
 *   - `planRelPath` (shared-dir mode): the agent may evolve the plan file on the fly
 *     (Phase 8) — the orchestrator watches that file and re-syncs new milestones/
 *     tasks into the board live.
 *   - `branch` (worktree mode, team orchestrator): the agent works on an isolated git
 *     branch that the orchestrator integrates back into base; it must NOT touch the
 *     plan file (owned by the main tree) and should commit its work on the branch.
 *   - `failureNote` (AI-assisted retry): a previous attempt failed; the agent is told
 *     the reason and asked to diagnose and fix it. Combines with either mode above.
 *
 * Contract-first (Phase C), layered on top of the above:
 *   - `contractSiblings` (this is a `@contract` task): the agent authors the shared
 *     `CONTRACT.md` for the named upcoming sibling tasks before they start.
 *   - `hasContract` (a sibling of a contract task): the agent is told to read and
 *     build against `CONTRACT.md` rather than reinventing the shared interfaces.
 */
export function buildTaskPrompt(
  projectName: string,
  task: Task,
  options: {
    planRelPath?: string;
    branch?: string;
    failureNote?: string;
    contractSiblings?: string[];
    hasContract?: boolean;
    isScaffold?: boolean;
    hasScaffold?: boolean;
  } = {},
): string {
  const { planRelPath, branch, failureNote, contractSiblings, hasContract } = options;
  const { isScaffold, hasScaffold } = options;
  const isContract = contractSiblings !== undefined;
  return [
    `You are working through the plan for the project "${projectName}".`,
    '',
    'Complete the following task:',
    '',
    task.title,
    '',
    task.phase ? `(This task is under: ${task.phase}.)` : '',
    '',
    'Make the necessary changes, then briefly summarize what you did.',
    '',
    // Scaffold task: it lays down the shared monorepo root that its milestone's parallel
    // siblings build inside. Runs first and alone (see `selectNextPending`).
    ...(isScaffold
      ? [
          `This is the SHARED SCAFFOLD task for its milestone. Create and commit ONLY the`,
          `shared project root that the upcoming sibling tasks all depend on — e.g. the`,
          `workspace file, the root manifest/package file, a base tsconfig/build config, a`,
          `\`.gitignore\`, and the lockfile. Do NOT implement any feature-specific package or`,
          `app here. Keep it minimal and commit it, so the orchestrator merges the root before`,
          `the siblings start and they each only add their own subtree (no collisions on these`,
          `shared files).`,
          '',
        ]
      : []),
    // Sibling of a scaffold task: the shared root already exists in the base branch.
    ...(!isScaffold && hasScaffold
      ? [
          `The shared project root (workspace file, root manifest, base config, \`.gitignore\`,`,
          `lockfile) has already been scaffolded and committed. Build ON it: add only your`,
          `own package/app subtree and reference the shared root. Avoid rewriting those shared`,
          `root files unless strictly necessary, so parallel tasks don't collide on them.`,
          '',
        ]
      : []),
    // Contract task: it authors the shared CONTRACT.md that its milestone's parallel
    // siblings will build against. Runs first and alone (see `selectNextPending`).
    ...(isContract
      ? [
          `This is the SHARED CONTRACT task for its milestone. Author or update`,
          `\`CONTRACT.md\` at the repository root: the shared interfaces, types, and key`,
          `decisions the following upcoming tasks must agree on, plus a "## File ownership"`,
          `section mapping files or areas to those tasks so they don't collide:`,
          ...(contractSiblings.length > 0
            ? contractSiblings.map((t) => `  - ${t}`)
            : ['  (no sibling tasks declared yet — keep the contract minimal)']),
          `Keep it concise and concrete; commit it so the orchestrator merges it before`,
          `the sibling tasks start.`,
          '',
        ]
      : []),
    // Sibling of a contract task: a shared CONTRACT.md already governs this milestone.
    // It must not be edited unilaterally — instead the agent raises a proposal (Phase
    // D) that its in-flight teammates vote on.
    ...(!isContract && hasContract
      ? [
          `A shared \`CONTRACT.md\` at the repository root defines the interfaces, types,`,
          `and file ownership for this milestone. Read it FIRST and build against it. Do`,
          `NOT change \`CONTRACT.md\` unilaterally. If you believe it must change, write a`,
          `line starting with "${PROPOSE_SENTINEL}" describing the change (list affected`,
          `files as "- " bullets below it), then stop and wait: your in-flight teammates`,
          `will weigh in and the orchestrator updates the contract if they agree.`,
          '',
        ]
      : []),
    // AI-assisted retry: a prior attempt failed. Give the agent the reason and ask
    // it to diagnose the cause before redoing the work (it may have left partial
    // changes in this worktree).
    ...(failureNote
      ? [
          `NOTE: a previous attempt at this task failed. The reported reason was:`,
          `"${failureNote}"`,
          `Diagnose why it failed and fix the underlying cause before completing the task.`,
          '',
        ]
      : []),
    // Worktree mode: the agent is isolated on its own branch; the orchestrator
    // integrates it back and owns the plan file, so the agent must not edit it.
    ...(branch
      ? [
          `You are on an isolated git branch "${branch}" — your own worktree. Commit your`,
          `work on this branch when you are done (the orchestrator merges it back into the`,
          `base branch automatically). Do NOT edit the plan file; the orchestrator manages it.`,
          '',
        ]
      : []),
    // Shared-dir mode: the agent may refine the plan itself (Phase 8): edits to the
    // plan file are watched and re-synced into the task board live.
    ...(planRelPath && !branch
      ? [
          `If the work reveals new milestones or tasks, you may add them to the plan file`,
          `"${planRelPath}" — "## Milestone" headings and "- [ ] task" checkbox items. The`,
          `orchestrator picks up plan edits live. Only reshape the plan when it genuinely helps.`,
          '',
        ]
      : []),
    // The explicit question contract (replaces guessing from prose). Detected by
    // `detectAttention`; the sentinel string is defined once in attention.ts.
    `If you need a decision or information from the human before you can continue — a`,
    `genuine clarifying question, or a choice that materially changes the outcome — do`,
    `NOT guess. Write a line that starts with "${NEEDS_INPUT_SENTINEL}" followed by your`,
    `question, then stop and wait. If there are specific choices, list each on its own`,
    `line below as a "- " bullet; the human can then pick one in a single click. Their`,
    `answer will be delivered so you can continue.`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === '')) // collapse double blanks
    .join('\n');
}

/** A one-line, human-readable description of a tool use, for an inbox prompt. */
function describeToolUse(name: string, input: Record<string, unknown>): string {
  const detail =
    (typeof input['command'] === 'string' && input['command']) ||
    (typeof input['file_path'] === 'string' && input['file_path']) ||
    (typeof input['path'] === 'string' && input['path']) ||
    '';
  return detail ? `${name}: ${detail}` : name;
}

/** Bookkeeping for one task the scheduler currently has a session running for. */
interface Run {
  taskId: string;
  /**
   * The project the run EXECUTES in. For a plan task that is the task's own project;
   * for a My Tasks card delegated to an agent it is the agent project (the card itself
   * stays on the Personal board) — see `runProjectFor`. Worktrees, integration, usage
   * attribution and `stop(projectId)` all key off this.
   */
  projectId: string;
  runId: string;
  /**
   * Permission mode / model this run was started with. Set from the task's
   * per-assignment override when it has one, else the project default; kept on the run
   * so `decidePermission` judges the run the human actually authorized.
   */
  permissionMode?: PermissionMode;
  model?: ClaudeModel;
  /**
   * (Phase 12) The human's chat message, when this run exists only to carry it into a
   * resumed conversation. It becomes the session's prompt in place of the resume nudge
   * or a rebuilt brief — the point of the run is that the agent hears exactly what was
   * typed. Absent on every ordinary run.
   */
  chatPrompt?: string;
  /** Set once we've decided the task's outcome, so a trailing `exited` doesn't re-settle it. */
  settled: boolean;
  /** (Worktree mode) the task's branch, set once the worktree is prepared. */
  branch?: string;
  /** (Worktree mode) the base branch this task integrates back into. */
  base?: string;
  /** (Worktree mode) the worktree directory the session ran in. */
  worktree?: string;
}

/** A parked merge conflict awaiting a human, so `answerAttention` can finish integrating. */
interface PendingIntegration {
  projectId: string;
  taskId: string;
  runId: string;
  branch: string;
  base: string;
  worktree: string;
}

/**
 * A parked failed task awaiting the human's chosen resolution (Phase A). `kind`
 * distinguishes a failed agent RUN (retry the agent) from a failed branch
 * INTEGRATION (re-attempt the merge). Worktree fields are present in worktree mode.
 */
interface PendingFailure {
  kind: 'run' | 'integration';
  projectId: string;
  taskId: string;
  runId: string;
  reason: string;
  branch?: string;
  base?: string;
  worktree?: string;
}

/** One affected teammate's stance in an in-flight proposal round (Phase D). */
interface ProposalSibling {
  taskId: string;
  runId: string;
  title: string;
  position: 'pending' | 'agree' | 'object';
  /** For an objection, the reason the teammate gave (surfaced to the human). */
  reason?: string;
}

/**
 * A cross-agent proposal being negotiated (Phase D): the proposer is parked
 * (session alive) while its affected in-flight siblings vote in one round. On
 * unanimous agreement the proposer is told to update CONTRACT.md and resume; on
 * any objection / timeout the round escalates to a human `proposal` inbox item
 * (`itemId` is then set). Keyed in `pendingProposals` by its own `id`.
 */
interface PendingProposal {
  id: string;
  projectId: string;
  /** The milestone/heading the proposal is scoped to (only same-phase siblings vote). */
  phase: string;
  proposerTaskId: string;
  proposerRunId: string;
  text: string;
  files: string[];
  siblings: ProposalSibling[];
  /** The consensus-round deadline timer; cleared once the round concludes. */
  timer?: ReturnType<typeof setTimeout>;
  /** The human inbox item id, once the round escalated (undefined during the round). */
  itemId?: string;
  /**
   * True once the proposer's `@@PROPOSE@@`-turn `result` has arrived (it has stopped
   * and is idle). A decision reached before this must wait for it, so we never resume
   * the proposer into a stale in-flight turn — see `resume`/`performResume`.
   */
  proposerReady: boolean;
  /**
   * A concluded decision awaiting delivery to the proposer. Set when the round
   * resolves (agreed / human-accepted / kept); delivered as soon as `proposerReady`.
   */
  resume?: { kind: 'accept' | 'keep'; note?: string };
}

export class Scheduler {
  /** Live runs keyed by runId. Its size (per project) is the concurrency in use. */
  private readonly runs = new Map<string, Run>();
  /** Task ids handed to a session but not yet settled — excluded from re-selection. */
  private readonly inFlight = new Set<string>();
  /** Projects the user has started and not paused/stopped. */
  private readonly activeProjects = new Set<string>();
  /**
   * Last announced run state per project, so a freshly (re)mounted Board can seed
   * its buttons from reality instead of defaulting every project to idle. Kept in
   * lockstep with the `scheduler:changed` events emitted by `setState`.
   */
  private readonly states = new Map<string, SchedulerState>();
  /** Open Attention-inbox items keyed by item id (Phase 4). */
  private readonly attention = new Map<string, AttentionItem>();
  /**
   * Blocked permission decisions keyed by their inbox item id. Each holds the
   * broker's `resolve` — calling it releases (or vetoes) the tool the CLI is
   * waiting on — plus the original tool input to echo back on approval.
   */
  private readonly pendingDecisions = new Map<
    string,
    {
      runId: string;
      input: Record<string, unknown>;
      resolve: (result: PermissionDecisionResult) => void;
    }
  >();
  /**
   * Merge conflicts parked for a human (team orchestrator), keyed by their inbox
   * item id. Holds what `answerAttention` needs to finish (or abandon) integrating
   * the task's branch once the human has resolved the conflict in the worktree.
   */
  private readonly pendingIntegrations = new Map<string, PendingIntegration>();
  /**
   * Failed tasks parked for a human (Phase A), keyed by their inbox item id — holds
   * what `answerAttention` needs to apply the chosen resolution.
   */
  private readonly pendingFailures = new Map<string, PendingFailure>();
  /**
   * In-flight cross-agent proposals (Phase D), keyed by proposal id. Holds the
   * proposer, the affected siblings and their votes, and (once escalated) the human
   * inbox item — the negotiation coordinator's whole state. Same lifecycle discipline
   * as `pendingIntegrations`/`pendingFailures`: cleared on stop/dispose/run-end.
   */
  private readonly pendingProposals = new Map<string, PendingProposal>();
  /**
   * Per-task count of consecutive auto-retries the scheduler has spent on a failing
   * agent run. Reset when the task finally succeeds or the human resolves it. Kept
   * in memory only (a restart starts the count over — acceptable).
   */
  private readonly attempts = new Map<string, number>();
  /**
   * Task ids queued for an auto-retry once their failed run finishes exiting. The
   * `exited` handler relaunches them (directly, if the project's queue is idle, so
   * ad-hoc runs still retry).
   */
  private readonly retryQueue = new Set<string>();
  /**
   * Failure context to inject into a task's NEXT run as an AI-assisted fix prompt,
   * keyed by task id. Set by the "AI fix & retry" resolution; consumed in `launch`.
   */
  private readonly fixNotes = new Map<string, string>();
  /**
   * Team-orchestrator conflict ladder (Rung 2 — AI). Per-task count of automatic
   * agent-driven conflict-resolution attempts already spent on a branch integration.
   * Once it hits {@link MAX_CONFLICT_FIX_ATTEMPTS} the conflict is handed to a human.
   */
  private readonly conflictFixAttempts = new Map<string, number>();
  /**
   * Tasks whose NEXT run is an agent conflict-fix run (Rung 2): the agent resolves the
   * rebase markers in its worktree, and on completion the scheduler finishes the merge via
   * `finishAfterConflict` instead of a fresh integrate. Keyed by task id → integration ctx.
   */
  private readonly pendingConflictFix = new Map<
    string,
    {
      projectId: string;
      taskId: string;
      runId: string;
      branch: string;
      base: string;
      worktree: string;
    }
  >();
  /**
   * Non-task sessions started for a project — currently the AI "Align plan" run,
   * which is launched outside the task queue. Tracked as runId → projectId so
   * `stop(projectId)` can terminate it too; without this an Align agent keeps
   * editing the plan after the user hits Stop (it lives in neither `runs` nor the
   * pending-* maps). Auto-pruned when the run ends.
   */
  private readonly auxRuns = new Map<string, string>();
  /**
   * Parent cards whose subtask chain should start as soon as their PLANNING run has
   * exited (Phase 11). Approving a plan stops that run and launches step 1 — but both
   * use the same worktree, so step 1 waits for the planning process to be gone rather
   * than racing it in the same directory.
   */
  private readonly chainStarts = new Set<string>();
  /** The permission gate handed to every task run (null until the broker is up). */
  private gate: PermissionGate | null = null;
  /**
   * Tells the UI a project's task LIST changed (not just one task's status) — used
   * when approving a plan creates a card's subtasks. Injected by the IPC layer, which
   * owns the renderer channel; null in tests.
   */
  private tasksChanged: ((projectId: string) => void) | null = null;
  /**
   * Fetches the linked ticket's comments for a delegated card's prompt. Injected by the
   * IPC layer (which owns the JIRA client) so the scheduler stays tracker-agnostic and
   * unit-testable; null in tests and when no tracker is configured.
   */
  private ticketComments: ((task: Task) => Promise<AgentPromptComment[]>) | null = null;
  /**
   * The account-wide usage-limit gate (Phase 5). When active, ALL scheduling is
   * held; when its timer fires, every parked task resumes by its saved session id.
   */
  private readonly limitGate: LimitGate;
  /** Once disposed (app quitting), ignore late session events so we never touch a closed DB. */
  private disposed = false;
  /**
   * The most recent rate-limit signal the CLI reported (any status, not just a
   * blocking one), so the Performance dashboard can show whether the account is
   * approaching a usage limit and when the window resets. Purely informational.
   */
  private lastRateLimit: { status: string; resetsAt: number | null } | null = null;

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly emitTask: (change: TaskChange) => void,
    private readonly emitScheduler: (change: SchedulerChange) => void,
    /** Push a new inbox item to the UI. */
    private readonly emitAttention: (item: AttentionItem) => void,
    /** Tell the UI an inbox item was answered/cleared. */
    private readonly emitAttentionResolved: (id: string) => void,
    /** Push the usage-limit gate's state (or null when it clears) to the UI. */
    private readonly emitLimit: (state: LimitState | null) => void,
    /**
     * Gives each task its own git worktree/branch and integrates it back into base
     * (team orchestrator). Optional: when omitted (e.g. unit tests) every task runs
     * in the shared project directory, exactly as before this feature.
     */
    private readonly worktrees?: WorktreeManager,
    /**
     * Push a recorded token-usage sample to the UI (Performance dashboard), so the
     * live chart/gauge update as each turn's cost lands. Optional (omitted in tests).
     */
    private readonly emitUsage?: (sample: UsageSample) => void,
  ) {
    this.limitGate = new LimitGate({
      now: () => Date.now(),
      // Jitter is bounded by the user's setting (Phase 6), read fresh each time.
      jitter: () => Math.floor(Math.random() * Math.max(0, this.store.getSettings().limitJitterMs)),
      setTimer: (ms, cb) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onResumeDue: (state) => this.resumeParked(state),
      onChanged: (state) => this.onLimitChanged(state),
    });
  }

  /**
   * Wire the permission gate (once the broker is listening). After this, every
   * task run is spawned with the pre-execution veto in place.
   */
  setPermissionGate(gate: PermissionGate): void {
    this.gate = gate;
  }

  /**
   * Wire the tracker-comment lookup used to brief an agent on a delegated card (see
   * `collectTicketComments`). Optional: without it the prompt simply carries the
   * ticket's description and the human's notes.
   */
  setTicketCommentProvider(provider: (task: Task) => Promise<AgentPromptComment[]>): void {
    this.ticketComments = provider;
  }

  /**
   * Wire the "this project's task list changed" notifier. Only plan approval needs it
   * (it creates subtask rows the Board has never seen); every other scheduler change is
   * a status update on a task the UI already holds.
   */
  setTasksChangedNotifier(notify: (projectId: string) => void): void {
    this.tasksChanged = notify;
  }

  /** Start (or resume) a project's queue. */
  start(projectId: string): void {
    if (this.disposed) return;
    // Resume anything a previous Stop halted: re-queue this project's `stopped`
    // tasks to `pending` so the pump picks them up again. They keep their saved
    // `sessionId`, so `startTask` RESUMES the conversation rather than restarting.
    for (const task of this.store.getTasks(projectId)) {
      if (task.status === 'stopped') this.updateTask(task.id, { status: 'pending' }, null);
    }
    this.activeProjects.add(projectId);
    this.setState(projectId, 'running');
    this.pump(projectId);
  }

  /** Stop starting new tasks, but let any in-flight task run to completion. */
  pause(projectId: string): void {
    if (!this.activeProjects.delete(projectId)) return;
    this.setState(projectId, 'paused');
  }

  /** Stop the queue and terminate this project's running sessions. */
  stop(projectId: string): void {
    this.activeProjects.delete(projectId);
    for (const run of [...this.runs.values()]) {
      if (run.projectId !== projectId) continue;
      run.settled = true; // we're deciding the outcome here, not the exit code
      this.clearRunAttention(run.runId); // drop any parked inbox items for this run
      this.sessions.stop(run.runId); // triggers `exited`, which cleans up bookkeeping
      this.updateTask(run.taskId, { status: 'stopped' }, null);
    }
    // Clear any merge conflicts / failed tasks parked for this project (team
    // orchestrator): their run already ended, so they aren't in `runs` above. Drop the
    // inbox item and mark the task stopped, keeping the branch/worktree for later.
    for (const [itemId, pending] of [...this.pendingIntegrations.entries()]) {
      if (pending.projectId !== projectId) continue;
      this.pendingIntegrations.delete(itemId);
      this.resolveAttention(itemId);
      this.updateTask(pending.taskId, { status: 'stopped' }, null);
    }
    for (const [itemId, failure] of [...this.pendingFailures.entries()]) {
      if (failure.projectId !== projectId) continue;
      this.pendingFailures.delete(itemId);
      this.attempts.delete(failure.taskId);
      this.resolveAttention(itemId);
      this.updateTask(failure.taskId, { status: 'stopped' }, null);
    }
    // Abandon any in-flight proposal negotiations for this project (Phase D): cancel
    // the round timer and drop its human item. The proposer/sibling runs are handled
    // by the `runs` loop above (marked stopped), so no task status to set here.
    for (const [id, proposal] of [...this.pendingProposals.entries()]) {
      if (proposal.projectId !== projectId) continue;
      this.clearProposalTimer(proposal);
      if (proposal.itemId) this.resolveAttention(proposal.itemId);
      this.pendingProposals.delete(id);
    }
    // Drop any pending conflict-fix bookkeeping for this project (team orchestrator, Rung 2):
    // the fix run is in `runs` above (stopped), so just forget the routing + attempt counters.
    for (const [taskId, fix] of [...this.pendingConflictFix.entries()]) {
      if (fix.projectId !== projectId) continue;
      this.pendingConflictFix.delete(taskId);
      this.conflictFixAttempts.delete(taskId);
    }
    // Terminate any non-task sessions for this project (the AI "Align plan" run):
    // they live outside `runs`, so Stop must reach them explicitly or the agent
    // keeps editing the plan after the user stops the project.
    for (const [runId, pid] of [...this.auxRuns.entries()]) {
      if (pid !== projectId) continue;
      this.sessions.stop(runId);
      this.auxRuns.delete(runId);
    }
    // If a usage limit has parked this project's tasks (Phase 5), stopping cancels
    // them too, so they are NOT resumed when the gate reopens.
    if (this.limitGate.active) {
      const parked = this.store.getTasks(projectId).filter((t) => t.status === 'blocked-by-limit');
      for (const task of parked) this.updateTask(task.id, { status: 'stopped' }, null);
      this.limitGate.unpark(parked.map((t) => t.id));
    }
    this.setState(projectId, 'idle');
  }

  /** Run a single task ad-hoc, regardless of whether its project's queue is active. */
  runTask(taskId: string): { runId: string } | null {
    if (this.disposed) return null;
    // A usage limit holds everything account-wide — don't start ad-hoc work either.
    if (this.limitGate.active) return null;
    // Already reserved or running: starting a second session for one task would give it
    // two agents in one worktree. (Reachable from the UI: a parked step offers "Run this
    // step", and a stale card can be clicked twice.)
    if (this.inFlight.has(taskId)) return null;
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const project = this.runProjectFor(task);
    if (!project) return null;
    return { runId: this.startTask(project, task) };
  }

  /**
   * Stop the live run of ONE task (the My Tasks "Stop" action for a delegated card),
   * without touching anything else in its project. The task is marked `stopped`; a
   * worktree/branch is deliberately left in place so the work can be resumed or
   * inspected. Returns false when the task has no run to stop.
   *
   * Mirrors `stop(projectId)`, narrowed to a single task: any parked inbox item for it
   * (question, permission, failure, conflict) is cleared too, since a dead run can no
   * longer act on an answer.
   *
   * Stopping a card that is executing an approved plan (Phase 11) stops the STEP that
   * is running too — the step is the card's work, so "Stop" on the card has to reach it
   * or the chain would keep going with the card marked stopped.
   */
  /**
   * Say something to the agent working this card (Phase 12) — the human opening a turn,
   * rather than answering a question the agent asked.
   *
   * Where it goes: a card executing an approved plan holds no session of its own, so the
   * message follows `chatTarget` to the live step. The result names the task that
   * actually received it.
   *
   * What it does, in order:
   *  - **Nothing live** → `resumeForChat`: continue the last conversation with `--resume`,
   *    or refuse with the reason there is nothing to continue.
   *  - **A held tool call** (a permission request, or a plan awaiting approval) → refuse:
   *    the CLI is blocked on an approve/deny for one specific call and prose cannot
   *    answer it. Sending anyway would queue the text behind a decision that may never
   *    come.
   *  - **A parked question** → the message *is* the answer, so it goes through
   *    `answerAttention`: the item clears and the task goes back to `running`. Anything
   *    else would leave a stale item pointing at a question already answered.
   *  - Otherwise → straight into the live session's open input stream.
   *
   * The timeline entry is written BEFORE the send, so a session that dies mid-delivery
   * still leaves a record of what the human said.
   */
  chatWithAgent(taskId: string, message: string): ChatSendResult {
    const text = message.trim();
    const card = this.store.getTask(taskId);
    if (!card) return { status: 'refused', taskId, reason: 'unknown-task' };
    if (!text) return { status: 'refused', taskId, reason: 'empty-message' };

    const target = chatTarget(card, this.store.getSubtasks(card.id));
    const run = this.disposed
      ? undefined
      : [...this.runs.values()].find((r) => r.taskId === target.id);

    if (!run) return this.resumeForChat(target, text);

    const held = [...this.attention.values()].find(
      (item) =>
        item.runId === run.runId && (item.kind === 'permission' || item.kind === 'plan-approval'),
    );
    if (held) return { status: 'refused', taskId: target.id, reason: 'awaiting-decision' };

    this.store.addChatMessage(target.projectId, target.id, text);

    const question = [...this.attention.values()].find(
      (item) => item.runId === run.runId && item.kind === 'question',
    );
    if (question) this.answerAttention(question.id, { decision: 'reply', text });
    else this.sessions.send(run.runId, text);

    return { status: 'sent', taskId: target.id, runId: run.runId };
  }

  /**
   * Nobody is listening: continue the target's last conversation with `claude --resume`,
   * prompted with what the human typed (Phase 12, phase 2).
   *
   * This is a **real run** — reserved slot, worktree prepared with the chain's owner,
   * settled and integrated like any other — not a side channel, which is why every reason
   * it must not start is checked here first:
   *
   *  - `never-ran`: no session id, so there is nothing to continue. Chat deliberately does
   *    not start a conversation from nothing — that is what *Assign to an agent* is for.
   *  - `limit`: a usage limit holds all work account-wide. A parked task resumes by itself
   *    when the gate reopens, so starting a run now would only be killed again.
   *  - `chain-busy`: the card handed over to an approved plan; see `chainInFlight`.
   *
   * The message is recorded before the run starts, so the timeline reads in the order it
   * happened even if the session dies on spawn.
   */
  private resumeForChat(target: Task, text: string): ChatSendResult {
    const refused = (reason: ChatRefusal): ChatSendResult => ({
      status: 'refused',
      taskId: target.id,
      reason,
    });
    if (this.disposed) return refused('not-running');
    if (!target.sessionId) return refused(this.limitGate.active ? 'limit' : 'never-ran');
    if (this.limitGate.active || target.status === 'blocked-by-limit') return refused('limit');
    if (!target.parentTaskId && chainInFlight(this.store.getSubtasks(target.id))) {
      return refused('chain-busy');
    }
    const project = this.runProjectFor(target);
    if (!project) return refused('never-ran');

    this.store.addChatMessage(target.projectId, target.id, text);
    const runId = this.startTask(project, target, { chatPrompt: text });
    return { status: 'resumed', taskId: target.id, runId };
  }

  stopTask(taskId: string): boolean {
    if (this.disposed) return false;
    let stopped = false;
    // The card and, if it is executing a plan, its steps — one Stop covers the chain.
    const steps = this.store.getSubtasks(taskId);
    const owned = new Set<string>([taskId, ...steps.map((s) => s.id)]);
    for (const run of [...this.runs.values()]) {
      if (!owned.has(run.taskId)) continue;
      run.settled = true; // we're deciding the outcome here, not the exit code
      this.clearRunAttention(run.runId);
      this.sessions.stop(run.runId); // `exited` cleans up the bookkeeping
      if (run.taskId !== taskId) this.updateTask(run.taskId, { status: 'stopped' }, null);
      stopped = true;
    }
    // Parked items whose run already ended (a failed task / conflict awaiting a human).
    for (const [itemId, pending] of [...this.pendingIntegrations.entries()]) {
      if (!owned.has(pending.taskId)) continue;
      this.pendingIntegrations.delete(itemId);
      this.resolveAttention(itemId);
      stopped = true;
    }
    for (const [itemId, failure] of [...this.pendingFailures.entries()]) {
      if (!owned.has(failure.taskId)) continue;
      this.pendingFailures.delete(itemId);
      this.resolveAttention(itemId);
      stopped = true;
    }
    // A task parked behind the usage-limit gate has no live run and no inbox item, but
    // it IS pending work the user is entitled to cancel — otherwise it would come back
    // to life at reset time.
    if (this.store.getTask(taskId)?.status === 'blocked-by-limit') stopped = true;
    // A card whose plan is approved but whose first step hasn't started yet is still
    // stoppable: there is queued work even though nothing is running.
    if (this.chainStarts.has(taskId) || steps.some((s) => s.status === 'pending')) stopped = true;
    if (!stopped) return false;
    this.attempts.delete(taskId);
    this.retryQueue.delete(taskId);
    this.fixNotes.delete(taskId);
    this.pendingConflictFix.delete(taskId);
    this.conflictFixAttempts.delete(taskId);
    // Stopping a card cancels an approved plan's pending chain too: its queued first
    // step must not spring to life when the planning run finally exits, and its
    // remaining steps are stopped so nothing is left looking runnable (Phase 11).
    this.chainStarts.delete(taskId);
    for (const step of this.store.getSubtasks(taskId)) {
      if (step.status === 'pending') this.updateTask(step.id, { status: 'stopped' }, null);
    }
    // A limit-parked task counts as stoppable too: drop it from the gate so it is not
    // resurrected when the limit resets.
    this.limitGate.unpark([taskId]);
    this.updateTask(taskId, { status: 'stopped' }, null);
    return true;
  }

  /**
   * Which project a task's run EXECUTES in. A card delegated to an agent runs in that
   * agent project's repo while the card itself stays on the Personal board, so every
   * launch site resolves through here rather than reading `task.projectId` directly —
   * that is what makes limit-park → auto-resume, auto-retry and restart reconciliation
   * behave identically for agent tasks and plan tasks. A stale/plan-kind
   * `agentProjectId` falls back to the task's own project rather than refusing to run.
   */
  private runProjectFor(task: Task): Project | undefined {
    if (task.agentProjectId) {
      const agentProject = this.store.getProject(task.agentProjectId);
      if (agentProject?.kind === 'agent') return agentProject;
    }
    return this.store.getProject(task.projectId);
  }

  /**
   * Start a one-shot session that isn't tied to a task — currently the AI "Align
   * plan" run. Registered under its project so `stop(projectId)` and `dispose()`
   * terminate it, closing the hole where an Align agent kept editing the plan after
   * the user hit Stop. It's a one-shot: because we attach an observer the
   * SessionManager won't auto-close it on `result` (that's reserved for unmanaged
   * runs), so we close it here and prune the registry when it ends.
   */
  startAuxiliarySession(projectId: string, request: StartSessionRequest): { runId: string } {
    if (this.disposed) return { runId: '' };
    const { runId } = this.sessions.start(request, {
      onEvent: (event) => {
        // The orchestrator's own token spend (the "Align plan" run) — attributed to the
        // project but no task, so it shows as "Orchestrator" on the Performance dashboard.
        if (event.kind === 'usage') {
          this.recordUsage('orchestrator', projectId, null, runId, event);
        } else if (event.kind === 'result') {
          this.recordCost('orchestrator', projectId, null, runId, event.costUsd);
        }
        if (event.kind === 'result') this.sessions.stop(runId);
        if (event.kind === 'result' || event.kind === 'exited') this.auxRuns.delete(runId);
      },
    });
    this.auxRuns.set(runId, projectId);
    return { runId };
  }

  /**
   * Whether any task run is currently executing under a project. Used to refuse
   * deleting a project out from under a live session — a run keys off its project's
   * directory (and, for a worktree run, still has to be integrated back into it).
   */
  hasLiveRuns(projectId: string): boolean {
    return [...this.runs.values()].some((r) => r.projectId === projectId);
  }

  /** Snapshot of executing tasks, so the Board can attach live transcripts on load. */
  activeRuns(): ActiveRun[] {
    return [...this.runs.values()].map((r) => ({ taskId: r.taskId, runId: r.runId }));
  }

  /** Snapshot of each project's current run state (seed the Board's buttons on mount). */
  schedulerStates(): SchedulerChange[] {
    return [...this.states.entries()].map(([projectId, state]) => ({ projectId, state }));
  }

  /** Snapshot of everything waiting on a human, oldest first (seed the inbox on load). */
  listAttention(): AttentionItem[] {
    return [...this.attention.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The active usage-limit gate, or null — seeds the countdown banner on load. */
  currentLimit(): LimitState | null {
    return this.limitGate.state;
  }

  /**
   * Lift the usage-limit gate immediately (the banner's "Resume now") — for a false
   * trip or a limit that has already cleared. Resumes the parked tasks and clears
   * the gate; no-op if no limit is in force.
   */
  resumeLimitNow(): void {
    if (this.disposed) return;
    this.limitGate.resumeNow();
  }

  /**
   * Re-arm a usage-limit gate that was in force when the app last closed (Phase 5).
   * Called once at startup after the permission broker is up (so resumed runs are
   * still gated). If the reset already passed while the app was down, parked tasks
   * resume right away.
   */
  restoreLimitGate(): void {
    if (this.disposed) return;
    const saved = this.store.loadLimitGate();
    if (saved) this.limitGate.restore(saved);
  }

  /**
   * On startup (Phase 6), heal tasks the DB left mid-flight: a `running` or
   * `waiting-input` task's process died when the app closed, so there is nothing
   * to re-attach to. Re-queue each to `pending` — its saved `sessionId` is kept,
   * so when it runs again `startTask` RESUMES the conversation rather than losing
   * context. `blocked-by-limit` tasks are left for the limit gate to resume.
   *
   * A **step** of an approved plan is parked `failed` instead (Phase 12). Nothing
   * re-enters a chain on its own — `advanceSubtasks` runs when a step *finishes*, and a
   * card is not a queue — so a step left `pending` here would leave the card sitting at
   * `2/4` forever with nothing on screen saying why. `failed` is the state the board and
   * the agent panel already read as "this chain stopped, here is how to restart it", and
   * the note says what actually happened.
   */
  reconcileInterruptedTasks(): void {
    if (this.disposed) return;
    for (const project of this.store.listProjects()) {
      for (const task of this.store.getTasks(project.id)) {
        if (task.status !== 'running' && task.status !== 'waiting-input') continue;
        if (task.parentTaskId) {
          this.noteRun(
            task.projectId,
            task.id,
            'restart',
            'The app closed while this step was running, so it was parked for you. Its session is kept — running it again continues the same conversation.',
          );
          this.updateTask(task.id, { status: 'failed' }, null);
        } else {
          this.updateTask(task.id, { status: 'pending' }, null);
        }
      }
    }
  }

  /**
   * Decide one tool use the broker forwarded (a tool the CLI is BLOCKED on).
   * Safe → allow immediately; risky → raise an inbox item and return a promise
   * that stays unresolved until a human answers, holding the tool the whole time.
   * Called by the PermissionBroker; the pre-execution veto lives here.
   */
  decidePermission(request: PermissionRequest): Promise<PermissionDecisionResult> {
    if (this.disposed) {
      return Promise.resolve({ behavior: 'deny', message: 'orchestrator is shutting down' });
    }
    const run = this.runs.get(request.runId);
    if (!run) {
      // Can't correlate the tool to a task — fail safe rather than allow blindly.
      return Promise.resolve({ behavior: 'deny', message: 'unknown session' });
    }

    // Full auto (bypassPermissions): the human opted out of the risk policy for
    // this run — auto-approve every tool so nothing lands in the Attention inbox.
    // Genuine questions Claude asks (detectAttention) still surface. The RUN's mode
    // wins (a per-assignment override), falling back to the project default.
    // A finished plan (Phase 11): capture the markdown before deciding anything, so the
    // plan survives whatever the human chooses — and a restart. Done ahead of the
    // bypass shortcut below, since a full-auto run still produces a plan worth keeping.
    if (request.toolName === EXIT_PLAN_MODE_TOOL) {
      this.capturePlan(run.taskId, request.input);
    }

    const project = this.store.getProject(run.projectId);
    const mode = run.permissionMode ?? project?.defaultPermissionMode;
    if (mode === 'bypassPermissions') {
      return Promise.resolve({ behavior: 'allow', updatedInput: request.input });
    }

    // A finished plan gets its own inbox kind rather than a generic permission prompt:
    // the human is approving a BREAKDOWN (which becomes subtasks), not a tool call. The
    // tool stays blocked meanwhile, so the agent can't slide from planning to editing.
    if (request.toolName === EXIT_PLAN_MODE_TOOL) {
      const item = this.raisePlanApproval(run);
      return new Promise<PermissionDecisionResult>((resolve) => {
        this.pendingDecisions.set(item.id, { runId: request.runId, input: request.input, resolve });
      });
    }

    const decision = evaluateToolUse(request.toolName, request.input);
    if (decision.action === 'allow') {
      return Promise.resolve({ behavior: 'allow', updatedInput: request.input });
    }

    // Risky: park the task and hold the tool until the human answers.
    const item = this.raiseAttention(run, {
      kind: 'permission',
      prompt: describeToolUse(request.toolName, request.input),
      toolName: request.toolName,
      reason: decision.reason,
    });
    return new Promise<PermissionDecisionResult>((resolve) => {
      this.pendingDecisions.set(item.id, { runId: request.runId, input: request.input, resolve });
    });
  }

  /**
   * Persist the plan a `plan`-mode run just produced (Phase 11). Called from both
   * capture points — the broker request and the `tool-use` event — so it must be
   * safe to run twice for one plan; writing the same markdown again is a no-op in
   * effect. A call carrying no usable plan text leaves any previously stored plan
   * alone rather than blanking it.
   */
  private capturePlan(taskId: string, input: unknown): void {
    const plan = extractPlanMarkdown(input);
    if (!plan) return;
    const task = this.store.getTask(taskId);
    if (!task || task.agentPlan === plan) return;
    this.updateTask(taskId, { agentPlan: plan }, null);
  }

  /**
   * Answer one inbox item. A `permission` item releases or vetoes the blocked
   * tool via its held broker promise; a `question` item pushes the reply into the
   * live session. Either way the item clears and the task returns to `running`.
   * No-op if the item is unknown (already answered, or its run ended).
   */
  answerAttention(itemId: string, answer: AttentionAnswer): void {
    if (this.disposed) return;
    const item = this.attention.get(itemId);
    if (!item) return;

    if (item.kind === 'task-failed') {
      const f = this.pendingFailures.get(itemId);
      if (!f) return; // already handled
      this.pendingFailures.delete(itemId);
      this.resolveAttention(itemId);
      const choice = answer.decision === 'reply' ? answer.text.trim() : '';
      const note = 'note' in answer ? answer.note?.trim() : undefined;
      void this.applyFailureChoice(f, choice, note);
      return;
    }

    if (item.kind === 'proposal') {
      const proposal = [...this.pendingProposals.values()].find((p) => p.itemId === itemId);
      if (!proposal) return; // already handled
      this.resolveAttention(itemId);
      const choice = answer.decision === 'reply' ? answer.text.trim() : '';
      const note = 'note' in answer ? answer.note?.trim() : undefined;
      this.applyProposalDecision(proposal, choice, note);
      return;
    }

    if (item.kind === 'plan-approval') {
      // The held ExitPlanMode, if the CLI routed it through the gate. It may legitimately
      // be absent — the `tool-use` fallback raises the same item without holding a tool.
      const pending = this.pendingDecisions.get(itemId);
      this.pendingDecisions.delete(itemId);
      this.resolveAttention(itemId);
      const note = 'note' in answer ? answer.note?.trim() : undefined;
      if (answer.decision === 'approve') {
        this.approvePlan(item, pending?.resolve, note);
      } else {
        // Rejected: the session keeps its plan-mode context and re-plans with the note
        // as the reason, which is far cheaper than starting the research over.
        const message = note || PLAN_REJECTED_MESSAGE;
        if (pending) pending.resolve({ behavior: 'deny', message });
        else this.sessions.send(item.runId, message);
        this.updateTask(item.taskId, { status: 'running' }, item.runId);
      }
      return;
    }

    if (item.kind === 'merge-conflict') {
      const pending = this.pendingIntegrations.get(itemId);
      if (!pending) return; // already handled
      this.pendingIntegrations.delete(itemId);
      this.resolveAttention(itemId);
      if (answer.decision === 'deny') {
        // Abandon: fail the task but keep the branch/worktree so work isn't lost.
        this.noteRun(
          pending.projectId,
          pending.taskId,
          pending.runId,
          `Integration abandoned by the human; branch "${pending.branch}" and its worktree were kept.`,
        );
        this.updateTask(pending.taskId, { status: 'failed' }, null);
      } else {
        // Resolved: continue the rebase and fast-forward base.
        void this.finishConflict(pending);
      }
      return;
    }

    if (item.kind === 'permission') {
      const pending = this.pendingDecisions.get(itemId);
      if (!pending) return; // its run already ended — nothing to release
      this.pendingDecisions.delete(itemId);
      const note = 'note' in answer ? answer.note?.trim() : undefined;
      if (answer.decision === 'approve') {
        pending.resolve({ behavior: 'allow', updatedInput: pending.input });
        // A note on approve is extra guidance queued for Claude's next turn.
        if (note) this.sessions.send(item.runId, note);
      } else {
        pending.resolve({ behavior: 'deny', message: note || DEFAULT_DENY_MESSAGE });
      }
    } else {
      // A question: deliver the human's reply into the open input stream.
      const text =
        answer.decision === 'reply' ? answer.text : ('note' in answer && answer.note) || '';
      this.sessions.send(item.runId, text);
    }

    this.resolveAttention(itemId);
    // If nothing else is parked on this run, it is live again.
    if (!this.hasPendingAttention(item.runId)) {
      this.updateTask(item.taskId, { status: 'running' }, item.runId);
    }
  }

  /**
   * Remove a task's leftover git worktree/branch (a manual sweep from the UI, for a
   * failed/abandoned task whose worktree we deliberately kept). No-op without a
   * worktree manager or for an unknown task.
   */
  async cleanupTaskWorktree(taskId: string): Promise<void> {
    if (this.disposed || !this.worktrees) return;
    const task = this.store.getTask(taskId);
    if (!task) return;
    // The worktree lives under the project the run happened in — the agent project for
    // a delegated card, not the Personal board it is filed on.
    const project = this.runProjectFor(task);
    if (!project) return;
    // For a step of a plan the worktree belongs to the parent — cleaning up one step
    // discards the whole chain's branch, which is exactly what "clean up" means here.
    await this.worktrees.cleanup(project, this.worktreeOwner(task));
    this.attempts.delete(taskId);
  }

  /** Stop scheduling and ignore further events. Called on app quit BEFORE the DB closes. */
  dispose(): void {
    this.disposed = true;
    // Tear down the limit timer WITHOUT resuming, and leave its persisted state
    // intact so the gate is restored (and the resume still happens) on next launch.
    this.limitGate.dispose();
    // Release any tools the CLI is still blocked on so their relays don't hang.
    for (const pending of this.pendingDecisions.values()) {
      pending.resolve({ behavior: 'deny', message: 'orchestrator is shutting down' });
    }
    this.pendingDecisions.clear();
    this.pendingIntegrations.clear();
    this.pendingFailures.clear();
    for (const proposal of this.pendingProposals.values()) this.clearProposalTimer(proposal);
    this.pendingProposals.clear();
    this.attempts.clear();
    this.retryQueue.clear();
    this.fixNotes.clear();
    this.conflictFixAttempts.clear();
    this.chainStarts.clear();
    this.pendingConflictFix.clear();
    this.activeProjects.clear();
    this.runs.clear();
    this.auxRuns.clear(); // the caller's sessions.stopAll() kills the processes themselves
    this.inFlight.clear();
    this.attention.clear();
  }

  // ---- internals ----------------------------------------------------------

  /** Fill this project's free concurrency slots with its next pending tasks. */
  private pump(projectId: string): void {
    if (this.disposed || !this.activeProjects.has(projectId)) return;
    // A usage limit is account-wide: hold ALL scheduling until it resets (Phase 5).
    if (this.limitGate.active) return;
    const project = this.store.getProject(projectId);
    if (!project) return;
    // Concurrency is a live, PER-PROJECT setting: read it fresh so edits take effect.
    const concurrency = Math.max(1, project.concurrency);
    while (this.runningCount(projectId) < concurrency) {
      const next = selectNextPending(this.store.getTasks(projectId), this.inFlight);
      if (!next) break;
      this.startTask(project, next);
    }
    // If the queue has fully drained (nothing running, nothing left to start), the
    // project is done for now — go idle so the UI stops showing it as running.
    if (
      this.activeProjects.has(projectId) &&
      this.runningCount(projectId) === 0 &&
      selectNextPending(this.store.getTasks(projectId), this.inFlight) === null
    ) {
      this.activeProjects.delete(projectId);
      this.setState(projectId, 'idle');
    }
  }

  /**
   * Start a session for one task. If the task already has a `sessionId` — because
   * a usage limit parked it (Phase 5) or it was interrupted by an app restart
   * (Phase 6) — the CLI RESUMES that exact conversation with a continue-nudge, so
   * no context is lost. A never-run task starts fresh from its full task prompt.
   *
   * The run slot is **reserved synchronously** (its runId is generated and added to
   * `runs`/`inFlight` before returning) so `pump` counts it immediately and never
   * over-fills the project's concurrency. In worktree mode the actual session start
   * is deferred until the git worktree is prepared; the shared-dir path (and unit
   * tests without a WorktreeManager) starts the session synchronously as before.
   *
   * `opts.chatPrompt` (Phase 12) makes this a chat resume: the run is identical in every
   * other respect — same reservation, worktree, settling and integration — but the
   * session is prompted with what the human typed.
   */
  private startTask(project: Project, task: Task, opts: { chatPrompt?: string } = {}): string {
    const runId = randomUUID();
    const run: Run = {
      taskId: task.id,
      projectId: project.id,
      runId,
      settled: false,
      chatPrompt: opts.chatPrompt,
      // A per-assignment override (chosen in the assign dialog) beats the project
      // default, and is captured on the run so every later decision — permissions
      // above all — judges the run the human actually authorized.
      permissionMode: task.agentMode ?? project.defaultPermissionMode,
      model: task.agentModel ?? project.defaultModel,
    };
    this.runs.set(runId, run);
    this.inFlight.add(task.id);
    if (this.worktrees) {
      // Async: prepare (or reuse) the task's worktree, then start the session in it.
      void this.prepareAndLaunch(project, task, run);
    } else {
      // No worktree manager (unit tests / degenerate setups): run in the shared dir.
      this.launch(project, task, run, { mode: 'shared', cwd: project.path });
    }
    return runId;
  }

  /**
   * Ask the worktree manager where this task should run, then start its session
   * there — unless the run was stopped or usage-limited during preparation, in which
   * case the reservation is released without ever spawning a process.
   */
  private async prepareAndLaunch(project: Project, task: Task, run: Run): Promise<void> {
    // A delegated card's prompt carries its ticket's comment thread, which only the
    // tracker has. Fetched BEFORE the worktree so the stopped/parked checks below still
    // cover the whole wait; it fails soft to no comments.
    const comments = await this.collectTicketComments(task);
    let prep: WorktreePrep;
    try {
      // A step of an approved plan runs in its PARENT's worktree, on the parent's
      // branch — one shared branch per card, integrated once after the last step.
      prep = await this.worktrees!.prepare(project, task, this.worktreeOwner(task));
    } catch (err) {
      // Preparation blew up (odd git state). For a worktree-enabled repo, never fall back
      // to the base tree (that pollutes it) — fail the task; otherwise use the shared dir.
      prep = project.useWorktrees
        ? { mode: 'failed', reason: `Worktree preparation error: ${(err as Error).message ?? err}` }
        : { mode: 'shared', cwd: project.path };
    }
    if (this.disposed) return;
    // Stopped / parked by a usage limit while we were preparing: don't start it, and
    // free the reserved slot so the queue isn't stuck (the imminent `exited` that
    // normally cleans up never fires — the session never started).
    if (run.settled || !this.runs.has(run.runId)) {
      this.runs.delete(run.runId);
      this.inFlight.delete(run.taskId);
      this.pump(run.projectId);
      return;
    }
    if (prep.mode === 'failed') {
      // Couldn't isolate the task in its own worktree. Release the reserved slot and park
      // it for the human (retry / cleanup) instead of running it in the base tree.
      this.runs.delete(run.runId);
      this.inFlight.delete(run.taskId);
      this.attempts.delete(run.taskId);
      this.raiseTaskFailed({
        kind: 'run',
        projectId: run.projectId,
        taskId: run.taskId,
        runId: run.runId,
        reason: prep.reason,
      });
      this.pump(run.projectId);
      return;
    }
    this.launch(project, task, run, prep, comments);
  }

  /**
   * The linked ticket's comments, for an agent-assigned card's prompt. Empty unless a
   * comment provider is wired (`setTicketCommentProvider`, from the IPC layer, which
   * owns the JIRA client), the card is delegated, and this is a FRESH run — a resume
   * continues an existing conversation that already has the context. A tracker that is
   * down or misconfigured must never block a run, so failures degrade to no comments.
   */
  private async collectTicketComments(task: Task): Promise<AgentPromptComment[]> {
    // A step of a plan is briefed on its step, not on the ticket thread — that omission
    // IS the token saving (and a step carries no ticket key of its own anyway).
    if (task.parentTaskId) return [];
    if (!this.ticketComments || !task.agentProjectId || task.sessionId) return [];
    try {
      return await this.ticketComments(task);
    } catch {
      return [];
    }
  }

  /** Spawn the session for a reserved run in the prepared working directory. */
  private launch(
    project: Project,
    task: Task,
    run: Run,
    prep: LaunchTarget,
    comments: AgentPromptComment[] = [],
  ): void {
    const resumeSessionId = task.sessionId ?? undefined;
    if (prep.mode === 'worktree') {
      run.branch = prep.branch;
      run.base = prep.base;
      run.worktree = prep.cwd;
    }
    // The plan file's path relative to the project dir, so a shared-dir agent can
    // edit it. Worktree agents get the isolated (no-plan-edit) prompt instead.
    const planRel = relative(project.path, project.planPath) || project.planPath;
    // An "AI fix & retry" resolution queued a failure note for this task's next run:
    // build a full fix-prompt (even when resuming) so the agent gets the failure
    // context, and consume it so it applies only once. A chat run deliberately leaves
    // it queued: the human asking a question is not the retry that note was written for.
    const failureNote = run.chatPrompt ? undefined : this.fixNotes.get(task.id);
    if (!run.chatPrompt) this.fixNotes.delete(task.id);
    const branch = prep.mode === 'worktree' ? prep.branch : undefined;
    // What the session is told to do, in order of specificity: the human's own words
    // (Phase 12 chat), else a nudge to carry on an existing conversation, else the full
    // brief for a fresh run.
    const prompt =
      run.chatPrompt ??
      (resumeSessionId && !failureNote
        ? RESUME_NUDGE
        : this.buildPrompt(project, task, { branch, planRel, failureNote, comments }));
    const request: StartSessionRequest = {
      prompt,
      cwd: prep.cwd,
      // The run carries the per-assignment overrides (falling back to the project
      // defaults when the task has none); older runs without them use the project's.
      model: run.model ?? project.defaultModel,
      permissionMode: run.permissionMode ?? project.defaultPermissionMode,
    };
    this.sessions.start(request, {
      runId: run.runId, // use the reserved id so events and bookkeeping line up
      onEvent: (event) => this.onRunEvent(run.runId, event),
      // Gate every task run through the broker so risky tools are vetoed
      // pre-execution (ungated only if the broker never came up).
      permission: this.gate ?? undefined,
      resumeSessionId,
    });
  }

  /**
   * The starting prompt for a fresh run. A card delegated to an agent gets the
   * single-ticket prompt (`agentTaskPrompt.ts`) — no plan, no queue, no
   * contract/scaffold shaping, and never a `planRelPath` (an agent project has no plan
   * file to evolve). Everything else keeps the plan-task prompt exactly as before.
   */
  private buildPrompt(
    project: Project,
    task: Task,
    opts: {
      branch?: string;
      planRel: string;
      failureNote?: string;
      comments: AgentPromptComment[];
    },
  ): string {
    const { branch, planRel, failureNote, comments } = opts;
    // A step of an approved plan (Phase 11) — one step's brief, not the whole ticket.
    if (task.parentTaskId) {
      const subtaskPrompt = this.buildSubtaskPrompt(project, task, { branch, failureNote });
      if (subtaskPrompt) return subtaskPrompt;
    }
    if (task.agentProjectId) {
      return buildAgentTaskPrompt(project.name, task, {
        branch,
        failureNote,
        comments,
        notes: this.taskNotes(task.id),
      });
    }
    const modeOpts = branch ? { branch } : { planRelPath: planRel };
    // Contract-first (Phase C): a contract task is told which siblings its CONTRACT.md
    // serves; a sibling of a contract task is told to build against CONTRACT.md.
    return buildTaskPrompt(project.name, task, {
      ...modeOpts,
      ...this.contractPromptOptions(task),
      failureNote,
    });
  }

  /**
   * The prompt for one step of an approved plan: its own brief plus its place in the
   * chain. Returns null if the parent has vanished (a deleted card cascades to its
   * steps, so this is only reachable in odd states) — the caller then falls back to the
   * ordinary single-ticket prompt rather than running with no instructions.
   */
  private buildSubtaskPrompt(
    project: Project,
    task: Task,
    opts: { branch?: string; failureNote?: string },
  ): string | null {
    const parent = this.store.getTask(task.parentTaskId!);
    if (!parent) return null;
    const siblings = this.store.getSubtasks(parent.id);
    const index = siblings.findIndex((s) => s.id === task.id);
    return buildAgentSubtaskPrompt(project.name, parent, task, {
      stepNumber: index >= 0 ? index + 1 : 1,
      stepCount: Math.max(siblings.length, 1),
      stepTitles: siblings.map((s) => s.title),
      // The human's instructions live on the CARD, so every step of the chain sees them.
      notes: this.taskNotes(parent.id),
      branch: opts.branch,
      failureNote: opts.failureNote,
    });
  }

  /**
   * The human's own notes on a card, oldest first — the timeline's comments, which
   * include the instructions typed in the assign dialog. Read fresh on every launch so
   * a retry (and anything the human added since) reaches the agent.
   */
  private taskNotes(taskId: string): string[] {
    return this.store
      .getTaskActivity(taskId)
      .filter((e): e is Extract<TaskActivityEntry, { kind: 'comment' }> => e.kind === 'comment')
      .map((entry) => entry.body);
  }

  /**
   * Contract-first (Phase C) and scaffold-first (Phase D) prompt shaping for a task,
   * derived from its siblings (other plan tasks under the same phase). A `@contract` task
   * is handed the titles of the non-contract siblings its CONTRACT.md serves; a `@scaffold`
   * task is told to lay down the shared root; ordinary siblings are told a contract /
   * scaffold already governs the milestone. Returns an empty object for phases with
   * neither, so ordinary plans are unaffected.
   */
  private contractPromptOptions(task: Task): {
    contractSiblings?: string[];
    hasContract?: boolean;
    isScaffold?: boolean;
    hasScaffold?: boolean;
  } {
    const siblings = this.store
      .getTasks(task.projectId)
      .filter((t) => t.id !== task.id && t.phase === task.phase);
    const hasScaffold = siblings.some((t) => t.isScaffold);
    if (task.isScaffold) return { isScaffold: true };
    if (task.isContract) {
      return {
        contractSiblings: siblings
          .filter((t) => !t.isContract && !t.isScaffold)
          .map((t) => t.title),
        hasScaffold,
      };
    }
    return { hasContract: siblings.some((t) => t.isContract), hasScaffold };
  }

  /**
   * Record one turn's token consumption for the Performance dashboard and push it to
   * the UI. Called for every `usage` event, from both task runs and the orchestrator's
   * own auxiliary runs — this is how the app accounts for everything that spends tokens.
   */
  private recordUsage(
    source: UsageSource,
    projectId: string | null,
    taskId: string | null,
    runId: string,
    event: Extract<SessionEvent, { kind: 'usage' }>,
  ): void {
    if (this.disposed) return;
    const sample: UsageSample = {
      source,
      projectId,
      taskId,
      runId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cacheReadTokens: event.cacheReadTokens,
      totalTokens:
        event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens,
      createdAt: Date.now(),
    };
    this.store.appendTokenUsage(sample);
    this.emitUsage?.(sample);
  }

  /**
   * Record a run's end-of-turn cost as a token-free reconciliation row, so window
   * cost can be summed without double-counting the tokens the `usage` events already
   * captured. No-op when the CLI didn't report a cost.
   */
  private recordCost(
    source: UsageSource,
    projectId: string | null,
    taskId: string | null,
    runId: string,
    costUsd: number | null,
  ): void {
    if (this.disposed || costUsd == null) return;
    this.store.appendTokenUsage({
      source,
      projectId,
      taskId,
      runId,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd,
      createdAt: Date.now(),
    });
  }

  /**
   * Current usage pressure for the Performance summary: the last rate-limit status the
   * CLI reported, its reset time, and whether the account-wide gate is engaged.
   */
  getUsagePressure(): { status: string | null; resetsAt: number | null; limitActive: boolean } {
    return {
      status: this.lastRateLimit?.status ?? null,
      resetsAt: this.lastRateLimit?.resetsAt ?? null,
      limitActive: this.limitGate.active,
    };
  }

  private onRunEvent(runId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const run = this.runs.get(runId);
    if (!run) return;

    // Phase 6: persist every event to the task's history so its transcript is
    // viewable after the run ends or the app restarts.
    this.store.appendTaskEvent(run.projectId, run.taskId, runId, event);

    // Token accounting (Performance dashboard): a per-turn `usage` event is the task's
    // incremental spend; the `result` event carries the run's total cost. Recorded here,
    // before the negotiation/settlement branches below, so no early-return can skip it.
    if (event.kind === 'usage') {
      this.recordUsage('task', run.projectId, run.taskId, runId, event);
    } else if (event.kind === 'result') {
      this.recordCost('task', run.projectId, run.taskId, runId, event.costUsd);
    }

    // Plan capture, fallback path (Phase 11). `decidePermission` normally sees the
    // `ExitPlanMode` call first, but that depends on the CLI routing the tool through
    // the permission gate. The event stream always carries it, so capture here too —
    // `capturePlan` is idempotent, and losing a plan the agent spent a whole session
    // producing is far worse than writing the same markdown twice.
    if (event.kind === 'tool-use' && event.name === EXIT_PLAN_MODE_TOOL) {
      this.capturePlan(run.taskId, event.input);
    }

    // Inspect assistant messages for the three explicit markers, in priority order:
    //   1. a cross-agent PROPOSAL (Phase D) — start a consensus round with siblings;
    //   2. an AGREE/OBJECT RESPONSE (Phase D) — this run is a sibling voting on an
    //      open proposal (consumed silently, the sibling keeps working);
    //   3. a clarifying QUESTION (Phase 4) — park the task for the human.
    // (Permissions are handled separately, pre-execution, in decidePermission.)
    if (event.kind === 'assistant') {
      const proposal = detectProposal(event.text);
      const response = proposal ? null : detectResponse(event.text);
      if (proposal) {
        this.startProposal(run, proposal);
      } else if (response && this.recordProposalResponse(run.runId, response)) {
        // Consumed as a negotiation vote — not a question.
      } else {
        const question = detectQuestion(event.text);
        if (question) {
          this.raiseAttention(run, {
            kind: 'question',
            prompt: question.prompt,
            options: question.options,
            toolName: null,
            reason: null,
          });
        }
      }
    }

    switch (event.kind) {
      case 'started':
        // Persist the session id the instant it arrives, per docs/03, so the task
        // can be resumed after a limit reset or an app restart.
        this.updateTask(run.taskId, { status: 'running', sessionId: event.sessionId }, runId);
        break;

      case 'rate-limit':
        // Remember the latest signal (any status) so the Performance dashboard can show
        // whether we're approaching a limit and when the window resets.
        this.lastRateLimit = { status: event.status, resetsAt: event.resetsAt };
        // A usage limit signal (Phase 5). Only a HARD rejection parks work — an
        // `allowed`/`allowed_warning` (approaching the cap) or an empty status must
        // NOT engage the gate, or a mere warning falsely parks everything for a full
        // weekly window (see `isBlockingLimitStatus`).
        if (isBlockingLimitStatus(event.status)) this.engageLimit(event);
        break;

      case 'result':
        // The turn ended. A proposer mid-negotiation (Phase D) stopped after its
        // `@@PROPOSE@@` and is waiting on its teammates — record that it's now idle
        // (so a concluded decision can be delivered) and keep it alive; do NOT settle.
        if (this.isNegotiatingProposer(runId)) {
          this.noteProposerResult(runId);
          break;
        }
        // Parked awaiting a human (a question/permission): stay alive for the answer.
        if (this.hasPendingAttention(runId)) break;
        run.settled = true;
        this.settle(
          run,
          event.success ? 'done' : 'failed',
          event.terminalReason || event.stopReason || 'the session ended without success',
        );
        // stdin is held open in Phase 4, so the process won't exit by itself —
        // end it explicitly now that the task is done.
        this.sessions.stop(runId);
        break;

      case 'exited':
        // A run that exited without ever producing a result ended abnormally.
        if (!run.settled) {
          run.settled = true;
          this.settle(
            run,
            event.code === 0 ? 'done' : 'failed',
            `the process exited with code ${event.code ?? 'unknown'}`,
          );
        }
        this.clearRunAttention(runId); // a dead run can't be answered — drop its items
        this.runs.delete(runId);
        this.inFlight.delete(run.taskId);
        const retrying = this.retryQueue.delete(run.taskId);
        // An approved plan's chain waits for the planning process to release the shared
        // worktree before its first step starts in the same directory (Phase 11).
        if (this.chainStarts.delete(run.taskId)) this.advanceSubtasks(run.taskId);
        this.pump(run.projectId); // a slot freed up — advance the queue
        // An auto-retry of a task whose project queue is idle (e.g. an ad-hoc run):
        // `pump` won't touch an inactive project, so relaunch it directly.
        if (retrying && !this.activeProjects.has(run.projectId)) {
          const task = this.store.getTask(run.taskId);
          const project = task ? this.runProjectFor(task) : undefined;
          if (project && task && task.status === 'pending') this.startTask(project, task);
        }
        break;

      default:
        break;
    }
  }

  /**
   * A usage limit hit — engage the account-wide gate (Phase 5). Every currently
   * running task is parked (`blocked-by-limit`) and its process ended; the saved
   * session id lets us resume it when the gate's timer fires at reset time.
   */
  private engageLimit(event: Extract<SessionEvent, { kind: 'rate-limit' }>): void {
    // Account-wide: park EVERY in-flight run, not only the one that hit the wall.
    const active = [...this.runs.values()];
    this.limitGate.engage(
      { status: event.status, rateLimitType: event.rateLimitType, resetsAt: event.resetsAt },
      active.map((r) => r.taskId),
    );
    for (const run of active) {
      run.settled = true; // its imminent exit is expected — don't settle it as failed
      this.clearRunAttention(run.runId); // a parked run can't be answered mid-limit
      this.updateTask(run.taskId, { status: 'blocked-by-limit' }, null);
      // End the process now; we'll spawn a fresh `--resume` for it at reset time.
      this.sessions.stop(run.runId);
    }
  }

  /**
   * The gate's timer fired: the limit has reset. Resume each parked task by its
   * saved session id, skipping any the user has since stopped or removed.
   */
  private resumeParked(state: LimitState): void {
    if (this.disposed) return;
    for (const taskId of state.parkedTaskIds) {
      const task = this.store.getTask(taskId);
      // Only resume tasks still parked by the limit (not since stopped/deleted),
      // and only if we captured a session id to resume from.
      if (!task || task.status !== 'blocked-by-limit' || !task.sessionId) continue;
      const project = this.runProjectFor(task);
      if (!project) continue;
      this.startTask(project, task); // resumes by task.sessionId
    }
    // Slots may have freed without a parked task — nudge every active queue.
    for (const projectId of this.activeProjects) this.pump(projectId);
  }

  /** Persist the gate (so a limit survives a restart) and mirror it to the UI. */
  private onLimitChanged(state: LimitState | null): void {
    this.store.saveLimitGate(state);
    this.emitLimit(state);
  }

  /** Raise one Attention-inbox item for a run, park its task, and return the item. */
  private raiseAttention(
    run: Run,
    detail: {
      kind: AttentionKind;
      prompt: string;
      options?: string[];
      toolName: string | null;
      reason: string | null;
      /** `plan-approval` only: the plan markdown and the step titles it would create. */
      plan?: string;
      steps?: string[];
    },
  ): AttentionItem {
    const task = this.store.getTask(run.taskId);
    const item: AttentionItem = {
      id: randomUUID(),
      runId: run.runId,
      taskId: run.taskId,
      projectId: run.projectId,
      taskTitle: task?.title ?? '(unknown task)',
      kind: detail.kind,
      prompt: detail.prompt,
      options: detail.options ?? [],
      toolName: detail.toolName,
      reason: detail.reason,
      plan: detail.plan ?? null,
      steps: detail.steps ?? [],
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    this.updateTask(run.taskId, { status: 'waiting-input' }, run.runId);
    this.emitAttention(item);
    return item;
  }

  /** True if any inbox item is still open for this run. */
  private hasPendingAttention(runId: string): boolean {
    for (const item of this.attention.values()) if (item.runId === runId) return true;
    return false;
  }

  /** Remove one item and notify the UI. */
  private resolveAttention(itemId: string): void {
    if (this.attention.delete(itemId)) this.emitAttentionResolved(itemId);
  }

  /**
   * Drop (and notify) every open item for a run — used when the run ends. Any
   * permission decision still held open is released as a DENY so the broker's HTTP
   * call returns instead of hanging (the process is dying anyway).
   */
  private clearRunAttention(runId: string): void {
    for (const [itemId, pending] of [...this.pendingDecisions.entries()]) {
      if (pending.runId !== runId) continue;
      pending.resolve({ behavior: 'deny', message: 'session ended before approval' });
      this.pendingDecisions.delete(itemId);
    }
    for (const item of [...this.attention.values()]) {
      if (item.runId === runId) {
        this.pendingIntegrations.delete(item.id); // drop any parked conflict for this run
        this.pendingFailures.delete(item.id); // …and any parked failure
        this.resolveAttention(item.id);
      }
    }
    // Negotiations touching this run (Phase D): if it was the PROPOSER, the round
    // can't continue — cancel it. If it was a voting SIBLING that has now ended, drop
    // its vote; that may complete the round, so re-evaluate the remaining votes.
    for (const [id, proposal] of [...this.pendingProposals.entries()]) {
      if (proposal.proposerRunId === runId) {
        this.clearProposalTimer(proposal);
        if (proposal.itemId) this.resolveAttention(proposal.itemId);
        this.pendingProposals.delete(id);
        continue;
      }
      const before = proposal.siblings.length;
      proposal.siblings = proposal.siblings.filter((s) => s.runId !== runId);
      if (proposal.siblings.length !== before && !proposal.itemId) {
        this.maybeConcludeProposal(proposal);
      }
    }
  }

  /**
   * Apply a terminal status to a task and, on success, optionally tick the plan.
   *
   * A worktree run that finished successfully is NOT marked done here — its branch
   * must first integrate back into base (rebase → ff-merge). We kick that off async
   * and let its outcome set the final status (done / parked on conflict / failed).
   * A failed run is routed through `handleRunFailure` (auto-retry, then park); a
   * failed worktree run keeps its worktree and branch for inspection/retry.
   */
  private settle(run: Run, status: 'done' | 'failed', reason?: string): void {
    // A step of an approved plan that still has siblings to run: the chain's branch is
    // not finished, so there is nothing to integrate yet — mark the step done and start
    // the next one. Only the FINAL step falls through to the integration below, which
    // then merges the whole plan's work in one go (the run's branch/base/worktree
    // already point at the parent's — see `worktreeOwner`).
    if (status === 'done') {
      const finished = this.store.getTask(run.taskId);
      if (finished?.parentTaskId && this.hasPendingSibling(finished.parentTaskId, finished.id)) {
        this.attempts.delete(run.taskId);
        this.updateTask(run.taskId, { status: 'done' }, null);
        this.advanceSubtasks(finished.parentTaskId);
        return;
      }
    }
    if (status === 'done' && run.branch && run.base && run.worktree && this.worktrees) {
      // Capture the integration inputs now — the imminent `exited` event deletes this
      // run from `runs`, and integration is async.
      const project = this.store.getProject(run.projectId);
      if (project) {
        const ctx = {
          taskId: run.taskId,
          runId: run.runId,
          branch: run.branch,
          base: run.base,
          worktree: run.worktree,
        };
        // If this run was an agent conflict-fix (Rung 2), finish the paused rebase rather
        // than starting a fresh integrate — the worktree is mid-rebase with staged fixes.
        if (this.pendingConflictFix.delete(run.taskId)) {
          void this.finishConflict({ projectId: project.id, ...ctx });
        } else {
          void this.integrateWorktree(project, ctx);
        }
        return;
      }
    }
    if (status === 'failed') {
      this.handleRunFailure(run, reason ?? 'the task failed');
      return;
    }
    this.attempts.delete(run.taskId); // a success clears the retry counter
    this.updateTask(run.taskId, { status: 'done' }, null);
    this.maybeWriteBackPlan(run.taskId);
  }

  /**
   * A task's agent run failed. Auto-retry it up to `maxAutoRetries` (reusing its
   * worktree/session so partial work and context are kept), then park it in the
   * inbox for the human. The retry re-queues the task to `pending` and records it in
   * `retryQueue`, so the `exited` handler relaunches it even for an idle/ad-hoc queue.
   */
  private handleRunFailure(run: Run, reason: string): void {
    const attempted = this.attempts.get(run.taskId) ?? 0;
    const max = Math.max(0, this.store.getSettings().maxAutoRetries);
    if (shouldAutoRetry(attempted, max)) {
      this.attempts.set(run.taskId, attempted + 1);
      this.noteRun(
        run.projectId,
        run.taskId,
        run.runId,
        `Attempt failed (${reason}). Auto-retrying (${attempted + 1}/${max})…`,
      );
      this.retryQueue.add(run.taskId);
      this.updateTask(run.taskId, { status: 'pending' }, null);
      return;
    }
    // Out of auto-retries — park for the human with interactive options.
    this.attempts.delete(run.taskId);
    this.raiseTaskFailed({
      kind: 'run',
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.runId,
      reason,
      branch: run.branch,
      base: run.base,
      worktree: run.worktree,
    });
  }

  /**
   * Integrate a finished worktree task's branch back into base, then apply the
   * outcome: merged → done (+ plan write-back); conflict → park for a human;
   * dirty-base / error → failed (keeping the worktree so nothing is lost).
   */
  private async integrateWorktree(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
  ): Promise<void> {
    const task = this.store.getTask(ctx.taskId);
    const message = `orchestrator: ${task?.title ?? ctx.taskId}`;
    const result = await this.worktrees!.integrate(
      project,
      ctx.branch,
      ctx.base,
      ctx.worktree,
      message,
    );
    if (this.disposed) return;
    this.applyIntegrationResult(project, ctx, result);
  }

  /** Apply the outcome of an integrate/finish-after-conflict attempt (shared path). */
  private applyIntegrationResult(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
    result: IntegrationResult,
  ): void {
    switch (result.status) {
      case 'merged': {
        this.attempts.delete(ctx.taskId);
        this.conflictFixAttempts.delete(ctx.taskId);
        const note =
          result.preserved && result.preserved.files.length > 0
            ? `Merged branch "${ctx.branch}" into ${ctx.base}. Note: ${result.preserved.files.length} ` +
              `base-tree file(s) that differed from this branch were stashed as ` +
              `"${result.preserved.stashRef}" before merging (${summarizeFiles(result.preserved.files)}). ` +
              `Restore with \`git stash apply ${result.preserved.stashRef}\` in ${project.path} if needed.`
            : `Merged branch "${ctx.branch}" into ${ctx.base}.`;
        this.noteRun(project.id, ctx.taskId, ctx.runId, note);
        this.updateTask(ctx.taskId, { status: 'done' }, null);
        this.maybeWriteBackPlan(ctx.taskId);
        // This was the final step of an approved plan (only the last one ever gets
        // here): hand the card back to the human for review.
        this.finishParentChain(ctx.taskId);
        break;
      }
      case 'conflict':
        this.escalateConflict(project, ctx);
        break;
      case 'dirty-base':
        // Integration failures are NOT auto-retried (the fix is human-side): park with
        // a "Retry integration" option they can use after committing/stashing base.
        this.parkIntegrationFailure(
          project,
          ctx,
          `Base branch "${result.base}" has uncommitted changes, so branch "${ctx.branch}" ` +
            `was not merged. Commit or stash your work in ${project.path}, then choose ` +
            `"Retry integration".`,
        );
        break;
      case 'blocked-untracked':
        // Untracked base-tree files collide with this branch and couldn't be preserved
        // automatically, so we refused to overwrite them. Park for a human.
        this.parkIntegrationFailure(
          project,
          ctx,
          `Can't integrate branch "${ctx.branch}": the working tree in ${project.path} has ` +
            `uncommitted changes to ${result.files.length} file(s) that this branch also adds, so ` +
            `merging would overwrite them (${summarizeFiles(result.files)}). Commit, stash, or ` +
            `delete them in ${project.path}, then choose "Retry integration".`,
        );
        break;
      case 'error':
        this.parkIntegrationFailure(
          project,
          ctx,
          `Could not integrate branch "${ctx.branch}": ${result.message} (the worktree at ` +
            `${ctx.worktree} was kept for inspection).`,
        );
        break;
    }
  }

  /** Park a failed branch integration for the human (keeps the worktree/branch). */
  private parkIntegrationFailure(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
    reason: string,
  ): void {
    this.raiseTaskFailed({
      kind: 'integration',
      projectId: project.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      reason,
      branch: ctx.branch,
      base: ctx.base,
      worktree: ctx.worktree,
    });
  }

  /**
   * Conflict ladder (Rung 2 → Rung 3). A rebase left conflicts that mechanical union-merge
   * (Rung 1) couldn't resolve. Let the agent try to resolve them in its worktree up to
   * {@link MAX_CONFLICT_FIX_ATTEMPTS} times; only then hand it to a human.
   */
  private escalateConflict(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
  ): void {
    const spent = this.conflictFixAttempts.get(ctx.taskId) ?? 0;
    if (this.worktrees && spent < MAX_CONFLICT_FIX_ATTEMPTS) {
      this.conflictFixAttempts.set(ctx.taskId, spent + 1);
      void this.dispatchConflictFix(project, ctx, spent + 1);
      return;
    }
    // Out of AI attempts — a human resolves it. Reset so a later manual retry starts fresh.
    this.conflictFixAttempts.delete(ctx.taskId);
    this.raiseMergeConflict(project, ctx);
  }

  /**
   * Rung 2: requeue the task's agent to resolve the rebase conflict markers in its own
   * worktree (reusing the "AI fix" prompt channel), then finish the merge on completion.
   */
  private async dispatchConflictFix(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
    attempt: number,
  ): Promise<void> {
    const files = await this.worktrees!.listConflicts(ctx.worktree);
    if (this.disposed) return;
    const note =
      `Rebasing your branch onto "${ctx.base}" left merge conflicts in this worktree` +
      (files.length ? ` (${summarizeFiles(files)})` : '') +
      `. Resolve the conflict markers, then \`git add\` each resolved file. Do NOT run ` +
      `\`git rebase --continue\`, commit, push, or switch branches — the orchestrator finishes ` +
      `the rebase once your resolutions are staged. If a lockfile (e.g. pnpm-lock.yaml) ` +
      `conflicts, regenerate it (e.g. \`pnpm install\`) and stage it.`;
    this.noteRun(
      project.id,
      ctx.taskId,
      ctx.runId,
      `Merge conflict — attempting AI resolution (${attempt}/${MAX_CONFLICT_FIX_ATTEMPTS}).`,
    );
    this.pendingConflictFix.set(ctx.taskId, { projectId: project.id, ...ctx });
    this.fixNotes.set(ctx.taskId, note);
    this.requeue(project, ctx.taskId);
  }

  /** Park a task whose branch hit a merge conflict, so a human can resolve it. */
  private raiseMergeConflict(
    project: Project,
    ctx: { taskId: string; runId: string; branch: string; base: string; worktree: string },
  ): void {
    const task = this.store.getTask(ctx.taskId);
    const item: AttentionItem = {
      id: randomUUID(),
      runId: ctx.runId,
      taskId: ctx.taskId,
      projectId: project.id,
      taskTitle: task?.title ?? '(unknown task)',
      kind: 'merge-conflict',
      prompt:
        `Integrating branch "${ctx.branch}" into ${ctx.base} hit a merge conflict. Resolve the ` +
        `conflicts in the worktree below (edit the files, then \`git add\` them), then choose ` +
        `Resolved to finish the merge — or Abandon to leave the branch for later.`,
      options: [],
      toolName: null,
      reason: null,
      worktreePath: ctx.worktree,
      branch: ctx.branch,
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    this.pendingIntegrations.set(item.id, {
      projectId: project.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      branch: ctx.branch,
      base: ctx.base,
      worktree: ctx.worktree,
    });
    this.updateTask(ctx.taskId, { status: 'waiting-input' }, ctx.runId);
    this.emitAttention(item);
  }

  /**
   * Park a failed task in the inbox with interactive resolution options (Phase A).
   * Run failures offer retry / retry-fresh / AI-fix / cleanup / mark-done; integration
   * failures offer retry-integration / cleanup / mark-done.
   */
  private raiseTaskFailed(f: PendingFailure): void {
    const task = this.store.getTask(f.taskId);
    const options = failureActionsFor(f.kind);
    this.noteRun(f.projectId, f.taskId, f.runId, `Task parked after failure: ${f.reason}`);
    const item: AttentionItem = {
      id: randomUUID(),
      runId: f.runId,
      taskId: f.taskId,
      projectId: f.projectId,
      taskTitle: task?.title ?? '(unknown task)',
      kind: 'task-failed',
      prompt: f.reason,
      options: [...options],
      toolName: null,
      reason: null,
      worktreePath: f.worktree ?? null,
      branch: f.branch ?? null,
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    this.pendingFailures.set(item.id, f);
    this.updateTask(f.taskId, { status: 'waiting-input' }, f.runId);
    this.emitAttention(item);
  }

  /** Apply the human's chosen resolution for a parked failed task. */
  private async applyFailureChoice(
    f: PendingFailure,
    choice: string,
    note?: string,
  ): Promise<void> {
    const project = this.store.getProject(f.projectId);
    const task = this.store.getTask(f.taskId);
    if (!project || !task) return;
    switch (choice) {
      case FAILURE_ACTION.retry:
        // Reuse the worktree + session and try again.
        this.requeue(project, f.taskId);
        break;
      case FAILURE_ACTION.retryFresh:
        // Discard the branch/worktree and the saved session, then start clean. For a
        // step of a plan that is the chain's shared worktree (see `worktreeOwner`).
        await this.worktrees?.cleanup(project, this.worktreeOwner(task));
        this.updateTask(f.taskId, { status: 'pending', sessionId: null }, null);
        this.requeue(project, f.taskId);
        break;
      case FAILURE_ACTION.aiFix:
        // Keep the worktree/session; the next run gets the failure as fix context.
        this.fixNotes.set(f.taskId, note ? `${f.reason} — human note: ${note}` : f.reason);
        this.requeue(project, f.taskId);
        break;
      case FAILURE_ACTION.retryIntegration:
        if (f.branch && f.base && f.worktree) {
          this.updateTask(f.taskId, { status: 'running' }, f.runId);
          void this.integrateWorktree(project, {
            taskId: f.taskId,
            runId: f.runId,
            branch: f.branch,
            base: f.base,
            worktree: f.worktree,
          });
        }
        break;
      case FAILURE_ACTION.cleanup:
        await this.worktrees?.cleanup(project, this.worktreeOwner(task));
        this.attempts.delete(f.taskId);
        this.noteRun(
          f.projectId,
          f.taskId,
          f.runId,
          'Worktree cleaned up and task abandoned by the human.',
        );
        this.updateTask(f.taskId, { status: 'failed' }, null);
        break;
      case FAILURE_ACTION.markDone:
        this.attempts.delete(f.taskId);
        this.noteRun(
          f.projectId,
          f.taskId,
          f.runId,
          'Marked done by the human (branch left unmerged).',
        );
        this.updateTask(f.taskId, { status: 'done' }, null);
        this.maybeWriteBackPlan(f.taskId);
        // Waving a step through resumes its plan's chain — the human accepted this
        // step's outcome, so the next one should run.
        if (task.parentTaskId) this.advanceSubtasks(task.parentTaskId);
        break;
      default:
        // Unrecognized (free-text) answer — re-park so the decision isn't lost.
        this.raiseTaskFailed(f);
        break;
    }
  }

  /** Re-queue a task to `pending` and start it (via the queue if active, else directly). */
  private requeue(project: Project, taskId: string): void {
    this.updateTask(taskId, { status: 'pending' }, null);
    if (this.activeProjects.has(project.id)) {
      this.pump(project.id);
    } else {
      const task = this.store.getTask(taskId);
      if (task) this.startTask(project, task);
    }
  }

  // ---- Plan-driven subtasks (Phase 11) ------------------------------------

  /**
   * The task whose worktree/branch a run uses. Normally the task itself; for a step of
   * an approved plan it is the PARENT, so every step of the chain works in one worktree
   * on one branch and the whole plan integrates into base exactly once.
   */
  private worktreeOwner(task: Task): string {
    return task.parentTaskId ?? task.id;
  }

  /**
   * Park a finished plan for the human. The item carries the plan markdown and the
   * titles of the subtasks approval would create, so the inbox shows the breakdown
   * being signed off rather than just prose. Reuses the existing plan capture: the
   * markdown is read from the task (persisted by `capturePlan`), so a plan survives
   * an app restart between the agent producing it and the human reading it.
   */
  private raisePlanApproval(run: Run): AttentionItem {
    const plan = this.store.getTask(run.taskId)?.agentPlan ?? '';
    const steps = splitPlanIntoSteps(plan);
    return this.raiseAttention(run, {
      kind: 'plan-approval',
      prompt:
        steps.length > 0
          ? `The agent finished planning and proposes ${steps.length} step(s). Approving runs ` +
            `them one at a time, each in its own session, on this card's branch.`
          : 'The agent finished planning. Review the plan below before it is executed.',
      toolName: null,
      reason: null,
      plan,
      steps: steps.map((s) => s.title),
    });
  }

  /**
   * The human approved a plan: turn it into subtasks, end the planning session, and
   * start step 1.
   *
   * The planning session is deliberately NOT allowed to continue — its `ExitPlanMode`
   * is denied with a hand-over message and its process is stopped — because the whole
   * point is that each step runs in a fresh session carrying only its own context.
   * The parent moves to `in-progress` and stays there: it is never auto-completed.
   */
  private approvePlan(
    item: AttentionItem,
    release?: (result: PermissionDecisionResult) => void,
    note?: string,
  ): void {
    const parent = this.store.getTask(item.taskId);
    if (!parent) return;
    const steps = splitPlanIntoSteps(parent.agentPlan ?? item.plan ?? '');
    // Existing steps win: a re-approval (or a hand-written breakdown) must not duplicate
    // the chain. `splitPlanIntoSteps` never returns zero for a non-empty plan, so an
    // empty result here means there was no plan to run at all.
    const existing = this.store.getSubtasks(parent.id);
    if (existing.length === 0) {
      for (const step of steps) {
        this.store.addSubtask(parent.id, { title: step.title, description: step.description });
      }
    }
    // An approval note is the human's own guidance — filed on the card, where every
    // step's prompt picks it up.
    if (note) this.store.addComment(parent.projectId, parent.id, note);

    // Hand over: stop the planner rather than let it implement what it just planned.
    release?.({ behavior: 'deny', message: PLAN_HANDOVER_MESSAGE });
    const run = this.runs.get(item.runId);
    if (run) {
      run.settled = true; // we are deciding this run's outcome, not its exit code
      this.clearRunAttention(run.runId);
      this.sessions.stop(run.runId);
    }
    this.updateTask(parent.id, { status: 'in-progress' }, null);
    this.tasksChanged?.(parent.projectId);
    // Step 1 shares the planner's worktree, so it waits for that process to be gone
    // (`exited` drains `chainStarts`). With no live run there is nothing to wait for.
    if (run) this.chainStarts.add(parent.id);
    else this.advanceSubtasks(parent.id);
  }

  /**
   * Start the next `pending` step of a card's chain, in order. Called when a step
   * finishes and when an approved plan hands over. Strictly one at a time: a step that
   * failed (and is parked in the inbox) leaves its siblings pending until the human
   * resolves it, which is what stops a broken chain from running to the end.
   */
  private advanceSubtasks(parentId: string): void {
    if (this.disposed) return;
    // A usage limit holds ALL scheduling; the chain resumes when the human runs the
    // card again (the parked step, not this one, is what the gate knows about).
    if (this.limitGate.active) return;
    const parent = this.store.getTask(parentId);
    if (!parent || parent.status === 'stopped' || parent.status === 'cancelled') return;
    const next = this.store
      .getSubtasks(parentId)
      .find((t) => t.status === 'pending' && !this.inFlight.has(t.id));
    if (!next) return;
    const project = this.runProjectFor(next);
    if (!project) return;
    this.startTask(project, next);
  }

  /** True when a step of this chain other than `exceptTaskId` is still waiting to run. */
  private hasPendingSibling(parentId: string, exceptTaskId: string): boolean {
    return this.store
      .getSubtasks(parentId)
      .some((t) => t.id !== exceptTaskId && t.status !== 'done' && t.status !== 'cancelled');
  }

  /**
   * The final step of a plan merged: leave the parent **In Progress** with a
   * ready-for-review note. The human moves it to Done — the orchestrator never closes
   * a ticket it worked on, and never touches the tracker.
   */
  private finishParentChain(subtaskId: string): void {
    const subtask = this.store.getTask(subtaskId);
    if (!subtask?.parentTaskId) return;
    const parent = this.store.getTask(subtask.parentTaskId);
    if (!parent) return;
    this.store.addComment(parent.projectId, parent.id, PLAN_REVIEW_NOTE);
    if (parent.status !== 'in-progress') {
      this.updateTask(parent.id, { status: 'in-progress' }, null);
    }
    this.tasksChanged?.(parent.projectId);
  }

  // ---- Cross-agent negotiation coordinator (Phase D) ----------------------

  /**
   * True while a run has an unresolved proposal it raised — through the voting round,
   * escalation, and a concluded-but-undelivered decision, right up until
   * `performResume` deletes it. The proposer must never settle in that window.
   */
  private isNegotiatingProposer(runId: string): boolean {
    for (const proposal of this.pendingProposals.values()) {
      if (proposal.proposerRunId === runId) return true;
    }
    return false;
  }

  /**
   * A running agent proposed a change to the shared contract (Phase D). Park it and
   * open a single consensus round: find its affected in-flight teammates (same
   * milestone; narrowed by CONTRACT.md file-ownership, else all of them), ask each to
   * AGREE/OBJECT, and bound the wait. With no teammate to consult the change is
   * vacuously agreed and the proposer is told to update CONTRACT.md right away.
   */
  private startProposal(run: Run, proposal: DetectedProposal): void {
    // One active proposal per proposer run — ignore repeat markers in the same wait.
    if ([...this.pendingProposals.values()].some((p) => p.proposerRunId === run.runId)) return;
    const project = this.store.getProject(run.projectId);
    const task = this.store.getTask(run.taskId);
    if (!project || !task) return;

    // Candidate voters: other in-flight runs in the same project + milestone (phase).
    const candidates = [...this.runs.values()]
      .filter((r) => r.runId !== run.runId && r.projectId === run.projectId && !r.settled)
      .map((r) => ({ run: r, task: this.store.getTask(r.taskId) }))
      .filter((c): c is { run: Run; task: Task } => !!c.task && c.task.phase === task.phase);

    // Narrow to the teammates the proposed files touch (best-effort via CONTRACT.md
    // ownership); the helper falls back to all siblings when it can't tell.
    const affectedTitles = siblingsAffectedByProposal(
      proposal.files,
      this.readOwnership(project),
      candidates.map((c) => c.task.title),
    );
    const affected = candidates.filter((c) => affectedTitles.includes(c.task.title));

    this.noteRun(
      run.projectId,
      run.taskId,
      run.runId,
      `Proposed a shared-contract change: ${proposal.text}`,
    );

    const pending: PendingProposal = {
      id: randomUUID(),
      projectId: run.projectId,
      phase: task.phase,
      proposerTaskId: run.taskId,
      proposerRunId: run.runId,
      text: proposal.text,
      files: proposal.files,
      siblings: affected.map((c) => ({
        taskId: c.task.id,
        runId: c.run.runId,
        title: c.task.title,
        position: 'pending' as const,
      })),
      proposerReady: false,
    };
    this.pendingProposals.set(pending.id, pending);
    // Park the proposer; its session stays alive (guarded in the result handler).
    this.updateTask(run.taskId, { status: 'waiting-input' }, run.runId);

    if (pending.siblings.length === 0) {
      // No one to consult — vacuous consensus, apply immediately.
      this.applyConsensus(pending);
      return;
    }
    for (const sibling of pending.siblings) this.sendProposalToSibling(sibling, pending);
    pending.timer = setTimeout(() => this.onProposalTimeout(pending.id), NEGOTIATION_TIMEOUT_MS);
  }

  /** Parse the base tree's CONTRACT.md ownership map (empty when absent/unparseable). */
  private readOwnership(project: Project): OwnershipEntry[] {
    try {
      return parseFileOwnership(readFileSync(join(project.path, 'CONTRACT.md'), 'utf8'));
    } catch {
      return [];
    }
  }

  /** Deliver a proposal to one affected teammate, asking it to vote. */
  private sendProposalToSibling(sibling: ProposalSibling, proposal: PendingProposal): void {
    this.sessions.send(
      sibling.runId,
      [
        `A teammate working in parallel on this milestone proposes a change to the shared`,
        `approach:`,
        ``,
        `"${proposal.text}"`,
        ``,
        `If you AGREE, reply with a line starting "${AGREE_SENTINEL}". If you OBJECT, reply`,
        `with a line starting "${OBJECT_SENTINEL}" followed by a short reason. Then carry on`,
        `with your current work.`,
      ].join('\n'),
    );
  }

  /**
   * Record a teammate's AGREE/OBJECT vote against the proposal it belongs to, and
   * conclude the round if that was the last outstanding vote. Returns whether the run
   * was a voter at all (so the caller knows the message was a vote, not a question).
   */
  private recordProposalResponse(runId: string, response: DetectedResponse): boolean {
    for (const proposal of this.pendingProposals.values()) {
      const sibling = proposal.siblings.find((s) => s.runId === runId);
      if (!sibling) continue;
      // A late vote after escalation changes nothing (the human is deciding) but is
      // still consumed as a vote, not surfaced as a question.
      if (!proposal.itemId) {
        sibling.position = response.position;
        sibling.reason = response.reason || undefined;
        this.maybeConcludeProposal(proposal);
      }
      return true;
    }
    return false;
  }

  /** Conclude a round once every affected teammate has voted. */
  private maybeConcludeProposal(proposal: PendingProposal): void {
    if (proposal.itemId) return; // already escalated to a human
    if (proposal.siblings.some((s) => s.position === 'pending')) return; // still voting
    this.concludeProposal(proposal, false);
  }

  /** The consensus round's deadline fired — decide with whatever votes arrived. */
  private onProposalTimeout(id: string): void {
    if (this.disposed) return;
    const proposal = this.pendingProposals.get(id);
    if (!proposal || proposal.itemId) return;
    this.concludeProposal(proposal, true);
  }

  /**
   * Tally the round: unanimous agreement auto-applies the proposal; any objection —
   * or, on timeout, a non-responder counted as an objection — escalates to the human.
   */
  private concludeProposal(proposal: PendingProposal, timedOut: boolean): void {
    this.clearProposalTimer(proposal);
    if (!timedOut && proposal.siblings.some((s) => s.position === 'pending')) return; // safety
    const positions = proposal.siblings.map((s) =>
      s.position === 'pending' ? 'object' : s.position,
    );
    if (tallyConsensus(positions) === 'agree') this.applyConsensus(proposal);
    else this.escalateProposal(proposal, timedOut);
  }

  /** An agreed (or human-accepted) proposal — queue the "update CONTRACT.md" resume. */
  private applyConsensus(proposal: PendingProposal, note?: string): void {
    this.queueResume(proposal, 'accept', note);
  }

  /**
   * Record a concluded decision and deliver it as soon as the proposer is idle. If
   * the proposer's `@@PROPOSE@@` turn has already ended (`proposerReady`), resume now;
   * otherwise `noteProposerResult` picks it up when that turn's `result` lands — so we
   * never inject into (and then prematurely settle over) a still-running turn.
   */
  private queueResume(proposal: PendingProposal, kind: 'accept' | 'keep', note?: string): void {
    this.clearProposalTimer(proposal);
    proposal.resume = { kind, note };
    if (proposal.proposerReady) this.performResume(proposal);
  }

  /** The proposer's `@@PROPOSE@@`-turn ended: mark it idle and flush any queued decision. */
  private noteProposerResult(runId: string): void {
    for (const proposal of this.pendingProposals.values()) {
      if (proposal.proposerRunId !== runId) continue;
      proposal.proposerReady = true;
      if (proposal.resume) this.performResume(proposal);
      return;
    }
  }

  /**
   * Deliver a concluded decision to the (now-idle) proposer and end the negotiation:
   * on `accept`, tell it to update CONTRACT.md and nudge each in-flight teammate to
   * re-read; on `keep`, tell it to proceed without the change. Resumes the task and
   * drops the proposal.
   */
  private performResume(proposal: PendingProposal): void {
    const decision = proposal.resume;
    if (!decision) return;
    if (decision.kind === 'accept') {
      this.sessions.send(
        proposal.proposerRunId,
        [
          `Your teammates agreed to your proposal. Update CONTRACT.md at the repository`,
          `root to reflect it and commit the change, then continue with your task.`,
          ...(decision.note ? [`Human note: ${decision.note}`] : []),
        ].join('\n'),
      );
      for (const sibling of proposal.siblings) {
        this.sessions.send(
          sibling.runId,
          `The shared contract (CONTRACT.md) is being updated per an agreed proposal. Re-read it before continuing.`,
        );
      }
      this.noteRun(
        proposal.projectId,
        proposal.proposerTaskId,
        proposal.proposerRunId,
        'Proposal accepted; contract update requested and teammates notified.',
      );
    } else {
      this.sessions.send(
        proposal.proposerRunId,
        [
          `The team kept the current contract. Proceed with your task WITHOUT the proposed`,
          `change; honor CONTRACT.md as it stands.`,
          ...(decision.note ? [`Human note: ${decision.note}`] : []),
        ].join('\n'),
      );
      this.noteRun(
        proposal.projectId,
        proposal.proposerTaskId,
        proposal.proposerRunId,
        'Proposal declined; current contract kept.',
      );
    }
    this.updateTask(proposal.proposerTaskId, { status: 'running' }, proposal.proposerRunId);
    this.pendingProposals.delete(proposal.id);
  }

  /** Raise a `proposal` inbox item so the human breaks a stalled/contested round. */
  private escalateProposal(proposal: PendingProposal, timedOut = false): void {
    this.clearProposalTimer(proposal);
    const positions = proposal.siblings
      .map((s) => {
        if (s.position === 'agree') return `- ${s.title}: agreed`;
        if (s.position === 'object') {
          return `- ${s.title}: objected${s.reason ? ` (${s.reason})` : ''}`;
        }
        return `- ${s.title}: no response`;
      })
      .join('\n');
    const task = this.store.getTask(proposal.proposerTaskId);
    const prompt = [
      `A teammate proposed a change to the shared contract, but the team ${
        timedOut ? 'did not all respond in time' : 'did not reach consensus'
      }:`,
      ``,
      `Proposal: ${proposal.text}`,
      ``,
      `Teammates:`,
      positions,
      ``,
      `Accept it (the proposer updates CONTRACT.md and everyone re-reads it) or keep the`,
      `current contract (the proposer proceeds without the change).`,
    ].join('\n');
    const item: AttentionItem = {
      id: randomUUID(),
      runId: proposal.proposerRunId,
      taskId: proposal.proposerTaskId,
      projectId: proposal.projectId,
      taskTitle: task?.title ?? '(unknown task)',
      kind: 'proposal',
      prompt,
      options: [PROPOSAL_ACTION.accept, PROPOSAL_ACTION.keep],
      toolName: null,
      reason: null,
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    proposal.itemId = item.id;
    this.updateTask(proposal.proposerTaskId, { status: 'waiting-input' }, proposal.proposerRunId);
    this.emitAttention(item);
  }

  /** Apply the human's decision on an escalated proposal (the item is already cleared). */
  private applyProposalDecision(proposal: PendingProposal, choice: string, note?: string): void {
    switch (choice) {
      case PROPOSAL_ACTION.accept:
        this.queueResume(proposal, 'accept', note);
        break;
      case PROPOSAL_ACTION.keep:
        this.queueResume(proposal, 'keep', note);
        break;
      default:
        // Unrecognized (free-text) answer — re-escalate so the decision isn't lost.
        proposal.itemId = undefined;
        this.escalateProposal(proposal);
        break;
    }
  }

  /** Clear a proposal's consensus-round timer if one is armed. */
  private clearProposalTimer(proposal: PendingProposal): void {
    if (proposal.timer) {
      clearTimeout(proposal.timer);
      proposal.timer = undefined;
    }
  }

  /** Append a synthetic assistant note to a task's transcript (integration outcomes). */
  private noteRun(projectId: string, taskId: string, runId: string, text: string): void {
    this.store.appendTaskEvent(projectId, taskId, runId, { kind: 'assistant', text });
  }

  /**
   * Finish integrating after a human resolved a rebase conflict in the worktree:
   * continue the rebase + fast-forward. Still conflicted → re-park; otherwise apply
   * the same outcomes as the initial attempt.
   */
  private async finishConflict(pending: PendingIntegration): Promise<void> {
    const project = this.store.getProject(pending.projectId);
    if (!project) return;
    const ctx = {
      taskId: pending.taskId,
      runId: pending.runId,
      branch: pending.branch,
      base: pending.base,
      worktree: pending.worktree,
    };
    const result = await this.worktrees!.finishAfterConflict(
      project,
      pending.branch,
      pending.base,
      pending.worktree,
    );
    if (this.disposed) return;
    this.applyIntegrationResult(project, ctx, result);
  }

  private maybeWriteBackPlan(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const project = this.store.getProject(task.projectId);
    if (!project || !project.writeBackPlan) return;

    try {
      const markdown = readFileSync(project.planPath, 'utf8');
      const updated = tickPlanCheckbox(markdown, task.phase, task.title);
      if (updated !== null) writeFileSync(project.planPath, updated);
    } catch {
      // A missing/unwritable plan file is non-fatal — the task still counts as done.
    }
  }

  private updateTask(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'sessionId' | 'agentPlan'>>,
    runId: string | null,
  ): void {
    const task = this.store.updateTask(taskId, patch);
    if (task) this.emitTask({ task, runId });
  }

  private runningCount(projectId: string): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.projectId === projectId) n++;
    return n;
  }

  private setState(projectId: string, state: SchedulerState): void {
    this.states.set(projectId, state);
    this.emitScheduler({ projectId, state });
  }
}
