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
 * The agent is explicitly told NOT to write to the tracker — JIRA or GitHub. Every
 * transition and every comment this app makes, it makes ITSELF, programmatically, from
 * the human's own action on the card; a helpful agent doing it by hand would break that
 * guarantee, and would do it with credentials nobody audited it against.
 */
import type { Task } from '@shared/model';
import type { PromptAttachment } from '@shared/attachments';
import { NEEDS_INPUT_SENTINEL } from './attention';
import {
  NOTES_CHAR_BUDGET,
  TICKET_COMMENT_CHAR_BUDGET,
  boundEntries,
  boundHistory,
  omissionLine,
} from './promptHistory';

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
  /**
   * How many comments/notes the CALLER already dropped before handing the rest over.
   *
   * The scheduler bounds at source (`collectTicketComments`, `taskNotes`) so it is not
   * hauling a 70 KB thread around to render 16 KB of it, and this prompt bounds again on
   * whatever it is given — the cap belongs to the prompt, not to one caller. The two counts
   * are added, so the omission line states the true total however the work was split. See
   * {@link ./promptHistory}.
   */
  commentsOmitted?: number;
  notesOmitted?: number;
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
  /**
   * True when this run is in `plan` mode, so the prompt can say how the plan's own
   * headings will be used. They become the card's step titles verbatim, which the agent
   * has no way to know — and a plan headed `Phase 1` / `Phase 2` therefore produced a
   * Steps list that named none of its steps.
   */
  planMode?: boolean;
  /**
   * The files attached to this card (Phase 22), with paths **already native to the
   * machine the run happens on** — the caller translates, this module only formats. See
   * {@link attachmentLines}.
   */
  attachments?: PromptAttachment[];
}

/**
 * How to head a plan, given the headings become step titles.
 *
 * Fixing the INPUT rather than post-processing the output: `toSubtaskTitle` can rescue a
 * structural heading by falling back to the body, but a heading the agent wrote well needs
 * no rescuing and reads better than anything derived from prose.
 */
function planHeadingLines(): string[] {
  return [
    `When you present the plan, remember that each of its phase headings becomes the TITLE`,
    `of a task on the board, shown on its own with no surrounding context. So give every`,
    `heading an imperative title of roughly 3-8 words that starts with a verb — "Add the`,
    `auth guard", "Migrate the settings blob", "Extract the branch naming" — never a bare`,
    `"Phase 1", and never a lone noun.`,
    '',
  ];
}

/**
 * What a step may BE — the other half of {@link planHeadingLines}.
 *
 * Headings do not just get titles, they get *sessions*: every one becomes a task that a
 * separate agent runs, in this worktree, on this branch. A plan written as a document
 * therefore gets executed as if its table of contents were a work breakdown, and two kinds
 * of heading cost a full session while producing nothing.
 *
 * Both were observed on one card. Its plan opened with "Shape of the design", "Verified
 * facts this rests on" and "Sequencing" — prose sections, each of which then burned an agent
 * run restating the plan — and closed with "Release", which could not release: a step runs
 * on the feature branch, and releasing from anything but the integration branch is exactly
 * what a release procedure forbids. That step spent seven minutes re-running the gates and
 * handed the job back, and two seconds after the merge the orchestrator did it properly.
 *
 * Unconditional, deliberately. Whether auto-release is switched on decides who releases and
 * when — never whether a STEP can, and the answer to that is always no.
 */
function planScopeLines(): string[] {
  return [
    `Each heading also becomes a separate agent SESSION, run in this worktree. So every`,
    `heading has to be a piece of work someone could do here. Two things therefore do not`,
    `belong in the plan at all:`,
    '',
    `- **Merging or releasing.** The orchestrator merges this branch once the last step`,
    `  finishes, and runs the release itself afterwards, from the project's own checkout.`,
    `  A step cannot do either — it is on a feature branch, which is the one place a`,
    `  release must never be cut from. Plan the work; the tool ships it.`,
    `- **Sections that are not work.** Context, the design rationale, the facts you`,
    `  checked, the order things land in — that is the plan's prose, not steps. As a step`,
    `  each one spends a whole session restating what the plan already says.`,
    '',
    `Verification IS work and does belong, if there is something to verify.`,
    '',
  ];
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
 * The attachment legend (Phase 22) — the point of the whole feature, in four lines.
 *
 * `@shot.png` in a brief means nothing to an agent on its own; this is the table that
 * turns it into a file it can open. Three decisions are baked in here:
 *
 * - **Every attachment is listed, not just the ones the text cites.** Somebody who
 *   attached a file and then mistyped the token still meant the agent to have it, and
 *   filtering would turn that typo into a silently missing input. `referencedAttachments`
 *   (`@shared/attachments`) exists for the renderer's highlighting, not for this.
 * - **"Do not copy them into the repository" is load-bearing.** The files live under
 *   `userData`, outside the worktree; without that sentence an agent will cheerfully `cp`
 *   a 4 MB PNG into the tree and commit it.
 * - **The paths arrive already translated.** A WSL run needs `/mnt/c/...`, but this module
 *   is pure and unit-tested and must not learn about execution hosts — the scheduler maps
 *   them through `hostFor(project.target).toNative()` before calling in.
 *
 * No quoting: a `name` is `[A-Za-z0-9._-]` by construction (`attachmentName`), so no legend
 * path can contain a space.
 */
const TASK_FILES_HEADING = `Files attached to this task — the description refers to them by the @name on the left:`;

/**
 * A step's files include its parent card's, so the heading says so: a step that cites
 * `@mockup.png` never attached it, and an agent told only about "this step" would read the
 * card's file as an unexplained extra.
 */
const STEP_FILES_HEADING = `Files attached to this step and its card — the brief refers to them by the @name on the left:`;

function attachmentLines(heading: string, attachments: readonly PromptAttachment[]): string[] {
  const files = attachments.filter((a) => clean(a.name) && clean(a.path));
  if (files.length === 0) return [];
  return [
    heading,
    ...files.map((a) => `- @${clean(a.name)} -> ${clean(a.path)}`),
    `Read them with your file tools. They live outside the repository; do not copy them into it.`,
    '',
  ];
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
  // Bounded by recency: an uncapped ticket thread is the one part of this brief that can
  // grow to tens of thousands of tokens, re-paid on every launch. Blank entries are dropped
  // BEFORE bounding — they are nothing, not omitted history.
  const comments = boundEntries(
    (options.comments ?? []).filter((c) => clean(c.body)),
    (c) => `${c.author}: ${clean(c.body)}`.length,
    { maxChars: TICKET_COMMENT_CHAR_BUDGET },
  );
  const commentsOmitted = (options.commentsOmitted ?? 0) + comments.omitted;
  const notes = boundHistory((options.notes ?? []).map(clean).filter(Boolean), {
    maxChars: NOTES_CHAR_BUDGET,
  });
  const notesOmitted = (options.notesOmitted ?? 0) + notes.omitted;
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
    // Straight after the words that cite them — a legend read before the brief is a list
    // of paths with nothing to resolve.
    ...attachmentLines(TASK_FILES_HEADING, options.attachments ?? []),
    // The omission line sits under the heading, not after the list: the entries render
    // oldest-first, so what was dropped is always the older end.
    ...(comments.kept.length > 0 || commentsOmitted > 0
      ? [
          `Comments on the ticket (oldest first):`,
          ...omissionLine(commentsOmitted, 'comment'),
          ...comments.kept.map((c) => `- ${c.author}: ${c.body}`),
          '',
        ]
      : []),
    ...(notes.kept.length > 0 || notesOmitted > 0
      ? [
          `Notes from the human who assigned this (oldest first):`,
          ...omissionLine(notesOmitted, 'note'),
          ...notes.kept.map((n) => `- ${n}`),
          '',
        ]
      : []),
    `Read whatever you need to understand the codebase first — including any \`.md\``,
    `documentation, memory, or state files in this directory — then make the necessary`,
    `changes and briefly summarize what you did.`,
    '',
    // Worktree mode: the same rule plan tasks get — the orchestrator owns integration.
    ...(branch ? worktreeLines(branch, worktreePath, projectPath) : []),
    ...(options.planMode ? [...planHeadingLines(), ...planScopeLines()] : []),
    // Never write to the tracker: that is a hard product decision, not a preference.
    ...(key
      ? [
          `Do NOT update ${key} in the tracker — no status transitions, no comments. The`,
          `orchestrator writes to JIRA and GitHub itself; report back here instead.`,
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

/**
 * How few slots must remain before a re-plan is told the number at all.
 *
 * `MAX_PLAN_STEPS` is a runaway guard, not a budget, so its remainder is usually a number
 * no plan would ever reach — quoting it would read as permission to write a hundred steps.
 * Below this, the remainder is a real constraint on what the agent can propose, and staying
 * silent about it would let the guard silently drop the tail of its plan instead.
 */
const SLOTS_WORTH_SAYING = 20;

/**
 * The prompt for a **re-planning turn** (Phase 18): the human asking a card whose steps
 * are finished to work out what comes next.
 *
 * This is a chat prompt, not a fresh brief — it resumes a session that already knows the
 * card, so it repeats nothing about the ticket. What it must supply is the three things
 * the session CANNOT know:
 *
 *  1. **What is already on the board.** The agent's own transcript ends where its last
 *     step did; it has no idea which titles the card carries. Told them, it plans the
 *     remainder — untold, it re-proposes the work it just finished, and `stepsToAppend`
 *     drops the lot as duplicates, which reads to the human as "nothing happened".
 *  2. **How many slots are left — but only when that is nearly none.** `MAX_PLAN_STEPS` is
 *     a runaway guard on the CARD, set far above any plan a human would approve, so on
 *     almost every round the number is not a constraint and saying it is noise: told it may
 *     write 187 steps, an agent learns nothing. Only once the card is genuinely close to the
 *     bound does it matter, and then it matters a lot — better the agent chooses which steps
 *     survive than that the guard truncates its tail arbitrarily. See
 *     {@link SLOTS_WORTH_SAYING}.
 *  3. **That it must finish with `ExitPlanMode`.** Nothing becomes a step otherwise: a
 *     plan written as prose in the reply is exactly the failure this feature fixes.
 *
 * The heading and scope rules are shared verbatim with the first-round prompt — these steps
 * land in the same list as the existing ones, so they have to read the same way and be the
 * same kind of thing. A later round is if anything MORE prone to proposing a release, since
 * by then the work looks finished.
 */
export function buildReplanPrompt(
  taskTitle: string,
  existingStepTitles: readonly string[],
  options: { note?: string; slotsLeft: number } = { slotsLeft: 0 },
): string {
  const note = clean(options.note);
  const done = existingStepTitles.map(clean).filter(Boolean);
  return [
    `Plan the NEXT round of work on this card: "${taskTitle}".`,
    '',
    ...(done.length > 0
      ? [
          `These steps are already on the card — do not propose them again, and do not`,
          `re-do their work:`,
          ...done.map((t, i) => `  ${i + 1}. ${t}`),
          '',
        ]
      : []),
    ...(note ? [`What the human asked for:`, note, ''] : []),
    `Look at the current state of the code before you plan — the steps above have already`,
    `landed, so plan against what is actually there now, not against what you remember.`,
    '',
    `Propose ONLY the work that remains.`,
    ...(options.slotsLeft <= SLOTS_WORTH_SAYING
      ? [
          `At most ${options.slotsLeft} step(s) — if more than that is genuinely needed, plan`,
          `the most valuable ones now and say what you left out.`,
        ]
      : []),
    `If nothing meaningful is left to do, say so plainly instead of inventing work.`,
    '',
    ...planHeadingLines(),
    ...planScopeLines(),
    `When the plan is ready, call ExitPlanMode with it. That is what puts the steps on the`,
    `card for the human to approve — a plan written out in your reply reaches nobody.`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
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
  /**
   * How many of the parent's notes the caller already dropped — added to whatever this
   * prompt drops itself. See {@link AgentTaskPromptOptions.notesOmitted}; every step of a
   * chain re-pays the card's history, so this is the block the budget exists for.
   */
  notesOmitted?: number;
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
  /**
   * The files in this step's scope (Phase 22) — its own attachments **plus its parent
   * card's**, resolved by `attachmentsInScope` and translated by the caller. A mockup is
   * attached once, to the card, and every step that has to match it says `@mockup.png`.
   */
  attachments?: PromptAttachment[];
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
  const notes = boundHistory((options.notes ?? []).map(clean).filter(Boolean), {
    maxChars: NOTES_CHAR_BUDGET,
  });
  const notesOmitted = (options.notesOmitted ?? 0) + notes.omitted;
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
    ...attachmentLines(STEP_FILES_HEADING, options.attachments ?? []),
    ...(stepTitles.length > 1
      ? [
          `The full plan, for orientation only (you are on step ${stepNumber}):`,
          ...stepTitles.map((t, i) => `${i + 1}. ${t}${i + 1 === stepNumber ? '  ← you' : ''}`),
          '',
        ]
      : []),
    ...(notes.kept.length > 0 || notesOmitted > 0
      ? [
          `Notes from the human who assigned this (oldest first):`,
          ...omissionLine(notesOmitted, 'note'),
          ...notes.kept.map((n) => `- ${n}`),
          '',
        ]
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
          `orchestrator writes to JIRA and GitHub itself; report back here instead.`,
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
