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
  const { branch, failureNote } = options;
  const comments = (options.comments ?? []).filter((c) => clean(c.body));
  const notes = (options.notes ?? []).map(clean).filter(Boolean);
  const key = clean(task.externalKey);
  const url = clean(task.externalUrl);
  const description = clean(task.externalDescription);

  return [
    `You are working in the repository for the project "${projectName}".`,
    '',
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
    ...(branch
      ? [
          `You are on an isolated git branch "${branch}" — your own worktree. Commit your`,
          `work on this branch when you are done (the orchestrator merges it back into the`,
          `base branch automatically).`,
          '',
        ]
      : []),
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
