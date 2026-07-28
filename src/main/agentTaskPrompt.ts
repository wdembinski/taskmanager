/**
 * The prompt for a My Tasks card delegated to an agent (agent delegation, Phase 3).
 *
 * A plan task's prompt (`buildTaskPrompt` in `scheduler.ts`) is about a QUEUE: it
 * names the plan, the milestone, the contract/scaffold siblings, and lets the agent
 * evolve the plan file. An assigned card is the opposite — exactly ONE ticket, no
 * queue, no plan file — so it gets its own prompt built from the ticket itself: the
 * key/URL/title, the tracker's description and comment thread, and the human's own
 * notes on the card (which include whatever they typed in the assign dialog).
 *
 * Pure and unit-tested. Two contracts are reused verbatim rather than re-worded, so
 * detection can never drift from what the agent was told:
 *   - `NEEDS_INPUT_SENTINEL` — how the agent asks the human a question mid-task
 *     (`attention.ts`; the same wording as the plan-task prompt).
 *   - the worktree rule — commit on your own branch; the orchestrator merges it back.
 *
 * The agent is explicitly told NOT to write to the tracker: the orchestrator never
 * transitions or comments on JIRA, and a helpful agent doing it by hand would break
 * that guarantee.
 */
import type { Task } from '@shared/model';
import { NEEDS_INPUT_SENTINEL } from './attention';

/** One comment handed to the agent as context (author + plain-text body). */
export interface AgentPromptComment {
  author: string;
  body: string;
}

/** Everything beyond the task row itself that shapes an assigned card's prompt. */
export interface AgentTaskPromptOptions {
  /** The linked ticket's tracker comments, OLDEST FIRST (empty for internal tasks). */
  comments?: AgentPromptComment[];
  /**
   * The human's own notes from the card's timeline, oldest first — including the
   * instructions typed when the card was assigned (they are stored as a comment).
   */
  notes?: string[];
  /** (Worktree mode) the isolated branch the agent commits on. */
  branch?: string;
  /** (AI-assisted retry) why the previous attempt failed. */
  failureNote?: string;
  /**
   * The project's standing instructions — setup knowledge that belongs to the
   * orchestrator rather than the codebase (where a build tree lives, an environment
   * to source first, a wrapper a command must run through).
   */
  instructions?: string;
  /** (Worktree mode) the absolute working directory this run is isolated in. */
  worktreePath?: string;
  /** The project's canonical directory, which the worktree was branched from. */
  projectPath?: string;
}

/**
 * The worktree paragraph.
 *
 * Naming the working directory explicitly is not decoration. When a task's changes
 * live in a worktree but the agent points an EXTERNAL build (a Yocto recipe's
 * `externalsrc`, a devtool workspace) at the project's canonical checkout, the build
 * succeeds against unmodified source — a green build of the wrong code, which is
 * worse than a failure because nothing looks wrong.
 */
function worktreeLines(branch: string, worktreePath?: string, projectPath?: string): string[] {
  return [
    `You are on an isolated git branch "${branch}" — your own worktree. Commit your`,
    `work on this branch when you are done (the orchestrator merges it back into the`,
    `base branch automatically).`,
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
  ];
}

/** Trim a block of user/tracker text and drop it if it carries nothing. */
function clean(text: string | null | undefined): string {
  return (text ?? '').trim();
}

/**
 * Build the single-ticket prompt for an assigned card. `projectName` is the AGENT
 * project (the repo the run happens in), not the Personal board.
 */
export function buildAgentTaskPrompt(
  projectName: string,
  task: Task,
  options: AgentTaskPromptOptions = {},
): string {
  const { branch, failureNote, worktreePath, projectPath } = options;
  const comments = (options.comments ?? []).filter((c) => clean(c.body));
  const notes = (options.notes ?? []).map(clean).filter(Boolean);
  const key = clean(task.externalKey);
  const url = clean(task.externalUrl);
  const description = clean(task.externalDescription);
  const instructions = clean(options.instructions);

  return [
    `You are working in the repository for the project "${projectName}".`,
    '',
    // Standing setup knowledge, before anything task-specific: it often decides HOW
    // every later command has to be run.
    ...(instructions ? [`Project setup notes you must follow:`, instructions, ''] : []),
    `Your job is ONE ticket — the one below. Do not pick up any other work, and do not`,
    `look for a plan or a task queue: there is none.`,
    '',
    key ? `Ticket: ${key} — ${task.title}` : `Task: ${task.title}`,
    url ? `Link: ${url}` : '',
    '',
    ...(description ? ['Description:', description, ''] : []),
    ...(comments.length > 0
      ? [
          `Comments on the ticket (oldest first):`,
          ...comments.map((c) => `- ${c.author}: ${c.body}`),
          '',
        ]
      : []),
    ...(notes.length > 0
      ? [`Notes from the human who assigned this (oldest first):`, ...notes.map((n) => `- ${n}`), '']
      : []),
    `Read whatever you need to understand the codebase first — including any \`.md\``,
    `documentation, memory, or state files in this directory — then make the necessary`,
    `changes and briefly summarize what you did.`,
    '',
    // Worktree mode: the same rule plan tasks get — the orchestrator owns integration.
    ...(branch ? worktreeLines(branch, worktreePath, projectPath) : []),
    // Never write to the tracker: that is a hard product decision, not a preference.
    ...(key
      ? [
          `Do NOT update ${key} in the tracker — no status transitions, no comments. The`,
          `orchestrator never writes to JIRA; report back here instead.`,
          '',
        ]
      : []),
    // AI-assisted retry: hand over the previous failure so the cause gets fixed.
    ...(failureNote
      ? [
          `NOTE: a previous attempt at this ticket failed. The reported reason was:`,
          `"${failureNote}"`,
          `Diagnose why it failed and fix the underlying cause before completing the work.`,
          '',
        ]
      : []),
    // The question contract — identical to the plan-task prompt so `detectQuestion`
    // sees the same marker whichever prompt started the run.
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

/** What a subtask's prompt needs beyond the step's own row (Phase 11). */
export interface AgentSubtaskPromptOptions {
  /** 1-based position of this step in its parent's chain, and the chain's length. */
  stepNumber: number;
  stepCount: number;
  /**
   * Every step's title, in order — the shape of the whole approved plan as one-liners.
   * Deliberately titles only: the point of running one session per step is that a step
   * does NOT drag the full plan (or the earlier steps' output) through its context.
   */
  stepTitles?: string[];
  /** The human's own notes on the parent card, oldest first (assign-dialog instructions). */
  notes?: string[];
  /** (Worktree mode) the branch this step commits on — the PARENT's shared branch. */
  branch?: string;
  /** (AI-assisted retry) why the previous attempt at this step failed. */
  failureNote?: string;
  /** The project's standing setup instructions (see {@link AgentTaskPromptOptions}). */
  instructions?: string;
  /** (Worktree mode) the absolute working directory this step runs in. */
  worktreePath?: string;
  /** The project's canonical directory, which the worktree was branched from. */
  projectPath?: string;
}

/**
 * Build the prompt for ONE step of an approved plan (Phase 11).
 *
 * The contrast with `buildAgentTaskPrompt` is the whole point of the feature: that
 * prompt hands the agent an entire ticket (description + comment thread + notes) and
 * lets one session carry it end to end. This one hands over a single step's brief plus
 * just enough orientation to place it — the parent ticket's key/title, "step N of M",
 * and the other steps' titles — so each session pays for its own context only.
 *
 * The shared-worktree rule is stated explicitly: the branch is the PARENT's and earlier
 * steps have already committed to it, so the agent must not reset, rebase, or merge it.
 */
export function buildAgentSubtaskPrompt(
  projectName: string,
  parent: Task,
  subtask: Task,
  options: AgentSubtaskPromptOptions,
): string {
  const { stepNumber, stepCount, branch, failureNote, worktreePath, projectPath } = options;
  const stepTitles = (options.stepTitles ?? []).map(clean).filter(Boolean);
  const notes = (options.notes ?? []).map(clean).filter(Boolean);
  const key = clean(parent.externalKey);
  const brief = clean(subtask.description);
  const instructions = clean(options.instructions);

  return [
    `You are working in the repository for the project "${projectName}".`,
    '',
    ...(instructions ? [`Project setup notes you must follow:`, instructions, ''] : []),
    `This is **step ${stepNumber} of ${stepCount}** of a plan a human already approved.`,
    `Do ONLY this step. Do not start the later steps, and do not re-plan the ticket —`,
    `each remaining step runs as its own session after this one.`,
    '',
    key ? `Parent ticket: ${key} — ${parent.title}` : `Parent task: ${parent.title}`,
    `Your step: ${subtask.title}`,
    '',
    ...(brief ? ['What this step covers:', brief, ''] : []),
    ...(stepTitles.length > 1
      ? [
          `The full plan, for orientation only (you are on step ${stepNumber}):`,
          ...stepTitles.map((t, i) => `${i + 1}. ${t}${i + 1 === stepNumber ? '  ← you' : ''}`),
          '',
        ]
      : []),
    ...(notes.length > 0
      ? [`Notes from the human who assigned this (oldest first):`, ...notes.map((n) => `- ${n}`), '']
      : []),
    `Read whatever you need in the codebase first, then make this step's changes and`,
    `briefly summarize what you did.`,
    '',
    // The shared branch: unlike a per-task worktree, earlier steps' commits are already
    // here, so history rewriting would destroy work the orchestrator has not integrated.
    ...(branch
      ? [
          `You are in a git worktree on branch "${branch}" — SHARED by every step of this`,
          `plan. The earlier steps' commits are already on it. Commit your own work here when`,
          `you are done, and do NOT reset, rebase, merge, or switch branches: the orchestrator`,
          `integrates the branch into the base branch once the final step finishes.`,
          ...(worktreePath
            ? [
                '',
                `Your working directory is "${worktreePath}". THIS is the source of truth for`,
                `this plan — not${projectPath ? ` "${projectPath}",` : ''} the project's main`,
                `checkout. If you point an external build or tool at this project's sources,`,
                `point it HERE, or it will build code that does not include your changes.`,
              ]
            : []),
          '',
        ]
      : []),
    ...(key
      ? [
          `Do NOT update ${key} in the tracker — no status transitions, no comments. The`,
          `orchestrator never writes to JIRA; report back here instead.`,
          '',
        ]
      : []),
    ...(failureNote
      ? [
          `NOTE: a previous attempt at this step failed. The reported reason was:`,
          `"${failureNote}"`,
          `Diagnose why it failed and fix the underlying cause before completing the step.`,
          '',
        ]
      : []),
    // Same contract, same wording as every other prompt — `detectQuestion` must match.
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
