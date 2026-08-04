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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  ChatRefusal,
  ChatSendResult,
  Project,
  Task,
  TaskActivityEntry,
  TaskStatus,
} from '@shared/model';
import { resolveRunModel } from '@shared/model';
import { chainInFlight, chatTarget, parkedStep } from '@shared/board';
import { attachmentsInScope, type PromptAttachment } from '@shared/attachments';
import type { SchedulerState, TaskChange, SchedulerChange, ActiveRun } from '@shared/scheduler';
import type {
  ClaudeModel,
  PermissionMode,
  SessionEvent,
  StartSessionRequest,
} from '@shared/session';
import type {
  AttentionAnswer,
  AttentionItem,
  AttentionKind,
  AttentionQuestion,
} from '@shared/attention';
import {
  DECLINED_ANSWER_MESSAGE,
  describeQuestions,
  formatAnswerMessage,
  isAskUserQuestionTool,
  parseAskUserQuestion,
} from './askUserQuestion';
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
  buildReplanPrompt,
  type AgentPromptComment,
} from './agentTaskPrompt';
import { attachmentFile } from './attachmentPaths';
import {
  NOTES_CHAR_BUDGET,
  TICKET_COMMENT_CHAR_BUDGET,
  boundEntries,
  boundHistory,
  type BoundedHistory,
} from './promptHistory';
import { guardCardStatus, humanStatusPatch } from './cardStatusGuard';
import { ChainRunner, type ChainTrigger } from './chainRunner';
import type { PermissionGate } from './claudeSession';
import { buildChainHandbackPrompt, buildChainSummary } from './chainSummary';
import { shouldSurfaceEvent } from './eventNoise';
import { isBlockingLimitStatus, LimitGate } from './limitGate';
import type { PermissionRequest, PermissionDecisionResult } from './permissionBroker';
import { EXIT_PLAN_MODE_TOOL, evaluateToolUse } from './permissionPolicy';
import { tickPlanCheckbox } from './planParser';
import { buildReleasePrompt } from './releasePrompt';
import { autoIntegrateOn } from '@shared/integrate';
import { autoReleaseOn, RELEASE_DOC } from '@shared/release';
import {
  extractPlanMarkdown,
  splitPlanIntoSteps,
  stepsToAppend,
  MAX_PLAN_STEPS,
  type PlanStep,
} from './planToSubtasks';
import type { SessionManager } from './sessionManager';
import { hostFor } from './exec';
import { appPlanPath, appProjectFile, planRelPath } from './projectPaths';
import type { Store } from './store';
import { taskBranch } from './worktreeManager';
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
 * Sent to Claude when the human DISMISSES the ask instead of answering it (closing the
 * card, or pressing Dismiss on one that is shouting). The held tool has to be released
 * either way — a CLI process parked on that HTTP request never exits on its own — and a
 * deny is the only honest release: nobody approved anything.
 */
const DISMISSED_MESSAGE =
  'The human dismissed this request without answering it — they are done with this task. ' +
  'Do not perform the action, and do not ask again: stop and explain where you got to.';

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

/**
 * No ticket thread at all — a step of a plan, an internal card, a tracker that was down.
 * Distinct from "a thread we trimmed": `omitted` is 0, so no prompt claims history it never
 * had. Frozen because it is shared by every such run.
 */
const NO_COMMENTS: BoundedHistory<AgentPromptComment> = Object.freeze({
  kept: [] as AgentPromptComment[],
  omitted: 0,
});

/** The nudge sent to a session we resume after a usage limit clears (Phase 5). */
const RESUME_NUDGE =
  'A usage limit interrupted you and it has now reset. Continue the task where you left off.';

/**
 * Sent to a session we RESUME for a retry that carries a failure note — an "AI fix &
 * retry" resolution, or a rebase conflict the agent is asked to resolve (Rung 2).
 *
 * The conversation being rejoined already holds the ticket, its thread and the human's
 * notes, so the full brief re-sent all of it to say one new thing (token audit, S2). The
 * note IS the only new thing; the framing matches the `failureNote` block the full brief
 * would have rendered, so an agent reads the same instruction either way.
 */
function resumeWithNotePrompt(note: string): string {
  return [
    'The previous attempt at this task failed. The reported reason was:',
    `"${note}"`,
    'Diagnose why it failed and fix the underlying cause, then carry on from where you',
    'left off — you already have this task and its context in this conversation.',
  ].join('\n');
}

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
  /**
   * Stop asking. The branch and its worktree are kept exactly as they are; the card
   * simply stops holding an inbox item about them.
   *
   * This exists because "Retry integration" was the only real option on a failure whose
   * cause is usually outside the app (a dirty base tree, a conflict a human must settle),
   * so retrying failed the same way and parked the same ask again — a loop with no exit
   * that did not involve abandoning the work.
   */
  leaveBranch: 'Leave the branch (stop asking)',
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
  FAILURE_ACTION.leaveBranch,
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

/**
 * The permission mode a RELEASE run gets (see `@shared/release`).
 *
 * Everything else about a release run inherits the card, but not this: `plan` mode may
 * read and nothing else, so a card assigned it — which is most planned cards — would get a
 * release that reads `RELEASE.md` and then cannot follow a single line of it. The fallback
 * ladder is the project's own default, then `acceptEdits`. Pure, so the ladder is testable.
 */
export function releaseMode(
  task: Pick<Task, 'agentMode'>,
  project: Pick<Project, 'defaultPermissionMode'>,
): PermissionMode {
  const chosen = task.agentMode ?? project.defaultPermissionMode;
  if (chosen && chosen !== 'plan') return chosen;
  return project.defaultPermissionMode !== 'plan' ? project.defaultPermissionMode : 'acceptEdits';
}

/** The `result` fields this judgement needs — a slice, so tests need no full event. */
type SettledResult = Pick<
  Extract<SessionEvent, { kind: 'result' }>,
  'resultText' | 'stopReason' | 'terminalReason' | 'usage'
>;

/**
 * Why a run that reported success actually produced nothing — or null when it is a real
 * outcome. Pure, so both rules are testable without a CLI (Phase 18).
 *
 * Two runs of this app burned ~$1.70 and 50 tool calls each and were filed as successes,
 * because the CLI's verdict is about whether the TURN ended cleanly, not about whether the
 * work happened. What the human saw was "Finished on branch…" and an empty branch.
 *
 *  1. **The session never ran a turn.** No stop reason of any kind, no tokens on the
 *     clock, nothing said. The model was never called — this is a process that started and
 *     died, and it is what a chat resume looked like when it silently did nothing.
 *  2. **A plan-mode run that never presented a plan** — but only when producing a plan was
 *     the job. Ending `end_turn` without one is then a failure whatever the CLI thinks. See
 *     {@link Run.planPresented} for why the run's flag, and not the task's stored plan, is
 *     what answers this, and {@link Run.expectsPlan} for why the mode alone cannot.
 *
 * The wording is what lands on the card, so each reason says what to do about it.
 */
export function describeEmptyOutcome(
  permissionMode: PermissionMode | undefined,
  planPresented: boolean | undefined,
  event: SettledResult,
  /**
   * Whether a plan was this run's job at all. Defaults to true, which is right for an
   * ordinary work run: on a card assigned `plan`, planning IS the work.
   *
   * It is false for a conversation — a chat reply, a post-chain review — that merely
   * INHERITED the card's mode. Those legitimately end with an answer and no plan, and
   * judging them by this rule failed them unconditionally, however good the answer was.
   */
  expectsPlan = true,
): string | null {
  // Deliberately `usage` PRESENT and zero, not merely absent. The CLI omits the field in
  // some shapes, and an omission is not evidence — reading it as one would misfile
  // perfectly good runs as dead. The sessions this catches reported an explicit
  // `{0, 0, 0, 0}`, which is the CLI saying the model was never called.
  const usage = event.usage;
  const spentNothing =
    !!usage &&
    usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens ===
      0;
  if (!event.stopReason && !event.terminalReason && spentNothing && !event.resultText.trim()) {
    return 'the session ended without running a turn — nothing was sent to the model';
  }
  if (expectsPlan && permissionMode === 'plan' && !planPresented) {
    return (
      'the planning session ended without presenting a plan. If it stopped to wait for ' +
      'background subagents, they were discarded when the turn ended — re-run it'
    );
  }
  return null;
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
    /** The project's standing setup instructions, injected into every run. */
    instructions?: string;
    /** (Worktree mode) the absolute working directory this run is isolated in. */
    worktreePath?: string;
    /** The project's canonical directory, which the worktree was branched from. */
    projectPath?: string;
  } = {},
): string {
  const { planRelPath, branch, failureNote, contractSiblings, hasContract } = options;
  const { isScaffold, hasScaffold, worktreePath, projectPath } = options;
  const isContract = contractSiblings !== undefined;
  const instructions = (options.instructions ?? '').trim();
  return [
    `You are working through the plan for the project "${projectName}".`,
    '',
    // Standing setup knowledge first: it often decides HOW every later command runs.
    ...(instructions ? [`Project setup notes you must follow:`, instructions, ''] : []),
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
          // Naming the directory prevents a whole class of silent failure: pointing an
          // external build at the project's main checkout would compile unmodified
          // source and SUCCEED, hiding the fact that none of this work was included.
          ...(worktreePath
            ? [
                '',
                `Your working directory is "${worktreePath}". THIS is the source of truth for`,
                `this task — not${projectPath ? ` "${projectPath}",` : ''} the project's main`,
                `checkout. If you point an external build or tool at this project's sources,`,
                `point it HERE, or it will build code that does not include your changes.`,
              ]
            : []),
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
   *
   * Since Phase 18 the mode can also be a per-TURN override, which is why it must be read
   * from here and never re-derived from the task: a re-plan turn runs in `plan` mode on a
   * card assigned any other mode, and writing that back to `task.agentMode` would make
   * every later run a planning run.
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
  /**
   * (Phase 17) This run only exists to brief the card after its plan finished, so it must
   * skip both halves of the worktree lifecycle: there is nothing to integrate (the chain's
   * branch was merged and deleted) and nothing to isolate (it reads code already in base).
   * Without the flag, `settle` would try to merge a branch that no longer exists and
   * `prepare` would cut a brand-new one for a card whose work is already landed.
   */
  reviewSeed?: boolean;
  /**
   * This run exists to RELEASE work that has just been merged (see `@shared/release`).
   *
   * Shares every reason `reviewSeed` skips the worktree lifecycle — the branch is merged
   * and deleted, and the code to release is the code in base — and adds one of its own:
   * its outcome is about the release, not about the card, so a failure must not retry the
   * card's work or park it as a failed task. It files what happened and stops.
   */
  releaseSeed?: boolean;
  /**
   * Whether this run ever put a plan in front of the human (Phase 18).
   *
   * The check that needs it: a `plan`-mode run exists to produce a plan, so one that ends
   * without ever presenting one did nothing, however cheerfully the CLI reports `end_turn`
   * / `completed`. Two cards burned $1.70 each that way and were filed as successes.
   *
   * A flag rather than "is `task.agentPlan` still null", because null-checking is wrong in
   * both directions: a re-planned card already carries a plan from its previous round, and
   * a plan approved mid-run has already settled this run (`approvePlan`) — a late `result`
   * arriving after that must not be able to mark the card failed.
   */
  planPresented?: boolean;
  /**
   * Whether a plan was this run's JOB — the question {@link planPresented} is graded against.
   *
   * `permissionMode` cannot answer it, because `plan` reaches a run two different ways. A
   * card assigned `plan` passes it to *everything* it ever starts, including a chat reply
   * and the review a finished chain seeds; those are conversations, and a conversation ends
   * with an answer, not a plan. A per-turn `plan` (the "Plan more steps" path) is the other
   * way, and that one really is a planning run.
   *
   * Grading conversations by the planning rule failed them unconditionally: a card's review
   * session delivered a complete, verified branch review and was parked as "the planning
   * session ended without presenting a plan", twice — the retry could not have passed
   * either. Meanwhile the card's work sat finished and unmerged.
   */
  expectsPlan?: boolean;
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
   * Branches that are finished and waiting for a human to merge them (Phase 17), keyed by
   * task id. Populated when a worktree run settles and auto-merge is off FOR THAT CARD
   * (`@shared/integrate` — the card's answer, else its project's, else the app's), and
   * consumed by {@link Scheduler.integrateNow}.
   *
   * In memory rather than persisted: the durable facts are the branch and the worktree,
   * both of which survive on disk. A restart forgets the offer, not the work — and
   * `integrateNow` can rebuild the context from the task, so the button keeps working.
   */
  private readonly readyToIntegrate = new Map<
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
   * Tasks whose branch is being merged **right now**, by task id.
   *
   * The one long-running job that leaves no trace while it runs: rebasing a branch onto a
   * moving base and fast-forwarding it can take a minute, and until it settles there is no
   * session, no status change and no transcript line — so the UI had nothing at all to draw
   * from, and Merge looked like a button that did nothing. Every path into the git work
   * marks the task here and clears it in a `finally`, and each change is pushed whole to
   * the renderer (see {@link Scheduler.setIntegratingNotifier}).
   *
   * In memory, like `readyToIntegrate`: a merge cannot outlive the process that runs it, so
   * a restart correctly forgets it rather than leaving a card spinning forever.
   */
  private readonly integrating = new Set<string>();
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
  /**
   * Cards whose re-planning turn is waiting for their CURRENT run to exit (Phase 18).
   * Same hazard as `chainStarts`: the planner resumes the card's session in the card's
   * worktree, so it must not start while the run it replaced is still shutting down there.
   * Keyed by task id; the value is everything `startTask` will need by then.
   */
  private readonly pendingReplans = new Map<string, { projectId: string; prompt: string }>();
  /**
   * Step ids already covered by a chain hand-back summary, per parent card (Phase 18).
   * A re-planned card finishes a chain once per ROUND, and `buildChainSummary` enumerates
   * whatever it is given — so without this, round 2's hand-back re-tells round 1 as though
   * it had just run. In-memory only: a restart falls back to summarizing the whole chain,
   * which is what every version before re-planning did anyway.
   */
  private readonly summarizedSteps = new Map<string, Set<string>>();
  /** The permission gate handed to every task run (null until the broker is up). */
  private gate: PermissionGate | null = null;
  /**
   * Tells the UI a project's task LIST changed (not just one task's status) — used
   * when approving a plan creates a card's subtasks. Injected by the IPC layer, which
   * owns the renderer channel; null in tests.
   */
  private tasksChanged: ((projectId: string) => void) | null = null;
  /**
   * Tells the UI which branches are mid-merge. Injected by the IPC layer like
   * {@link Scheduler.tasksChanged}; null in tests.
   */
  private integratingChanged: ((taskIds: string[]) => void) | null = null;
  /**
   * Fetches the linked ticket's comments for a delegated card's prompt. Injected by the
   * IPC layer (which owns the JIRA client) so the scheduler stays tracker-agnostic and
   * unit-testable; null in tests and when no tracker is configured.
   */
  private ticketComments: ((task: Task) => Promise<AgentPromptComment[]>) | null = null;
  /**
   * `userData` — the root every attachment path is built under (Phase 22). Injected by the
   * IPC layer, which owns `app.getPath`; null in tests, where a prompt then carries no
   * legend rather than a path assembled from a guess.
   */
  private attachmentRoot: string | null = null;
  /**
   * The account-wide usage-limit gate (Phase 5). When active, ALL scheduling is
   * held; when its timer fires, every parked task resumes by its saved session id.
   */
  private readonly limitGate: LimitGate;
  /**
   * The chain of execution's engine (`@shared/taskChain`): what happens to the NEXT card
   * when this one's work lands. Owned the way `worktrees` is — this class tells it when the
   * world changed and it owns everything that follows, so the release rules live in one
   * file instead of being spread through `settle` and `applyIntegrationResult`.
   */
  private readonly chain: ChainRunner;
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
    this.chain = new ChainRunner({
      // Every dependency is a thunk onto this scheduler's own machinery, so a release is
      // reserved, gated and settled exactly as any other run — there is no second way in.
      links: () => this.store.listTaskLinks(),
      getTask: (id) => this.store.getTask(id),
      setLandedAt: (id, at) => {
        const task = this.store.updateTask(id, { landedAt: at });
        if (task) this.emitTask({ task, runId: null });
      },
      addComment: (projectId, taskId, body) => {
        this.store.addComment(projectId, taskId, body);
        this.tasksChanged?.(projectId);
      },
      runTask: (id) => this.runTask(id) !== null,
      // Written as the HUMAN's move, not the scheduler's: `humanStatusPatch` puts it in
      // `preRunStatus` if a run has already borrowed `status`, and never meets
      // `guardCardStatus`, which would send a bare `in-progress` straight back to where
      // the card came from. Bypasses this class's own `updateTask` for exactly that reason.
      markInProgress: (id) => {
        const before = this.store.getTask(id);
        if (!before) return;
        const task = this.store.updateTask(id, humanStatusPatch(before, 'in-progress'));
        if (task) this.emitTask({ task, runId: null });
      },
      limitActive: () => this.limitGate.active,
      inFlight: (id) => this.inFlight.has(id),
      branchOf: (task) => this.branchFor(task),
      now: () => Date.now(),
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

  /** Wire the "these branches are mid-merge" notifier (see {@link Scheduler.integrating}). */
  setIntegratingNotifier(notify: (taskIds: string[]) => void): void {
    this.integratingChanged = notify;
  }

  /**
   * Wire `userData`, under which attachments live (Phase 22) — the one absolute path this
   * class needs and cannot derive, since `app.getPath` belongs to Electron and the
   * scheduler is unit-tested without it. Optional: unwired, a prompt simply carries no
   * attachment legend (see {@link Scheduler.promptAttachments}).
   */
  setAttachmentRoot(root: string): void {
    this.attachmentRoot = root;
  }

  /** The tasks whose branch is being merged right now — seeds the UI on mount. */
  integratingTaskIds(): string[] {
    return [...this.integrating];
  }

  /**
   * Mark a task's branch as being merged, and say so. Idempotent: the manual path marks it
   * before reading the branch off disk and the merge itself marks it again, so that the
   * seconds spent in `prepare` are not a gap in which the button looks dead again.
   */
  private beginIntegration(taskId: string): void {
    if (this.integrating.has(taskId)) return;
    this.integrating.add(taskId);
    this.integratingChanged?.(this.integratingTaskIds());
  }

  /** The merge settled (merged, conflicted, or refused) — stop saying it is under way. */
  private endIntegration(taskId: string): void {
    if (!this.integrating.delete(taskId)) return;
    this.integratingChanged?.(this.integratingTaskIds());
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

  /**
   * Run a single task ad-hoc, regardless of whether its project's queue is active.
   *
   * **A card with steps runs its CHAIN, not itself.** Steps written by hand were being
   * ignored by this: starting the card started the card's own session with the whole ticket
   * as its brief, so one agent did all the work in one go while the steps sat `pending`
   * forever — the board showed `0/4` for something that had already been built. Approving a
   * plan handed over to the chain correctly (`approvePlan`), so a card broken into steps
   * behaved completely differently depending on who had written them down.
   *
   * Steps ARE the card's work once they exist, however they got there. So the first pending
   * one is what starts, and each subsequent one follows as its predecessor finishes
   * (`advanceSubtasks`) — one session each, which is the whole point of writing steps.
   *
   * The fall-through matters as much as the hand-over: a chain with nothing left `pending`
   * is finished (or parked at a step that needs a human), and then the card's own session is
   * the right thing to start again — that is how the post-chain review conversation is
   * resumed. Only a step actually waiting to run diverts this.
   */
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

    if (!task.parentTaskId) {
      const next = this.store
        .getSubtasks(taskId)
        .find((s) => s.status === 'pending' && !this.inFlight.has(s.id));
      if (next) {
        const stepProject = this.runProjectFor(next);
        // No project resolves for the step (so none would for the card either) — say so by
        // failing rather than quietly running the card and doing the work the wrong way.
        if (!stepProject) return null;
        return { runId: this.startTask(stepProject, next) };
      }
    }

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
  /**
   * Ask a card's agent to plan ANOTHER round of steps (Phase 18).
   *
   * The gap this closes: a card whose chain has finished has no way to grow. Chatting with
   * it resumes an ordinary run, and `buildClaudeArgs` rewrites every mode except `plan` to
   * `default` — so the agent has no `ExitPlanMode` tool, writes its plan as prose in the
   * reply, and nothing is ever captured or approved. The human sees an answer and no steps.
   *
   * So this is deliberately NOT `chatWithAgent` with a different prompt. Two things differ,
   * and both matter:
   *   - it targets the CARD, never `chatTarget`'s live step: a plan is about the whole
   *     chain, and a step has no authority to extend the card it belongs to; and
   *   - it forces `plan` mode for this ONE turn, whatever the card is assigned, without
   *     touching `task.agentMode` — which would otherwise make every later run a planner.
   *
   * A live run on the card (normally the review session `finishParentChain` seeded, i.e.
   * exactly the conversation the human is typing into) is stopped first and the planner
   * deferred until its process is gone — same reason `chainStarts` exists: both runs share
   * the card's worktree, and `--resume` against a session still shutting down is a race.
   */
  replanCard(taskId: string, note?: string): ChatSendResult {
    const refused = (reason: ChatRefusal): ChatSendResult => ({
      status: 'refused',
      taskId,
      reason,
    });
    if (this.disposed) return refused('not-running');
    const card = this.store.getTask(taskId);
    if (!card) return refused('unknown-task');
    // A step cannot own a plan: it IS one unit of its parent's.
    if (card.parentTaskId) return refused('not-a-card');
    if (!card.agentProjectId) return refused('never-ran');
    if (this.limitGate.active || card.status === 'blocked-by-limit') return refused('limit');

    const steps = this.store.getSubtasks(card.id);
    // A chain still working owns the card's worktree and its own sequence; planning more
    // work on top of it would queue steps behind an outcome nobody has seen yet.
    if (chainInFlight(steps)) return refused('chain-busy');
    const slotsLeft = MAX_PLAN_STEPS - steps.length;
    if (slotsLeft <= 0) return refused('chain-full');

    const project = this.runProjectFor(card);
    if (!project) return refused('never-ran');

    const prompt = buildReplanPrompt(
      card.title,
      steps.map((s) => s.title),
      { note, slotsLeft },
    );
    // Filed before anything starts, so the timeline records the ask even if the run dies on
    // spawn — and so the human can see what they asked for while the planner is thinking.
    if (note?.trim()) this.store.addChatMessage(card.projectId, card.id, note.trim());

    // A live run on the card has to end before the planner can resume its session in the
    // same worktree. `exited` drains the map (beside `chainStarts`, for the same reason).
    const live = [...this.runs.values()].find((r) => r.taskId === card.id && !r.settled);
    if (live) {
      live.settled = true; // we are deciding this run's outcome, not its exit code
      this.clearRunAttention(live.runId);
      this.sessions.stop(live.runId);
      this.pendingReplans.set(card.id, { projectId: project.id, prompt });
      return { status: 'resumed', taskId: card.id, runId: live.runId };
    }
    // Reserved elsewhere (a run spawning right now) — refuse rather than double-run a task.
    if (this.inFlight.has(card.id)) return refused('not-running');

    return {
      status: 'resumed',
      taskId: card.id,
      runId: this.startTask(project, card, { chatPrompt: prompt, permissionMode: 'plan' }),
    };
  }

  /** Start a re-plan whose predecessor run has now exited. See {@link replanCard}. */
  private startPendingReplan(taskId: string): void {
    const pending = this.pendingReplans.get(taskId);
    if (!pending) return;
    this.pendingReplans.delete(taskId);
    if (this.disposed || this.limitGate.active) return;
    const task = this.store.getTask(taskId);
    const project = this.store.getProject(pending.projectId);
    if (!task || !project || this.inFlight.has(taskId)) return;
    this.startTask(project, task, { chatPrompt: pending.prompt, permissionMode: 'plan' });
  }

  private resumeForChat(target: Task, text: string): ChatSendResult {
    const refused = (reason: ChatRefusal): ChatSendResult => ({
      status: 'refused',
      taskId: target.id,
      reason,
    });
    if (this.disposed) return refused('not-running');
    if (this.limitGate.active || target.status === 'blocked-by-limit') return refused('limit');

    // An assigned-but-not-started card (Phase 17) has no conversation to continue — but it
    // has everything a FIRST one needs: an agent project, a mode, a model and a brief. So
    // the first message to it STARTS the agent, with what was typed as the opening
    // instruction. Refusing here would make "assign without starting" a dead end: you could
    // stage a run but never talk to it.
    if (!target.sessionId) {
      if (!target.agentProjectId) return refused('never-ran');
      const staged = this.runProjectFor(target);
      if (!staged) return refused('never-ran');
      if (!target.parentTaskId && chainInFlight(this.store.getSubtasks(target.id))) {
        return refused('chain-busy');
      }
      // Filed as a COMMENT, not a chat line: with no session there is nothing to resume, so
      // this has to be a fresh full brief, and `buildAgentTaskPrompt` reads the timeline's
      // comments (`taskNotes`) to assemble one.
      this.store.addComment(target.projectId, target.id, text);
      const startedRunId = this.startTask(staged, target);
      return { status: 'resumed', taskId: target.id, runId: startedRunId };
    }
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
    // stoppable: there is queued work even though nothing is running. A step held behind
    // the usage-limit gate counts for the same reason as a parked card does — it would
    // otherwise start by itself at the reset, after the human said stop.
    if (
      this.chainStarts.has(taskId) ||
      steps.some((s) => s.status === 'pending' || s.status === 'blocked-by-limit')
    ) {
      stopped = true;
    }
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
    // Stopping the card also cancels a re-plan queued behind the run being stopped —
    // otherwise the planner would spring to life the moment that process exits (Phase 18).
    this.pendingReplans.delete(taskId);
    const queuedSteps = this.store
      .getSubtasks(taskId)
      .filter((s) => s.status === 'pending' || s.status === 'blocked-by-limit');
    for (const step of queuedSteps) this.updateTask(step.id, { status: 'stopped' }, null);
    // A limit-parked task counts as stoppable too: drop it — and any step of its chain the
    // gate is holding — so nothing is resurrected when the limit resets.
    this.limitGate.unpark([taskId, ...queuedSteps.map((s) => s.id)]);
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
      // An auxiliary run (e.g. "Align plan") edits files in the project directory,
      // so it has to run on the same machine those files live on.
      host: hostFor(this.store.getProject(projectId)?.target),
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

  /**
   * Snapshot of executing tasks, so the Board can attach live transcripts on load.
   *
   * **Settled runs are excluded.** `settled` means the outcome is already decided — the
   * turn produced its `result`, or Stop chose for it — and what is left is a process
   * winding down. It stays in `runs` because `exited` still has bookkeeping to do (free the
   * slot, pump the queue, advance a chain), but reporting it as active is wrong twice over:
   *
   * The UI reads this snapshot to spot a run that exists before its task says `running`,
   * and shows "Starting…" for it. A settled run is the opposite of starting. That is how a
   * card came to spin "Starting…" directly underneath the chat line saying "The agent
   * finished this turn" — the result had landed, the process had not yet gone, and the
   * window between the two is as long as it takes the CLI to die (it holds stdin open, so
   * it never exits on its own).
   *
   * A terminal status now overrules the snapshot in `runPhase`, but that cannot cover this:
   * a review seed settles to `in-progress`, which is not terminal, so the snapshot was
   * still the deciding vote.
   */
  activeRuns(): ActiveRun[] {
    return [...this.runs.values()]
      .filter((r) => !r.settled)
      .map((r) => ({ taskId: r.taskId, runId: r.runId }));
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
    // What the DB says is parked, which is the authority — the saved gate is only what the
    // engine happened to remember. The two can disagree in both directions (a task parked
    // in the instant before the app went down; a gate written before the status was), and
    // either way the task is the thing left `blocked-by-limit`, so it is what we go by.
    const parked = this.store
      .listProjects()
      .flatMap((project) => this.store.getTasks(project.id))
      .filter((task) => task.status === 'blocked-by-limit');

    if (!saved) {
      // Nothing will ever raise these again: no gate, no timer, no reset to wait for. They
      // are the cards that "never came back" after a limit — resume them now, the same way
      // the reset would have. (Should the limit somehow still be in force, the first run to
      // hit the wall simply raises a fresh gate and parks them again.)
      if (parked.length > 0) {
        this.resumeParked({
          limitType: 'rolling',
          resetsAt: null,
          resumeAt: Date.now(),
          parkedTaskIds: parked.map((task) => task.id),
        });
      }
      return;
    }
    const known = new Set(saved.parkedTaskIds);
    const adopted = parked.filter((task) => !known.has(task.id)).map((task) => task.id);
    this.limitGate.restore(
      adopted.length > 0
        ? { ...saved, parkedTaskIds: [...saved.parkedTaskIds, ...adopted] }
        : saved,
    );
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
        // A rehydrated inbox item is the reason this task is parked, and it is still
        // answerable. Sweeping it to `pending`/`failed` would leave the board and the
        // inbox saying different things about the same card.
        if (this.hasAttentionForTask(task.id)) continue;
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
   * **Ask the chain again**: start every chained card whose predecessors are already
   * satisfied but which nobody ever released (`@shared/taskChain`).
   *
   * Unlike {@link Scheduler.reconcileInterruptedTasks} this heals nothing — the DB is
   * perfectly consistent, it is just that nobody was listening at the moment the gate
   * opened. That it is safe to ask at ANY moment, and repeatedly, is a consequence of
   * `landedAt` being persisted: the question has the same answer it had a second ago, so a
   * card that was already released is not released twice (it has a session by then, and
   * this only starts cards that have never run).
   *
   * `trigger` is what made the moment worth asking at, and the only thing that reaches the
   * card's timeline — see {@link ChainTrigger}. Boot is one caller among several; the
   * others are the usage limit lifting (below, in {@link Scheduler.resumeParked}) and the
   * board's own chain edits.
   */
  reconsiderChains(trigger: ChainTrigger): void {
    if (this.disposed) return;
    this.chain.reconsider(trigger);
  }

  /**
   * A card's work landed somewhere the engine did not do the merging — a linked merge
   * request that GitLab now reports as `merged` (see `gitlab/gitlabSync`).
   *
   * The same fact as the local integrate path, arriving by a different road, and it needs no
   * setting of its own: a local-only project simply has no merge-request rows, so nothing
   * ever calls this for one. Idempotent, which matters here — the sync repeats the verdict
   * on every poll for as long as the MR is retained.
   */
  noteWorkLanded(taskId: string): void {
    if (this.disposed) return;
    this.chain.landed(taskId);
  }

  /**
   * Start a blocked card despite its chain (the detail pane's **Release now**). Returns why
   * it could not start, or null once a run is under way. See {@link ChainRunner.releaseNow}.
   */
  releaseChainNow(taskId: string): string | null {
    if (this.disposed) return 'The app is shutting down.';
    return this.chain.releaseNow(taskId);
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

    // A question for the HUMAN is not a risk decision, so `bypassPermissions` does not
    // cover it and this must sit ABOVE the shortcut below. "Never ask me to approve tools"
    // is not "answer my questions for me" — and full-auto is precisely the mode in which
    // nobody is watching the agent quietly pick its own recommended option.
    if (isAskUserQuestionTool(request.toolName)) {
      const questions = parseAskUserQuestion(request.input);
      const item = this.raiseAttention(run, {
        kind: 'agent-question',
        prompt: describeQuestions(questions),
        toolName: request.toolName,
        reason: null,
        questions,
      });
      return new Promise<PermissionDecisionResult>((resolve) => {
        this.pendingDecisions.set(item.id, { runId: request.runId, input: request.input, resolve });
      });
    }

    // A finished plan gets its own inbox kind rather than a generic permission prompt:
    // the human is approving a BREAKDOWN (which becomes subtasks), not a tool call. The
    // tool stays blocked meanwhile, so the agent can't slide from planning to editing.
    //
    // Sits ABOVE the `bypassPermissions` shortcut for the same reason `AskUserQuestion`
    // does: this is not a risk decision. "Never ask me to approve tools" is not "throw away
    // the plan an agent spent a whole session producing" — but that is what it used to
    // mean, since `capturePlan` stored the markdown and the shortcut then allowed the call
    // with nothing ever raised, leaving a plan-mode full-auto card unable to gain a single
    // step. `ExitPlanMode` mutates nothing, so holding it costs a pause and no more.
    if (request.toolName === EXIT_PLAN_MODE_TOOL) {
      const item = this.raisePlanApproval(run);
      return new Promise<PermissionDecisionResult>((resolve) => {
        this.pendingDecisions.set(item.id, { runId: request.runId, input: request.input, resolve });
      });
    }

    const project = this.store.getProject(run.projectId);
    const mode = run.permissionMode ?? project?.defaultPermissionMode;
    if (mode === 'bypassPermissions') {
      return Promise.resolve({ behavior: 'allow', updatedInput: request.input });
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

    if (item.kind === 'agent-question') {
      // The held tool. `deny` is the only channel that carries TEXT back as the tool's
      // result — `allow` would run the tool, which is the bug: headless, the CLI would
      // answer itself. Absent only on the observational fallback path (the tool already
      // ran), where the answer goes into the input stream instead.
      const pending = this.pendingDecisions.get(itemId);
      this.pendingDecisions.delete(itemId);
      this.resolveAttention(itemId);

      const questions = item.questions ?? [];
      const note = 'note' in answer ? answer.note?.trim() : undefined;
      let message: string;
      if (answer.decision === 'answers') {
        message = formatAnswerMessage(questions, answer.selections, answer.freeText, note);
      } else if (answer.decision === 'reply') {
        message = formatAnswerMessage(questions, [[answer.text]], undefined, note);
      } else {
        // An explicit "you decide". The agent only ever gets to choose because a human
        // said so — never because nobody looked in time.
        message = note ? `${DECLINED_ANSWER_MESSAGE}\n\n${note}` : DECLINED_ANSWER_MESSAGE;
      }

      if (pending) pending.resolve({ behavior: 'deny', message });
      else this.deliverOrResume(item, message);

      if (!this.hasPendingAttention(item.runId)) {
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
      // A question: deliver the human's reply into the open input stream — or, for an item
      // restored after a restart, resume the conversation with it.
      const text =
        answer.decision === 'reply' ? answer.text : ('note' in answer && answer.note) || '';
      this.deliverOrResume(item, text);
    }

    this.resolveAttention(itemId);
    // If nothing else is parked on this run, it is live again.
    if (!this.hasPendingAttention(item.runId)) {
      this.updateTask(item.taskId, { status: 'running' }, item.runId);
    }
  }

  /**
   * Drop everything the inbox is holding for a card **and its steps**, without answering
   * any of it. Returns how many items went.
   *
   * Two callers, one meaning — "the human is finished with this card": closing it (a drop
   * into DONE, or the status dropdown) and the detail pane's **Dismiss**. The ring already
   * goes quiet on a closed card (`chainNeedsAttention`), but the inbox is a list of its
   * own: an ask that outlives the ring is a dead item nobody can act on, sitting in the
   * nav rail's badge for ever.
   *
   * The card's STEPS are swept with it because that is where a chain's asks actually live
   * — a card executing an approved plan holds no session of its own, so every item raised
   * under it is filed against a step.
   *
   * Two deliberate exceptions to "just delete it":
   *
   *  - **A held tool is released, not abandoned.** `pendingDecisions` holds the broker's
   *    `resolve` for a permission / plan-approval / agent-question; deleting the item
   *    without calling it leaves the CLI process blocked on that request until the app
   *    exits. Denied, because nobody decided (see {@link DISMISSED_MESSAGE}).
   *  - **`merge-conflict` items are never dropped.** That item is not a card shouting, it
   *    is a rebase stopped halfway with markers in a worktree, and its answer is what
   *    finishes or abandons the integration. Dismissing it would strand the repo with no
   *    control left that could finish the job.
   */
  dismissAttentionForCard(taskId: string): number {
    if (this.disposed) return 0;
    const ids = new Set([taskId, ...this.store.getSubtasks(taskId).map((s) => s.id)]);
    let dropped = 0;
    // Snapshotted: `resolveAttention` mutates the map we would otherwise be iterating.
    for (const item of [...this.attention.values()]) {
      if (!ids.has(item.taskId) || item.kind === 'merge-conflict') continue;
      const pending = this.pendingDecisions.get(item.id);
      if (pending) {
        this.pendingDecisions.delete(item.id);
        pending.resolve({ behavior: 'deny', message: DISMISSED_MESSAGE });
      }
      // The stored context behind a parked failure goes with its item; leaving it would
      // keep a resolution alive for an item no one can reach any more.
      this.pendingFailures.delete(item.id);
      this.resolveAttention(item.id);
      dropped++;
    }
    return dropped;
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
    this.pendingReplans.clear();
    this.summarizedSteps.clear();
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
  private startTask(
    project: Project,
    task: Task,
    opts: {
      chatPrompt?: string;
      reviewSeed?: boolean;
      releaseSeed?: boolean;
      permissionMode?: PermissionMode;
    } = {},
  ): string {
    const runId = randomUUID();
    // A per-TURN override (a re-plan, which must run in `plan` mode whatever the card is
    // assigned) beats a per-assignment override (chosen in the assign dialog), which
    // beats the project default. Captured on the run so every later decision —
    // permissions above all — judges the run the human actually authorized, and so the
    // one-turn override never outlives its turn.
    const permissionMode = opts.permissionMode ?? task.agentMode ?? project.defaultPermissionMode;
    // Read off the SAME two inputs the mode is, and that symmetry is the point: `plan`
    // asked for on this turn means "come back with a plan", while `plan` inherited from
    // the card means only "this card may not write". A conversation — a chat reply, a
    // post-chain review — is judged as a conversation unless the caller says otherwise.
    const expectsPlan =
      opts.permissionMode === 'plan' ||
      !(opts.chatPrompt !== undefined || opts.reviewSeed || opts.releaseSeed);
    const run: Run = {
      taskId: task.id,
      projectId: project.id,
      runId,
      settled: false,
      chatPrompt: opts.chatPrompt,
      reviewSeed: opts.reviewSeed,
      releaseSeed: opts.releaseSeed,
      permissionMode,
      // Planning costs what the project says planning costs. The two flags together are
      // what "this run is planning" means — a turn that was ASKED for a plan and is held
      // to it — so a re-plan turn now switches model as well as mode, while a chat reply
      // or a review that merely inherited `plan` from its card keeps the execution model.
      // Resolved once, here: the run captures its model so an edit of the card's (or the
      // project's) model decides the NEXT run and can never change this one mid-flight.
      model: resolveRunModel(task, project, expectsPlan && permissionMode === 'plan'),
      expectsPlan,
    };
    this.runs.set(runId, run);
    this.inFlight.add(task.id);
    if (run.reviewSeed || run.releaseSeed) {
      // A review conversation reads code that is already merged into base, so it belongs
      // in the project directory — not in a fresh worktree cut from a branch that the
      // chain's own integration just deleted. A release run wants the same directory for a
      // stronger reason: releasing from an isolated worktree would tag and publish a
      // branch instead of the integration branch the work landed on.
      this.launch(project, task, run, { mode: 'shared', cwd: project.path });
    } else if (this.worktrees) {
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
      prep = await this.worktrees!.prepare(
        project,
        task,
        this.worktreeOwner(task),
        this.branchFor(task),
        // Normally undefined. A card `stacked` on another one's branch is cut from THAT
        // branch instead of from base, so it opens with the predecessor's commits already
        // in the tree — which is the only thing that makes the loose gate worth having.
        this.chain.startPointFor(task),
      );
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
    // Preparation had to write to the human's base repo to make the run possible (an unborn
    // HEAD it borned). The run is fine; the write still belongs in the task's activity, where
    // they will look, rather than only in git's reflog, where they won't.
    if (prep.mode === 'worktree' && prep.note) {
      this.noteRun(run.projectId, run.taskId, run.runId, prep.note);
    }
    this.launch(project, task, run, prep, comments);
  }

  /**
   * The linked ticket's comments, for an agent-assigned card's prompt. Empty unless a
   * comment provider is wired (`setTicketCommentProvider`, from the IPC layer, which
   * owns the JIRA client), the card is delegated, and this is a FRESH run — a resume
   * continues an existing conversation that already has the context. A tracker that is
   * down or misconfigured must never block a run, so failures degrade to no comments.
   *
   * Bounded here as well as in the prompt (token audit, S1): a 100-comment thread is ~70 KB
   * and there is no reason to carry the 54 KB of it that will never be rendered. What must
   * survive the trip is the COUNT — a brief that drops half a thread and says nothing has
   * told the agent a partial thread is the whole thread.
   */
  private async collectTicketComments(task: Task): Promise<BoundedHistory<AgentPromptComment>> {
    // A step of a plan is briefed on its step, not on the ticket thread — that omission
    // IS the token saving (and a step carries no ticket key of its own anyway).
    if (task.parentTaskId) return NO_COMMENTS;
    if (!this.ticketComments || !task.agentProjectId || task.sessionId) return NO_COMMENTS;
    try {
      return boundEntries(await this.ticketComments(task), (c) => `${c.author}: ${c.body}`.length, {
        maxChars: TICKET_COMMENT_CHAR_BUDGET,
      });
    } catch {
      return NO_COMMENTS;
    }
  }

  /** Spawn the session for a reserved run in the prepared working directory. */
  private launch(
    project: Project,
    task: Task,
    run: Run,
    prep: LaunchTarget,
    comments: BoundedHistory<AgentPromptComment> = NO_COMMENTS,
  ): void {
    // A release run is deliberately a FRESH conversation. The card's saved session was
    // recorded against the worktree it ran in — a directory integration has just deleted —
    // and the CLI looks a session id up under the directory it is started in. There is also
    // nothing in that conversation a release needs: `buildReleasePrompt` says which branch
    // landed where, and `RELEASE.md` says the rest.
    const resumeSessionId = run.releaseSeed ? undefined : (task.sessionId ?? undefined);
    if (prep.mode === 'worktree') {
      run.branch = prep.branch;
      run.base = prep.base;
      run.worktree = prep.cwd;
    }
    // The plan file's path relative to the project dir, so a shared-dir agent can
    // edit it. Worktree agents get the isolated (no-plan-edit) prompt instead.
    const planRel = planRelPath(project);
    // An "AI fix & retry" resolution queued a failure note for this task's next run: the
    // agent has to be told why the last attempt failed, and the note is consumed so it
    // applies only once. A chat run deliberately leaves it queued: the human asking a
    // question is not the retry that note was written for.
    const failureNote = run.chatPrompt ? undefined : this.fixNotes.get(task.id);
    if (!run.chatPrompt) this.fixNotes.delete(task.id);
    const branch = prep.mode === 'worktree' ? prep.branch : undefined;
    // Told to the agent so an external build is pointed at THIS tree, not the
    // project's main checkout (which would compile unmodified source and succeed).
    const worktreePath = prep.mode === 'worktree' ? prep.cwd : undefined;
    // What the session is told to do, in order of specificity: the human's own words
    // (Phase 12 chat), else — when there is a conversation to rejoin — just what is new
    // in it (a failure note, or nothing but a nudge), else the full brief.
    //
    // The full brief is reserved for a run with NO session to resume ("Retry fresh", or a
    // card that never started): nothing has been said to that agent yet, so it genuinely
    // needs the whole thing.
    const prompt =
      run.chatPrompt ??
      (resumeSessionId
        ? failureNote
          ? resumeWithNotePrompt(failureNote)
          : RESUME_NUDGE
        : this.buildPrompt(project, task, {
            branch,
            planRel,
            failureNote,
            comments,
            worktreePath,
            permissionMode: run.permissionMode,
          }));
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
      // Run where the project says to — the local machine unless it targets WSL.
      host: hostFor(project.target),
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
      comments: BoundedHistory<AgentPromptComment>;
      worktreePath?: string;
      /** The RUN's mode, which may be a one-turn override of the task's. See {@link Run}. */
      permissionMode?: PermissionMode;
    },
  ): string {
    const { branch, planRel, failureNote, comments, worktreePath } = opts;
    // Standing setup knowledge and the two directory names travel with every shape of
    // prompt, so an agent is never left guessing which tree its work is in.
    const context = {
      instructions: project.instructions,
      worktreePath,
      projectPath: project.path,
    };
    // A step of an approved plan (Phase 11) — one step's brief, not the whole ticket.
    if (task.parentTaskId) {
      const subtaskPrompt = this.buildSubtaskPrompt(project, task, {
        branch,
        failureNote,
        ...context,
      });
      if (subtaskPrompt) return subtaskPrompt;
    }
    if (task.agentProjectId) {
      const notes = this.taskNotes(task.id);
      return buildAgentTaskPrompt(project.name, task, {
        branch,
        failureNote,
        comments: comments.kept,
        commentsOmitted: comments.omitted,
        notes: notes.kept,
        notesOmitted: notes.omitted,
        // A plan-mode run's headings become this card's step titles, so it is told how
        // they will be read. Read off the RUN, not the task: a re-plan turn is plan-mode
        // for this turn only, and asking the task would tell it the opposite.
        planMode:
          (opts.permissionMode ?? task.agentMode ?? project.defaultPermissionMode) === 'plan',
        attachments: this.promptAttachments(project, task),
        ...context,
      });
    }
    const modeOpts = branch ? { branch } : { planRelPath: planRel };
    // Contract-first (Phase C): a contract task is told which siblings its CONTRACT.md
    // serves; a sibling of a contract task is told to build against CONTRACT.md.
    return buildTaskPrompt(project.name, task, {
      ...modeOpts,
      ...this.contractPromptOptions(task),
      failureNote,
      ...context,
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
    opts: {
      branch?: string;
      failureNote?: string;
      instructions?: string;
      worktreePath?: string;
      projectPath?: string;
    },
  ): string | null {
    const parent = this.store.getTask(task.parentTaskId!);
    if (!parent) return null;
    const siblings = this.store.getSubtasks(parent.id);
    const index = siblings.findIndex((s) => s.id === task.id);
    // The human's instructions live on the CARD, so every step of the chain sees them —
    // which is exactly why they are bounded (S1): the card's history is re-paid per step.
    const notes = this.taskNotes(parent.id);
    return buildAgentSubtaskPrompt(project.name, parent, task, {
      stepNumber: index >= 0 ? index + 1 : 1,
      stepCount: Math.max(siblings.length, 1),
      stepTitles: siblings.map((s) => s.title),
      notes: notes.kept,
      notesOmitted: notes.omitted,
      branch: opts.branch,
      failureNote: opts.failureNote,
      instructions: opts.instructions,
      worktreePath: opts.worktreePath,
      projectPath: opts.projectPath,
      attachments: this.promptAttachments(project, task),
    });
  }

  /**
   * The files a run is handed (Phase 22): every attachment in the task's scope, as a
   * `@name` and an absolute path **on the machine the run happens on**.
   *
   * Three things happen here and nowhere else, because this is the only place that knows
   * all three:
   *
   *  - **Scope.** A step sees its own files plus its card's (`attachmentsInScope`), the
   *    same union the step's chips offer, so what the human is shown and what the agent is
   *    told cannot disagree. A card sees its own only — a card does not inherit its steps'.
   *  - **The path.** There is no `path` column; it is derived from the row through
   *    `attachmentFile`, and from the attachment's OWN `taskId`, which is what makes an
   *    inherited parent file resolve to the parent's directory rather than the step's.
   *  - **The translation.** `hostFor(project.target).toNative()` — a WSL run must be told
   *    `/mnt/c/...` or the path is one it cannot open. `localHost().toNative` is the
   *    identity, so there is one code path here and a local run is unaffected.
   *
   * Empty until {@link Scheduler.setAttachmentRoot} is wired (unit tests never wire it):
   * without `userData` there is no path to give, and a legend of names alone would be worse
   * than none — it would promise files the agent then cannot find.
   */
  private promptAttachments(project: Project, task: Task): PromptAttachment[] {
    if (!this.attachmentRoot) return [];
    const own = this.store.attachmentsForTask(task.id);
    const scoped = task.parentTaskId
      ? attachmentsInScope(own, this.store.attachmentsForTask(task.parentTaskId))
      : own;
    if (scoped.length === 0) return [];
    const host = hostFor(project.target);
    return scoped.map((a) => ({
      name: a.name,
      path: host.toNative(attachmentFile(this.attachmentRoot!, a.taskId, a.name)),
    }));
  }

  /**
   * The human's own notes on a card, oldest first — the timeline's comments AND its chat
   * messages, which between them include the instructions typed in the assign dialog and
   * anything said to the agent since. Read fresh on every launch so a retry (and anything
   * added meanwhile) reaches the agent.
   *
   * Chat messages are included deliberately (Phase 17). A message typed at a card whose
   * agent has never run IS an instruction, and it must reach the brief that starts it.
   * Their previous absence also meant a retry silently dropped everything the human had
   * said mid-run, which was a bug rather than a saving.
   *
   * Bounded by recency (token audit, S1): every step of a chain re-reads the card's whole
   * history, so a long-running card pays for its oldest chat message ~9 times. The newest
   * notes are also the relevant ones — the assign-dialog instructions, the answer to the
   * last question. The dropped count travels with them so the brief can say so.
   */
  private taskNotes(taskId: string): BoundedHistory {
    const bodies = this.store
      .getTaskActivity(taskId)
      .filter(
        (e): e is Extract<TaskActivityEntry, { kind: 'comment' | 'chat' }> =>
          e.kind === 'comment' || e.kind === 'chat',
      )
      .map((entry) => entry.body);
    return boundHistory(bodies, { maxChars: NOTES_CHAR_BUDGET });
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

    // Token accounting (Performance dashboard): a per-turn `usage` event is the task's
    // incremental spend; the `result` event carries the run's total cost. Recorded here,
    // before the negotiation/settlement branches below, so no early-return can skip it —
    // and deliberately ABOVE the transcript write, which is now conditional.
    if (event.kind === 'usage') {
      this.recordUsage('task', run.projectId, run.taskId, runId, event);
    } else if (event.kind === 'result') {
      this.recordCost('task', run.projectId, run.taskId, runId, event.costUsd);
    }

    // Phase 6: persist every event to the task's history so its transcript is
    // viewable after the run ends or the app restarts.
    //
    // Phase 17: filtered by the SAME predicate the live push uses, so a transcript you
    // scroll back to next week reads exactly like the run you watched happen. (Only
    // healthy rate-limit signals are dropped; `lastRateLimit` below still sees them,
    // because it reads the ungated observer stream.)
    if (shouldSurfaceEvent(event)) {
      this.store.appendTaskEvent(run.projectId, run.taskId, runId, event);
    }

    // Plan capture, fallback path (Phase 11). `decidePermission` normally sees the
    // `ExitPlanMode` call first, but that depends on the CLI routing the tool through
    // the permission gate. The event stream always carries it, so capture here too —
    // `capturePlan` is idempotent, and losing a plan the agent spent a whole session
    // producing is far worse than writing the same markdown twice.
    //
    // Capturing alone was not enough, though (Phase 18): the plan landed in `agentPlan`
    // and no `plan-approval` item was ever raised on this path, so an ungated run's plan
    // was stored where only the "Approved plan" fold could show it and no step could ever
    // come of it. Raise the item too, exactly as the `AskUserQuestion` fallback below does
    // — `capturePlan` must stay FIRST, since `raisePlanApproval` reads back what it wrote.
    // `answerAttention` already tolerates an item with no held tool.
    if (event.kind === 'tool-use' && event.name === EXIT_PLAN_MODE_TOOL) {
      this.capturePlan(run.taskId, event.input);
      if (!this.hasPendingAttention(runId)) this.raisePlanApproval(run);
    }

    // The same belt-and-braces for `AskUserQuestion` (Phase 17). If the CLI ever declines
    // to route its own interactive tool through the permission gate, `decidePermission`
    // never sees it and the question would go unasked — the exact silent failure this
    // whole path exists to end. Raising it here cannot BLOCK (the tool has already run),
    // but a question you can see and answer into the stream beats one you never knew
    // about. Guarded on `hasPendingAttention` so the gated path doesn't double-raise.
    if (
      event.kind === 'tool-use' &&
      isAskUserQuestionTool(event.name) &&
      !this.hasPendingAttention(runId)
    ) {
      const questions = parseAskUserQuestion(event.input);
      if (questions.length > 0) {
        this.raiseAttention(run, {
          kind: 'agent-question',
          prompt: describeQuestions(questions),
          toolName: event.name,
          reason: null,
          questions,
        });
      }
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
        //
        // ...but a SETTLED run must never be talked back into `running`. The CLI can emit a
        // second `system/init` — which `mapRawEvent` turns into another `started` — AFTER its
        // `result`, and 30ms was enough to overwrite the `done` that `settle` had just
        // written for a finished step. `exited` cannot undo it: that case is itself guarded
        // on `!run.settled`, so it declined to touch the status and the step stayed `running`
        // for as long as the app lived, spinning a card whose work was finished and committed.
        // Every other terminal path in this switch is guarded; this one was the exception.
        //
        // The session id is still worth keeping — it is a resume handle, and recording it is
        // what this case has always done. Only the claim that work is moving is wrong.
        //
        // A RELEASE run is the exception that keeps none of it: its session belongs to the
        // release, not to the card, and writing it here would hand the card's chat a resume
        // handle pointing at a one-turn publishing conversation instead of at the work. The
        // spinner is still wanted, so only the id is dropped.
        this.updateTask(
          run.taskId,
          run.releaseSeed
            ? run.settled
              ? {}
              : { status: 'running' }
            : run.settled
              ? { sessionId: event.sessionId }
              : { status: 'running', sessionId: event.sessionId },
          runId,
        );
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
        {
          // The two ways the CLI reports "success" about a run that achieved nothing.
          // Both were filed as wins before Phase 18, which is exactly what made them so
          // hard to see: the card said "Finished on branch…" and the human found nothing.
          const empty = describeEmptyOutcome(
            run.permissionMode,
            run.planPresented,
            event,
            run.expectsPlan,
          );
          const reason =
            empty ??
            (event.terminalReason || event.stopReason || 'the session ended without success');
          this.settle(run, empty || !event.success ? 'failed' : 'done', reason);
        }
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
        // Say so, even though nothing about the task itself changed here. The UI's
        // active-run snapshot (`scheduler:activeRuns`) is re-read on `task:changed`, and a
        // run that settled emitted that event BEFORE this line — while it was still in the
        // map. Without a second announcement the snapshot keeps a run that has just ended,
        // which is what left a finished card claiming to be starting. An empty patch writes
        // nothing; it only re-emits the task with no runId, saying "this run is over".
        this.updateTask(run.taskId, {}, null);
        const retrying = this.retryQueue.delete(run.taskId);
        // An approved plan's chain waits for the planning process to release the shared
        // worktree before its first step starts in the same directory (Phase 11).
        if (this.chainStarts.delete(run.taskId)) this.advanceSubtasks(run.taskId);
        // A re-plan queued behind this run (Phase 18) — the worktree is free now.
        this.startPendingReplan(run.taskId);
        this.pump(run.projectId); // a slot freed up — advance the queue
        // An auto-retry of a task whose project queue is idle (e.g. an ad-hoc run):
        // `pump` won't touch an inactive project, so relaunch it directly.
        if (retrying && !this.activeProjects.has(run.projectId)) {
          const task = this.store.getTask(run.taskId);
          const project = task ? this.runProjectFor(task) : undefined;
          // Membership in `retryQueue` (which is what `retrying` is) is the authority on
          // "this one is meant to run again", not the status. A board card's status is
          // the human's — `handleRunFailure` asks for `pending` and gets back wherever
          // they left the card (see `cardStatusGuard`) — so requiring `pending` here is
          // what would silently drop the retry for every card not sitting in TO DO.
          if (project && task && !this.inFlight.has(task.id)) this.startTask(project, task);
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
   * The gate's timer fired: the limit has reset. Put every parked task back to work,
   * skipping any the user has since stopped or removed.
   *
   * Three things here are not obvious, and each of them was a card that never came back:
   *
   *  1. **A missing session id is not a reason to skip.** The gate parks whatever was
   *     in flight, and a run is in flight from the moment its slot is reserved — before
   *     the worktree is prepared, before the process spawns, before the `started` event
   *     that records the id. Requiring one meant a task limited in that window was left
   *     `blocked-by-limit` behind a gate that had just cleared, with nothing to ever
   *     raise it again. There is no conversation to lose in that case, so it simply
   *     starts (`startTask` resumes only when there IS an id).
   *  2. **A card with steps outstanding hands back to its CHAIN**, exactly as `runTask`
   *     does — resuming the card's own session beside its steps would put two agents in
   *     one worktree, and after an approved plan the card's session is the planner, which
   *     was told to stop.
   *  3. **A task that cannot start is released rather than left parked**, because
   *     `blocked-by-limit` with no gate behind it is a card that waits for ever.
   *  4. **The chain of execution is re-asked at the very end**, because a card the chain
   *     would have released while the limit was up was never parked by the gate: nothing
   *     was running on it to park. It is `pending` with its predecessors long satisfied,
   *     and until this it waited for the next restart. Last on purpose — see below.
   *
   * This is the one right place for that re-ask, rather than `onLimitChanged` or the gate
   * itself: every way a limit can lift comes through here — the timer
   * ({@link LimitGate.fire}), the banner's *Resume now*, and {@link
   * Scheduler.restoreLimitGate}'s no-saved-gate branch, which calls this directly with a
   * synthetic state and no gate ever armed. `onLimitChanged` fires on ENGAGE too and never
   * fires on that last branch. `fire()` nulls its state before calling this, so the
   * re-ask's own `limitActive()` guard already passes.
   */
  private resumeParked(state: LimitState): void {
    if (this.disposed) return;
    /** Cards that yielded to their chain above — advanced after the loop, once per card. */
    const chains = new Set<string>();
    for (const taskId of state.parkedTaskIds) {
      const task = this.store.getTask(taskId);
      // Only resume tasks still parked by the limit (not since stopped/deleted).
      if (!task || task.status !== 'blocked-by-limit') continue;
      if (!task.parentTaskId && chainInFlight(this.store.getSubtasks(task.id))) {
        // The steps ARE this card's work; give the field back and let the chain run.
        this.updateTask(task.id, { status: 'in-progress' }, null);
        chains.add(task.id);
        continue;
      }
      // Something live already owns it (a human pressed Run as the gate lifted); that run
      // sets the status itself. Judged on unsettled runs, so the process the gate itself
      // stopped — which lingers in `inFlight` until its `exited` arrives — is not mistaken
      // for one, which is what "Resume now" clicked straight after a false trip produces.
      if (this.hasLiveRunFor([task])) continue;
      const project = this.runProjectFor(task);
      if (!project) {
        this.releaseStrandedPark(task);
        continue;
      }
      this.startTask(project, task); // resumes by task.sessionId when there is one
    }
    // A step parked by `advanceSubtasks` is resumed by its own entry above; this covers the
    // card whose chain simply had nothing running to park. A chain stopped at a failed or
    // questioning step is NOT nudged: that one is the human's to resolve, and a limit
    // resetting is not them resolving it.
    for (const parentId of chains) {
      if (parkedStep(this.store.getSubtasks(parentId))) continue;
      this.advanceSubtasks(parentId);
    }
    // Slots may have freed without a parked task — nudge every active queue.
    for (const projectId of this.activeProjects) this.pump(projectId);
    // LAST, and that is the whole of its correctness: by now everything the gate parked has
    // re-reserved its slot and every queue has been pumped, so the chain sees those cards as
    // in flight and cannot start one a second time.
    this.chain.reconsider('limit-lifted');
  }

  /**
   * Hand back a task the reset could not start, so it does not sit `blocked-by-limit`
   * behind a gate that no longer exists. The same shapes {@link
   * Scheduler.reconcileInterruptedTasks} uses for the same reason: a card re-queues, a
   * step parks for the human (nothing re-enters a chain on its own).
   */
  private releaseStrandedPark(task: Task): void {
    this.noteRun(
      task.projectId,
      task.id,
      'limit',
      'The usage limit cleared, but this no longer resolves to a project to run in, so it ' +
        'was not restarted. Its session is kept — running it again continues the same ' +
        'conversation.',
    );
    this.updateTask(task.id, { status: task.parentTaskId ? 'failed' : 'pending' }, null);
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
      /** `agent-question` only: the structured questions, with their options. */
      questions?: AttentionQuestion[];
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
      questions: detail.questions ?? [],
      createdAt: Date.now(),
    };
    this.attention.set(item.id, item);
    // Persisted alongside the in-memory map, not instead of it: the map is what every hot
    // path reads, the table is what survives a restart. The kind-specific context is
    // filled in by the specialised raisers (`raiseTaskFailed`, `raiseMergeConflict`),
    // which know what their answer path will need.
    this.store.saveAttention(item, null);
    this.updateTask(run.taskId, { status: 'waiting-input' }, run.runId);
    this.emitAttention(item);
    return item;
  }

  /**
   * Deliver an answer to the session that asked, or — when that session is gone —
   * resume the task with it.
   *
   * The second case is what makes a restored inbox item answerable at all. A parked HTTP
   * request cannot survive a restart (the CLI process, the relay and the socket all die
   * with the app), so a rehydrated item carries no live run: `sessions.send` on a dead
   * runId is a silent no-op, and the human's answer would vanish. Resuming turns it into
   * the opening prompt of a `--resume` run instead, which is the same conversation
   * continued rather than a new one.
   */
  private deliverOrResume(item: AttentionItem, message: string): void {
    if (item.runId && this.runs.has(item.runId)) {
      this.sessions.send(item.runId, message);
      return;
    }
    const task = this.store.getTask(item.taskId);
    // `resumeForChat` already refuses for every reason a run must not start (no session,
    // usage limit, chain busy) and says so; there is no better answer available here.
    if (task) this.resumeForChat(task, message);
  }

  /** True if any inbox item is still open for this run. */
  private hasPendingAttention(runId: string): boolean {
    for (const item of this.attention.values()) if (item.runId === runId) return true;
    return false;
  }

  /** Remove one item and notify the UI. */
  private resolveAttention(itemId: string): void {
    // Deleted from the table unconditionally: an item that was rehydrated and then
    // answered may have been dropped from the map by some other path, and a row left
    // behind would come back as a ghost on the next restart.
    this.store.deleteAttention(itemId);
    if (this.attention.delete(itemId)) this.emitAttentionResolved(itemId);
  }

  /** Whether the inbox is holding anything for this TASK (as opposed to a run). */
  private hasAttentionForTask(taskId: string): boolean {
    for (const item of this.attention.values()) if (item.taskId === taskId) return true;
    return false;
  }

  /**
   * Re-open the inbox from the DB after a restart.
   *
   * What can be recovered is decided per KIND, not per item, because the kinds genuinely
   * differ: a failed task or a merge conflict is stored context that any later call can
   * act on, while a permission request is a promise held inside a socket handler in a
   * process that no longer exists. Half the honesty of this feature is admitting that
   * rather than restoring a row that looks answerable and silently isn't.
   *
   * Runs BEFORE `reconcileInterruptedTasks`, which would otherwise sweep the very tasks
   * these items belong to.
   */
  rehydrateAttention(): void {
    if (this.disposed) return;
    for (const { item, context } of this.store.listAttention()) {
      const task = this.store.getTask(item.taskId);
      if (!task) {
        this.store.deleteAttention(item.id);
        continue;
      }

      if (item.kind === 'permission') {
        // The specific tool call is gone with its process. Restoring an Approve button
        // that cannot approve anything would be a lie; say what happened instead.
        this.noteRun(
          item.projectId,
          item.taskId,
          item.runId,
          `The app closed while an approval for "${item.toolName ?? 'a tool'}" was pending. ` +
            `Nothing was run. Start the task again if you still want it done.`,
        );
        this.store.deleteAttention(item.id);
        continue;
      }

      // Its run is gone, so `runId` is now a dead correlator. Blanked so no live-session
      // path (`sessions.send`, `hasPendingAttention`) mistakes it for something it can
      // answer in place — `deliverOrResume` sees the emptiness and resumes instead.
      const revived: AttentionItem = { ...item, runId: '' };
      this.attention.set(revived.id, revived);
      this.store.saveAttention(revived, context);
      if (item.kind === 'task-failed' && context) {
        this.pendingFailures.set(item.id, context as PendingFailure);
      }
      if (item.kind === 'merge-conflict' && context) {
        this.pendingIntegrations.set(item.id, context as PendingIntegration);
      }
      this.emitAttention(revived);
    }
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
    // A review seed (Phase 17) is a one-turn briefing on a card whose work is already
    // merged. It owns no branch, so there is nothing to integrate; and its outcome must
    // not move the card, which is exactly where the human left it. Checked first, before
    // any of the chain/worktree branches below can claim it.
    // A release run (see `@shared/release`) is about the RELEASE, not about the card's
    // work — which is merged either way. So it settles first and quietly: no integration
    // (there is no branch left), no auto-retry (re-running half a publish is how you get
    // two tags), and no failed-task park. What happened goes on the timeline, where the
    // human is already looking, and the card stays exactly where they left it.
    if (run.releaseSeed) {
      this.attempts.delete(run.taskId);
      if (status === 'failed') {
        this.noteRun(
          run.projectId,
          run.taskId,
          run.runId,
          `The release did not finish (${reason ?? 'the run failed'}). The work is merged — ` +
            `read the transcript above, then release by hand or send the agent another message.`,
        );
      }
      this.updateTask(run.taskId, { status: 'in-progress' }, null);
      return;
    }

    if (run.reviewSeed) {
      this.attempts.delete(run.taskId);
      if (status === 'failed') {
        this.noteRun(
          run.projectId,
          run.taskId,
          run.runId,
          `Could not brief this card on its finished plan (${reason ?? 'the run failed'}). ` +
            `The work is merged regardless — the summary above is the record.`,
        );
      }
      this.updateTask(run.taskId, { status: 'in-progress' }, null);
      return;
    }

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
      // Past that return, this card's work is WRITTEN: either it has no steps, or the last
      // of them just finished, and in both cases there is a branch to build on. That is the
      // `stacked` gate's whole moment, and it is deliberately here — BEFORE integration,
      // before review, before anyone has said the work is good. A `stacked` successor buys
      // exactly that head start and accepts exactly that risk; `after-merge` (the default)
      // waits for the merge below instead.
      this.chain.workWritten(finished?.parentTaskId ?? run.taskId);
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
        // A conflict fix always finishes: the human already asked for that merge, and
        // leaving a worktree mid-rebase is not a state to park in.
        if (this.pendingConflictFix.delete(run.taskId)) {
          void this.finishConflict({ projectId: project.id, ...ctx });
          return;
        }
        // Phase 17: merging is the human's call unless they asked for it to be automatic.
        // Auto-merge happens at the moment the work has been reviewed least, and when it
        // failed it parked an ask whose only real option retried the same failure.
        //
        // Asked of the CARD, not of the app: a repo you own outright wants its branches
        // merged the moment they are green, and the one your team ships from does not, so
        // the card answers first, then its project, then the app-wide default
        // (`@shared/integrate`). A step is never asked — the branch belongs to the parent
        // card and the whole plan merges once, so the parent's answer governs the merge of
        // work its steps only contributed to.
        const settling = this.store.getTask(run.taskId);
        const owner = settling?.parentTaskId ? this.store.getTask(settling.parentTaskId) : settling;
        if (autoIntegrateOn(owner, project, this.store.getSettings())) {
          void this.integrateWorktree(project, ctx);
          return;
        }
        this.attempts.delete(run.taskId);
        this.readyToIntegrate.set(run.taskId, { projectId: project.id, ...ctx });
        // What this unmerged branch is HOLDING, said in the one note a human already reads
        // to learn it was not merged. "Merge when you get to it" and "three cards are
        // parked until you do" are different decisions, and only this sentence tells them
        // apart. Asked of `owner`, the card that owns the branch, because that is the id
        // the chain is drawn between — a step is never linked, so a plan's steps all point
        // at their parent, exactly as `chain.workWritten` was handed it above. No de-dup is
        // needed: `settle` runs once per run, so this lands once per thing there is to press.
        const held = owner ? this.chain.heldByMerge(owner.id) : [];
        const holding =
          held.length > 0
            ? ` ${held.length} ${held.length === 1 ? 'card is' : 'cards are'} chained to ` +
              `start when this merges — ${held.join(', ')} — so nothing downstream moves ` +
              `until you press it.`
            : '';
        this.noteRun(
          project.id,
          run.taskId,
          run.runId,
          `Finished on branch "${ctx.branch}". It has NOT been merged into ${ctx.base} — ` +
            `review it, then choose Merge on the card. The worktree is kept at ` +
            `${ctx.worktree}.${holding}`,
        );
        // Same split as the merged path: a STEP must reach `done` or the chain machinery
        // breaks (`hasPendingSibling`, `advanceSubtasks` and `chainInFlight` all read it
        // as "this step is over"), while a CARD must not — only the human moves a card.
        const settled = this.store.getTask(run.taskId);
        this.updateTask(
          run.taskId,
          { status: settled?.parentTaskId ? 'done' : 'in-progress' },
          null,
        );
        this.maybeWriteBackPlan(run.taskId);
        void this.finishParentChain(run.taskId, {
          branch: ctx.branch,
          base: ctx.base,
          merged: false,
        });
        return;
      }
    }
    if (status === 'failed') {
      this.handleRunFailure(run, reason ?? 'the task failed');
      return;
    }
    this.attempts.delete(run.taskId); // a success clears the retry counter
    // The orchestrator finishes WORK; it does not close cards. A run already moved this
    // card to IN PROGRESS when it started, and that is where it stays: only the human
    // decides a card is done, by dragging it. What changes here is that the spinner stops
    // and the outcome lands in the thread.
    this.updateTask(run.taskId, { status: 'in-progress' }, null);
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
    // Both halves of "say what is happening": the set drives the live spinner, and the note
    // is what the timeline still shows tomorrow — a merge that took a minute and then failed
    // should not read as though it had never been attempted.
    this.beginIntegration(ctx.taskId);
    this.noteRun(
      project.id,
      ctx.taskId,
      ctx.runId,
      `Merging branch "${ctx.branch}" into ${ctx.base}…`,
    );
    try {
      const result = await this.worktrees!.integrate(
        project,
        ctx.branch,
        ctx.base,
        ctx.worktree,
        message,
      );
      if (this.disposed) return;
      this.applyIntegrationResult(project, ctx, result);
    } catch (err) {
      // This promise is deliberately not awaited by its callers, so a throw out of git had
      // nowhere to go but an unhandled rejection — the card would simply stop merging and
      // never say why. It lands exactly where a reported `error` does: parked, worktree
      // kept, reason on the card.
      if (this.disposed) return;
      this.applyIntegrationResult(project, ctx, {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // In a `finally` so a throw from git cannot leave a card merging forever. After
      // `applyIntegrationResult`, so the outcome is already on the card when the spinner
      // stops rather than a frame after it.
      this.endIntegration(ctx.taskId);
    }
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
        // A cleanup that failed does not change what happened to the work — the merge
        // landed — so it is appended to the same note rather than raised as a problem of
        // its own. Said at all, though: an unremoved worktree used to be invisible, and the
        // next run picked up its remains believing they were a live branch.
        this.noteRun(
          project.id,
          ctx.taskId,
          ctx.runId,
          result.cleanupFailed ? `${note} Note: ${result.cleanupFailed}` : note,
        );
        // This line runs for BOTH a plain card and the final step of a chain, and the two
        // want different things. A STEP must reach `done` or the chain machinery breaks:
        // `hasPendingSibling`, `advanceSubtasks` and `chainInFlight` all read `done` as
        // "this step is over", and a step is not a board column entry anyway. A CARD must
        // not — only the human moves a card, so it stays where the run put it.
        const finished = this.store.getTask(ctx.taskId);
        this.updateTask(
          ctx.taskId,
          { status: finished?.parentTaskId ? 'done' : 'in-progress' },
          null,
        );
        this.maybeWriteBackPlan(ctx.taskId);
        // The same split, read the other way round: whichever of the two this was, the CARD
        // is what landed. A step shares its parent's branch and the whole plan integrates
        // once, so the merge that gets here is the parent's work reaching base — and a chain
        // links cards, never steps. That fact is written down (`landedAt`), which is what
        // satisfies every `after-merge` gate downstream and lets the release survive a
        // restart. Before `finishParentChain`, so the next card is on its way while this
        // one's hand-back summary is still being assembled.
        this.chain.landed(finished?.parentTaskId ?? ctx.taskId);
        // Auto-release, if this card asked for it (see `@shared/release`). BEFORE
        // `finishParentChain`, and that ordering is the whole coordination between the
        // two: starting the release reserves the card, and `seedParentReviewSession`
        // already declines to seed a card that is in flight. So a released card gets ONE
        // session — the release run, which ends by reporting what it shipped — instead of
        // a review conversation and a release talking over each other in the same thread.
        this.startReleaseRun(project, finished?.parentTaskId ?? ctx.taskId, {
          branch: ctx.branch,
          base: ctx.base,
          refMoveOnly: result.refMoveOnly === true,
        });
        // This was the final step of an approved plan (only the last one ever gets
        // here): hand the card back to the human for review.
        void this.finishParentChain(ctx.taskId, { branch: ctx.branch, base: ctx.base });
        break;
      }
      case 'nothing-to-merge':
        // Nothing happened and nothing is wrong, so the card is left exactly as it was: no
        // status change, no inbox item, no `landedAt`, no chain release, no auto-release.
        // Only a line on the timeline saying why the merge it was told about did not occur.
        //
        // This is the case that used to arrive as `error`, which parked the card and
        // offered a "Retry integration" that re-ran the same impossible merge — a card
        // whose work had merged perfectly well an hour earlier, stuck in the inbox with no
        // way out but abandoning it. Anything that reaches here has already succeeded or
        // has nothing to do; neither deserves an interruption.
        this.attempts.delete(ctx.taskId);
        this.noteRun(
          project.id,
          ctx.taskId,
          ctx.runId,
          `No merge was needed: ${result.reason}. Nothing was changed.`,
        );
        break;
      case 'conflict':
        this.escalateConflict(project, ctx);
        break;
      case 'dirty-base':
        // Integration failures are NOT auto-retried (the fix is human-side): park with
        // a "Retry integration" option they can use after committing/stashing base.
        this.parkIntegrationFailure(
          project,
          ctx,
          `Base branch "${result.base}" is checked out in ${project.path} and has uncommitted ` +
            `changes, so branch "${ctx.branch}" was not merged — fast-forwarding it would ` +
            `write over your work. Commit or stash it there, then choose "Retry integration". ` +
            `If you'd rather this project merged into a branch you don't keep checked out, ` +
            `set its base branch in the project's settings — that merge moves the branch ` +
            `pointer only and never touches your working files.`,
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
  /**
   * Merge a finished branch on the human's say-so (Phase 17).
   *
   * The offer is rebuilt from the TASK when the in-memory one is gone, so the button
   * survives a restart: a worktree and a branch are facts on disk, and refusing to merge
   * them because a Map was emptied would be an accident of process lifetime.
   *
   * Returns why it could not start, or null once an integration is under way.
   */
  async integrateNow(taskId: string): Promise<string | null> {
    if (!this.worktrees) return 'Worktrees are not enabled for this install.';
    const task = this.store.getTask(taskId);
    if (!task) return 'That task no longer exists.';
    if (task.status === 'running') return 'The agent is still working — stop it first.';
    // Already merging: pressing Merge twice must not start a second rebase in the same
    // worktree. The UI disables the button while this is true, but the guard belongs here —
    // the set is the engine's fact, not the renderer's.
    if (this.integrating.has(taskId)) return null;

    // From here on the answer takes real time — `prepare` below shells out to git — and
    // every path out of it either starts the merge or explains itself, so the card can say
    // it is working from the moment the human pressed the button.
    this.beginIntegration(taskId);
    try {
      return await this.startIntegration(taskId, task);
    } catch (err) {
      this.endIntegration(taskId);
      throw err;
    }
  }

  /**
   * The body of {@link Scheduler.integrateNow}, split out so every early return it makes is
   * covered by one `try` — a refusal must give the card back, and forgetting one of them
   * would leave it spinning on a merge that never started.
   */
  private async startIntegration(taskId: string, task: Task): Promise<string | null> {
    const refuse = (why: string): string => {
      this.endIntegration(taskId);
      return why;
    };
    let ctx = this.readyToIntegrate.get(taskId);
    if (!ctx) {
      // The offer is gone but the branch may not be: `readyToIntegrate` lives in memory and
      // a restart empties it, while the worktree and the branch are facts on disk.
      // `inspect` READS those facts — deliberately not `prepare`, which would build them.
      // Asking `prepare` here meant that pressing Merge on a card whose branch had already
      // merged rebuilt its worktree and re-created the branch git had deleted, then
      // reported the result as unmergeable: a button that could only ever fail.
      const project = this.store.getProject(task.agentProjectId ?? '');
      if (!project) return refuse('The agent project for this card has been removed.');
      const owner = task.parentTaskId ?? task.id;
      const live = await this.worktrees!.inspect(project, owner, task.agentBranch ?? undefined);
      if (!live) {
        return refuse(
          `There is no branch left to merge for this card. Its worktree and branch are ` +
            `removed as the last step of a successful merge, so this usually means the ` +
            `work is already in ${project.baseBranch?.trim() || 'the base branch'} — check ` +
            `the card's timeline for when it landed.`,
        );
      }
      ctx = {
        projectId: project.id,
        taskId,
        runId: task.sessionId ?? taskId,
        branch: live.branch,
        base: live.base,
        worktree: live.cwd,
      };
    }
    const project = this.store.getProject(ctx.projectId);
    if (!project) return refuse('The agent project for this card has been removed.');

    this.readyToIntegrate.delete(taskId);
    void this.integrateWorktree(project, {
      taskId: ctx.taskId,
      runId: ctx.runId,
      branch: ctx.branch,
      base: ctx.base,
      worktree: ctx.worktree,
    });
    return null;
  }

  /**
   * Whether a card has a finished branch waiting to be merged, for the UI's button.
   *
   * Deliberately optimistic after a restart: a delegated card that is not running and
   * whose project uses worktrees probably has a branch, and offering a Merge that then
   * reports "nothing to merge" is kinder than hiding the only button that can finish the
   * job. Checking properly would mean an async git call per card on every board render.
   */
  hasBranchToIntegrate(taskId: string): boolean {
    if (this.readyToIntegrate.has(taskId)) return true;
    const task = this.store.getTask(taskId);
    if (!task || !task.agentProjectId || task.status === 'running') return false;
    const project = this.store.getProject(task.agentProjectId);
    return Boolean(project?.useWorktrees) && Boolean(task.sessionId);
  }

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
    const files = await this.worktrees!.listConflicts(project, ctx.worktree);
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
    const pending: PendingIntegration = {
      projectId: project.id,
      taskId: ctx.taskId,
      runId: ctx.runId,
      branch: ctx.branch,
      base: ctx.base,
      worktree: ctx.worktree,
    };
    this.attention.set(item.id, item);
    this.pendingIntegrations.set(item.id, pending);
    // Saved WITH its context: a conflict is resolved in a worktree on disk, so nothing
    // about it needs the dead session. This is one of the two kinds a restart can restore
    // to full working order.
    this.store.saveAttention(item, pending);
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
    // `applyFailureChoice` works entirely off this stored context — no live session — so
    // a parked failure survives a restart fully answerable. That is the biggest single
    // win from persisting the inbox.
    this.store.saveAttention(item, f);
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
      case FAILURE_ACTION.leaveBranch:
        // Nothing to undo and nothing to retry: the branch stays, the worktree stays, the
        // card goes back to being an ordinary card. The point is that the ask ENDS.
        this.attempts.delete(f.taskId);
        this.readyToIntegrate.set(f.taskId, {
          projectId: f.projectId,
          taskId: f.taskId,
          runId: f.runId,
          branch: f.branch ?? '',
          base: f.base ?? '',
          worktree: f.worktree ?? '',
        });
        this.noteRun(
          f.projectId,
          f.taskId,
          f.runId,
          `Left branch "${f.branch ?? 'unknown'}" unmerged at your request. ` +
            `Nothing was discarded — merge it from the card when you are ready.`,
        );
        this.updateTask(f.taskId, { status: 'in-progress' }, null);
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
   * The branch a run works on: the OWNER card's chosen name, else the legacy one.
   *
   * Resolved through the owner because a step of a plan shares its parent's worktree, and a
   * worktree has exactly one checked-out branch. Giving each step its own would mean N
   * integrations, N rebase-conflict ladders and N chances to break base, for a chain that
   * is sequential by construction — so steps inherit, deliberately.
   */
  private branchFor(task: Task): string {
    const ownerId = this.worktreeOwner(task);
    const owner = ownerId === task.id ? task : this.store.getTask(ownerId);
    return owner?.agentBranch?.trim() || taskBranch(ownerId);
  }

  /**
   * Park a finished plan for the human. The item carries the plan markdown and the
   * titles of the subtasks approval would create, so the inbox shows the breakdown
   * being signed off rather than just prose. Reuses the existing plan capture: the
   * markdown is read from the task (persisted by `capturePlan`), so a plan survives
   * an app restart between the agent producing it and the human reading it.
   */
  private raisePlanApproval(run: Run): AttentionItem {
    run.planPresented = true; // this run did its job, whatever the human decides next
    const plan = this.store.getTask(run.taskId)?.agentPlan ?? '';
    const existing = this.store.getSubtasks(run.taskId);
    const steps = this.planStepsToAppend(run.taskId, plan);
    return this.raiseAttention(run, {
      kind: 'plan-approval',
      prompt:
        steps.length === 0
          ? 'The agent finished planning, but the plan proposes nothing this card does not ' +
            'already have. Review it below — approving will not add any steps.'
          : existing.length > 0
            ? `The agent proposes ${steps.length} more step(s), on top of the ` +
              `${existing.length} already on this card. Approving runs them one at a time, ` +
              `each in its own session, on this card's branch.`
            : `The agent finished planning and proposes ${steps.length} step(s). Approving runs ` +
              `them one at a time, each in its own session, on this card's branch.`,
      toolName: null,
      reason: null,
      plan,
      steps: steps.map((s) => s.title),
    });
  }

  /**
   * The steps approving this plan would actually CREATE on the card — the plan split, minus
   * anything the card already carries, capped at what is left of {@link MAX_PLAN_STEPS}.
   *
   * Shared by `raisePlanApproval` and `approvePlan` on purpose. They used to answer this
   * question differently (the inbox listed the whole plan, approval created a subset), which
   * meant a re-planning round could promise five steps and deliver two with no explanation.
   */
  private planStepsToAppend(parentId: string, plan: string): PlanStep[] {
    const existing = this.store.getSubtasks(parentId);
    return stepsToAppend(
      existing.map((s) => s.title),
      splitPlanIntoSteps(plan),
    );
  }

  /**
   * The human approved a plan: turn it into subtasks, end the planning session, and
   * start step 1.
   *
   * The planning session is deliberately NOT allowed to continue — its `ExitPlanMode`
   * is denied with a hand-over message and its process is stopped — because the whole
   * point is that each step runs in a fresh session carrying only its own context.
   * The parent moves to `in-progress` and stays there: it is never auto-completed.
   *
   * Steps APPEND (Phase 18). This used to skip creation entirely whenever the card already
   * had steps, which made a card's first plan its only one: re-planning a finished chain
   * resolved the approval, moved the card to `in-progress` and created nothing, so the
   * human saw an agent "plan" work that never appeared anywhere. Duplicate protection
   * moved into `stepsToAppend`, which drops individual repeats rather than the whole round.
   */
  private approvePlan(
    item: AttentionItem,
    release?: (result: PermissionDecisionResult) => void,
    note?: string,
  ): void {
    const parent = this.store.getTask(item.taskId);
    if (!parent) return;
    const plan = parent.agentPlan ?? item.plan ?? '';
    const fresh = this.planStepsToAppend(parent.id, plan);
    const round = this.store.maxSubtaskRound(parent.id) + 1;
    for (const step of fresh) {
      this.store.addSubtask(parent.id, {
        title: step.title,
        description: step.description,
        round,
      });
    }
    // An approval note is the human's own guidance — filed on the card, where every
    // step's prompt picks it up.
    if (note) this.store.addComment(parent.projectId, parent.id, note);
    // The plan itself goes on the timeline, because `capturePlan` overwrites `agentPlan`:
    // without this, a second approved plan silently erases the first from the card, and the
    // "Approved plan" fold would claim round 2's plan produced round 1's steps.
    if (plan.trim() && round > 1) {
      this.store.addComment(
        parent.projectId,
        parent.id,
        `Approved plan (round ${round}):\n\n${plan}`,
      );
    }

    // Hand over: stop the planner rather than let it implement what it just planned.
    release?.({ behavior: 'deny', message: PLAN_HANDOVER_MESSAGE });
    const run = this.runs.get(item.runId);
    if (run) {
      run.settled = true; // we are deciding this run's outcome, not its exit code
      this.clearRunAttention(run.runId);
      this.sessions.stop(run.runId);
    }

    // Nothing new to run: say so, release the card, and stop short of the hand-over.
    // Queueing `chainStarts` for a chain that gained nothing would leave the card looking
    // like it had work coming when it has none — indistinguishable, from the outside, from
    // the bug this whole path exists to fix. The status write is still needed: raising the
    // approval item borrowed `status` for `waiting-input`, and without releasing it the
    // card keeps its "wants you" ring over an item nobody can answer.
    if (fresh.length === 0) {
      // A comment on the CARD, not a note on the run's transcript: the planner's session is
      // about to be stopped, and the one place the human is certain to look is the card's
      // own timeline.
      this.store.addComment(
        parent.projectId,
        parent.id,
        'The approved plan proposed no steps this card does not already have, so nothing ' +
          'was added. Re-plan with more specific guidance if there is work left to do.',
      );
      this.updateTask(parent.id, { status: 'in-progress' }, null);
      this.tasksChanged?.(parent.projectId);
      return;
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
   *
   * **Under a usage limit the step is PARKED, not dropped.** This used to return here and
   * say, in a comment, that the human would run the card again — but nothing told them to,
   * and nothing else ever re-entered the chain: `advanceSubtasks` only runs when a step
   * *finishes*, and the step that would have finished never started. A card whose limit
   * arrived between two steps therefore sat at `2/4` for ever, with the reset that was
   * supposed to fix it passing unnoticed. Parking the step behind the same gate as a
   * running one puts it in the set `resumeParked` walks at reset, gives it the state the
   * board already reads as "paused — usage limit", and survives a restart, because the
   * gate's parked set is persisted.
   */
  private advanceSubtasks(parentId: string): void {
    if (this.disposed) return;
    const parent = this.store.getTask(parentId);
    if (!parent || parent.status === 'stopped' || parent.status === 'cancelled') return;
    const steps = this.store.getSubtasks(parentId);
    // One step at a time is the chain's whole contract, and the resume path is where it
    // could break: a step parked mid-run is restarted by `resumeParked` while its siblings
    // are still `pending`, so a chain nudged at the same moment must not start a second
    // agent in the one shared worktree. Weighed on UNSETTLED runs, not on `inFlight`: the
    // ordinary caller is a step that has just settled and whose slot is not freed until its
    // process exits, and reading that as "busy" would stop every chain at step one.
    if (this.hasLiveRunFor(steps)) return;
    const next = steps.find((t) => t.status === 'pending');
    if (!next) return;
    if (this.limitGate.active) {
      this.parkStepForLimit(next);
      return;
    }
    const project = this.runProjectFor(next);
    if (!project) return;
    this.startTask(project, next);
  }

  /**
   * Hold one step behind the usage-limit gate until the reset (see `advanceSubtasks`).
   *
   * Said on the step's own timeline as well as in its status, because the alternative —
   * a card that quietly stops between steps — is indistinguishable from a card that has
   * finished. If no gate is up (a race: it lifted between the check and here) nothing is
   * parked and the step is left `pending` for the caller's next pass.
   */
  private parkStepForLimit(step: Task): void {
    if (this.limitGate.park([step.id]).length === 0) return;
    this.updateTask(step.id, { status: 'blocked-by-limit' }, null);
    this.noteRun(
      step.projectId,
      step.id,
      'limit',
      'A usage limit was in force when this step came up, so it is waiting for the reset. ' +
        'It starts by itself when the limit clears — nothing to do.',
    );
  }

  /**
   * True when any of these tasks has a run that has not settled yet — i.e. one that is
   * genuinely still working, as opposed to one whose outcome is decided and whose process
   * is winding down (which stays in `runs`/`inFlight` until its `exited` arrives).
   */
  private hasLiveRunFor(tasks: readonly Task[]): boolean {
    const ids = new Set(tasks.map((t) => t.id));
    return [...this.runs.values()].some((r) => !r.settled && ids.has(r.taskId));
  }

  /** True when a step of this chain other than `exceptTaskId` is still waiting to run. */
  private hasPendingSibling(parentId: string, exceptTaskId: string): boolean {
    return this.store
      .getSubtasks(parentId)
      .some((t) => t.id !== exceptTaskId && t.status !== 'done' && t.status !== 'cancelled');
  }

  /**
   * The final step of a plan merged. Two things then have to happen on the CARD, because
   * a chain that ends on its last step leaves the human talking to a step that is over:
   *
   *  1. a summary of what every step actually did is filed on the parent's timeline, so
   *     the Details Panel reads as one story rather than N disconnected transcripts; and
   *  2. the card gets a live thread of its own again, via a fresh session briefed with
   *     that summary. We deliberately do NOT resume the planner — `approvePlan` told it to
   *     stop, its context predates every line the steps wrote, and it is the most
   *     expensive session in the chain (see `chainSummary.ts`).
   *
   * The card stays **In Progress**. Only the human moves a card to Done.
   */
  private async finishParentChain(
    subtaskId: string,
    /**
     * The chain's branch and base, and whether they were actually merged. Since Phase 17
     * a finished chain normally has a branch that has NOT been merged — merging is the
     * human's call — so the flag is carried rather than inferred from the names existing.
     */
    branchInfo?: { branch: string; base: string; merged?: boolean },
  ): Promise<void> {
    const subtask = this.store.getTask(subtaskId);
    if (!subtask?.parentTaskId) return;
    const parent = this.store.getTask(subtask.parentTaskId);
    if (!parent) return;

    const steps = this.store.getSubtasks(parent.id);
    // Only the steps this hand-back is actually about (Phase 18). A re-planned card reaches
    // here once per round, and summarizing all of it every time would re-tell round 1's
    // story — with round 1's outcomes — as if it had just happened. An empty set means we
    // have no record of a previous round (a restart, or a card that predates the tracking),
    // and then the whole chain is the honest answer, exactly as it was before.
    const summarized = this.summarizedSteps.get(parent.id);
    const unseen = summarized ? steps.filter((s) => !summarized.has(s.id)) : steps;
    const reported = unseen.length > 0 ? unseen : steps;
    this.summarizedSteps.set(parent.id, new Set(steps.map((s) => s.id)));
    const summary = buildChainSummary(
      parent.title,
      reported.map((step, i) => ({
        index: i + 1,
        title: step.title,
        status: step.status,
        outcome: this.lastResultText(step.id),
      })),
      branchInfo?.branch ?? null,
      branchInfo?.base ?? null,
      branchInfo?.merged ?? true,
    );
    this.store.addComment(parent.projectId, parent.id, summary);
    if (parent.status !== 'in-progress') {
      this.updateTask(parent.id, { status: 'in-progress' }, null);
    }
    this.tasksChanged?.(parent.projectId);

    this.seedParentReviewSession(parent, summary);
  }

  /** A task's own closing words: the `resultText` of its LAST `result` event, or ''. */
  private lastResultText(taskId: string): string {
    const events = this.store.getTaskHistory(taskId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.kind === 'result' && event.resultText.trim()) return event.resultText;
    }
    return '';
  }

  /**
   * Give a card whose chain just finished a session to talk to.
   *
   * A real run, so it settles like any other — but flagged `reviewSeed`, which does two
   * things `settle` and the worktree layer would otherwise get wrong: the chain's branch
   * has already been merged AND DELETED, so there is nothing to integrate, and preparing a
   * worktree would cut a brand-new branch for a card whose work is already in base. A
   * review conversation reads merged code, so it runs on the shared directory.
   */
  private seedParentReviewSession(parent: Task, summary: string): void {
    if (this.disposed || this.limitGate.active) return;
    // A card that never had an agent has nothing to seed; and one already running (a human
    // got in first) must not be interrupted.
    if (!parent.agentProjectId || this.inFlight.has(parent.id)) return;
    const project = this.runProjectFor(parent);
    if (!project) return;
    this.startTask(project, parent, {
      chatPrompt: buildChainHandbackPrompt(parent.title, summary),
      reviewSeed: true,
    });
  }

  /**
   * A card's branch just merged — release it too, if it was asked for and the repo says
   * how (`@shared/release`).
   *
   * Three things had to be decided here, and none of them is obvious:
   *
   * 1. **Who is asked.** The repo, via `RELEASE.md`. A missing file is not a failure and
   *    not silence either: it is noted on the card, because "I turned auto-release on and
   *    nothing happened" is the one outcome that would look like a bug.
   * 2. **Where it runs.** The project directory, never a worktree — the release is of the
   *    integration branch, and the branch that carried the work has just been deleted.
   *    When the merge only moved the ref, the checkout is on something else entirely and
   *    the prompt says so (see {@link buildReleasePrompt}).
   * 3. **When it doesn't.** A usage limit, a disposed scheduler, or a card that already
   *    has something running — the last of which is a human who got there first, and they
   *    outrank an automation every time.
   *
   * Returns whether a release run was started, so the caller knows the card is reserved.
   */
  private startReleaseRun(
    project: Project,
    /** The CARD that landed — a step's parent, never the step: a chain releases once. */
    cardId: string,
    merge: { branch: string; base: string; refMoveOnly: boolean },
  ): boolean {
    const card = this.store.getTask(cardId);
    if (!card) return false;
    if (!autoReleaseOn(card, project)) return false;
    if (this.disposed || this.limitGate.active) return false;
    // Something is already talking on this card (a human sent a message, a chain is
    // mid-flight). Say why the release did not start rather than dropping it.
    if (this.inFlight.has(card.id)) {
      this.noteCard(
        project.id,
        card.id,
        `Auto-release is on for this card, but something is already running on it — ` +
          `release \`${merge.base}\` by hand, or ask the agent to once it is free.`,
      );
      return false;
    }
    // The instructions are the repo's. Read through `appProjectFile` so a WSL project's
    // Linux path is named the way THIS process can open it.
    if (!existsSync(appProjectFile(project, RELEASE_DOC))) {
      this.noteCard(
        project.id,
        card.id,
        `Auto-release is on for this card, but ${project.name} has no \`${RELEASE_DOC}\` — ` +
          `nothing was released. Add one describing how this repo is released, and the next ` +
          `merge will follow it.`,
      );
      return false;
    }

    this.noteCard(
      project.id,
      card.id,
      `Merged into \`${merge.base}\` — releasing it now by following \`${RELEASE_DOC}\`.`,
    );
    this.startTask(project, card, {
      releaseSeed: true,
      // `plan` is the one mode that structurally cannot do this job — it may read and
      // nothing else — and it is the commonest mode a card carries, since planning a card
      // is how most chains start. Inheriting it would make every planned card's release a
      // run that reads RELEASE.md and then cannot follow a line of it. So a release falls
      // back to the project's own default, and to `acceptEdits` if that is planning too;
      // whatever it lands on, the permission broker still vets each risky command.
      permissionMode: releaseMode(card, project),
      chatPrompt: buildReleasePrompt({
        cardTitle: card.title,
        branch: merge.branch,
        base: merge.base,
        releaseDoc: RELEASE_DOC,
        refMoveOnly: merge.refMoveOnly,
        instructions: project.instructions,
      }),
    });
    return true;
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
      return parseFileOwnership(readFileSync(appProjectFile(project, 'CONTRACT.md'), 'utf8'));
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
   * File a note on a CARD's timeline — for things that belong to the card rather than to
   * any one run, and which therefore have no runId to hang off (the same route the chain
   * files its release notes by).
   */
  private noteCard(projectId: string, taskId: string, body: string): void {
    this.store.addComment(projectId, taskId, body);
    this.tasksChanged?.(projectId);
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
    // The same merge, resumed — so it says the same thing while it runs. Answering
    // "Resolved — finish merge" otherwise dismissed the inbox item and left the card
    // looking idle for however long the continued rebase took.
    this.beginIntegration(ctx.taskId);
    try {
      const result = await this.worktrees!.finishAfterConflict(
        project,
        pending.branch,
        pending.base,
        pending.worktree,
      );
      if (this.disposed) return;
      this.applyIntegrationResult(project, ctx, result);
    } catch (err) {
      // Same reasoning as `integrateWorktree`: nobody awaits this, so a throw would be lost.
      if (this.disposed) return;
      this.applyIntegrationResult(project, ctx, {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.endIntegration(ctx.taskId);
    }
  }

  private maybeWriteBackPlan(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const project = this.store.getProject(task.projectId);
    if (!project || !project.writeBackPlan) return;

    try {
      const planPath = appPlanPath(project);
      const markdown = readFileSync(planPath, 'utf8');
      const updated = tickPlanCheckbox(markdown, task.phase, task.title);
      if (updated !== null) writeFileSync(planPath, updated);
    } catch {
      // A missing/unwritable plan file is non-fatal — the task still counts as done.
    }
  }

  private updateTask(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'sessionId' | 'agentPlan' | 'preRunStatus'>>,
    runId: string | null,
  ): void {
    const before = patch.status !== undefined ? this.store.getTask(taskId) : undefined;
    const task = this.store.updateTask(taskId, before ? guardCardStatus(before, patch) : patch);
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
