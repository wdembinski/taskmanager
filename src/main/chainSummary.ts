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
 * So a **summary** is filed on the parent's timeline here, so the Details Panel reads as
 * one story rather than N disconnected transcripts. It is deliberately self-contained —
 * every step's outcome, whether the branch merged, and which files it touched — because it
 * is the only account of the chain a later session will ever be briefed with (see
 * `finishParentChain`, which clears the card's session rather than seeding a new one: the
 * next chat message builds a fresh full brief, and this summary is what that brief reads
 * from the timeline).
 *
 * Pure — the caller reads the store and git, and passes plain values.
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

/** How many touched paths the summary names before folding the rest into "and N more". */
const MAX_FILES_SHOWN = 20;

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
  /**
   * Paths the branch touched (`git diff --name-only base..branch`), additions and edits
   * alike. Empty when there is no branch or the diff could not be read. This is what a
   * seeded review session used to spend a whole extra turn establishing by reading the
   * branch itself; folding it into the deterministic summary makes that turn unnecessary.
   */
  files: string[] = [],
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

  if (files.length > 0) {
    lines.push('');
    const shown = files.slice(0, MAX_FILES_SHOWN);
    const rest = files.length - shown.length;
    lines.push(
      `**Files touched:** ${shown.map((f) => `\`${f}\``).join(', ')}` +
        (rest > 0 ? `, and ${rest} more` : ''),
    );
  }

  lines.push('');
  lines.push('This card is still **In Progress** — move it to Done yourself when you are happy.');
  return lines.join('\n');
}
