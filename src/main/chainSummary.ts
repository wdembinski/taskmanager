/**
 * What happened across a whole approved plan, written for the card that owns it.
 *
 * ## The problem this solves
 *
 * A card that hands over to a plan stops holding a conversation: each step runs in its own
 * session, and when the last one merges the human is left talking to a subtask that is
 * already over — typing new instructions at an agent whose job finished. The card's own
 * thread, meanwhile, ends at the moment the plan was approved and says nothing about what
 * was actually built.
 *
 * So two things are produced here: a **summary** filed on the parent's timeline, so the
 * Details Panel reads as one story rather than N disconnected transcripts, and a **hand-back
 * prompt** that briefs a fresh session on the card so there is something to talk to again.
 *
 * ## Why a fresh session and not the planner's
 *
 * The planner's session is deliberately dead: `approvePlan` stops it with "do NOT implement
 * it here. Stop now." Resuming it would revive a conversation whose last instruction is to
 * stop, whose entire context is plan-mode research that predates every line the steps
 * wrote, and which is the most expensive session in the chain — inverting the token saving
 * that is the whole reason steps exist. A short brief on a clean session is cheaper and
 * better informed.
 *
 * Pure — the caller reads the store and passes plain strings.
 */

/** One finished step, as the summary renders it. */
export interface ChainStepSummary {
  /** 1-based position in the chain. */
  index: number;
  title: string;
  /** The step's final status — `done` for the happy path, but a chain can end otherwise. */
  status: string;
  /**
   * The step's own closing words: the `resultText` of its last `result` event. That is the
   * agent's summary of its own work, it already exists, and it costs nothing to reuse.
   * Empty when the step produced none.
   */
  outcome: string;
}

/** Trim a step's closing text to something a timeline can hold. */
function condense(text: string, max = 400): string {
  const flat = text.replace(/\r\n/g, '\n').trim();
  if (!flat) return '';
  // The agent's last paragraph is its conclusion; earlier ones are usually narration.
  const paragraphs = flat.split(/\n{2,}/).filter((p) => p.trim());
  const chosen = (paragraphs[paragraphs.length - 1] ?? flat).replace(/\s+/g, ' ').trim();
  return chosen.length > max ? `${chosen.slice(0, max).trimEnd()}…` : chosen;
}

/**
 * The markdown filed on the parent card when its chain completes.
 *
 * Markdown rather than plain prose because the card's timeline renders it, and a plan's
 * worth of work is a list — flattening it into a paragraph is what made the old one-line
 * note useless.
 */
export function buildChainSummary(
  cardTitle: string,
  steps: ChainStepSummary[],
  branch: string | null,
  base: string | null,
  /**
   * Whether the branch was actually merged into base.
   *
   * A separate flag rather than inferred from `branch && base` being present, because
   * since Phase 17 a finished chain usually has both AND has not been merged — merging
   * is the human's call. Claiming a merge that did not happen is the one thing this
   * summary must never do: it is the record the card is read from later.
   */
  merged = true,
): string {
  const lines: string[] = [];
  const finished = steps.filter((s) => s.status === 'done').length;

  lines.push(
    `**Plan complete** — ${finished} of ${steps.length} steps finished on “${cardTitle}”.`,
  );
  lines.push('');

  if (steps.length === 0) {
    lines.push('_The plan had no steps to run._');
  }

  for (const step of steps) {
    const mark = step.status === 'done' ? 'x' : ' ';
    const suffix = step.status === 'done' ? '' : ` _(${step.status})_`;
    lines.push(`- [${mark}] **${step.index}. ${step.title}**${suffix}`);
    const outcome = condense(step.outcome);
    if (outcome) lines.push(`  ${outcome}`);
  }

  if (branch && base) {
    lines.push('');
    lines.push(
      merged
        ? `Merged \`${branch}\` into \`${base}\`.`
        : `The work is on \`${branch}\` and has **NOT been merged** into \`${base}\` — ` +
            `review it, then choose Merge on this card.`,
    );
  }

  lines.push('');
  lines.push('This card is still **In Progress** — move it to Done yourself when you are happy.');
  return lines.join('\n');
}

/**
 * The prompt that seeds the card's new review session.
 *
 * It says explicitly that the work is finished and that this turn is only an
 * acknowledgement: without that, a fresh agent handed a plan summary reads it as a brief
 * and starts implementing the thing that was just built.
 */
export function buildChainHandbackPrompt(cardTitle: string, summary: string): string {
  return [
    `The approved plan for “${cardTitle}” has finished running. Every step was executed in`,
    'its own session and the work is already written — here is what was done:',
    '',
    summary,
    '',
    'You are picking this card up for the REVIEW conversation, not to implement anything.',
    'Read the summary, look at the merged code if you need to, and reply with a short',
    'account of where the card stands and anything you think the human should check.',
    'Do not start new work unless they ask for it.',
  ].join('\n');
}
