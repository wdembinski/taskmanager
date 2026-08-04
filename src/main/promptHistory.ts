/**
 * Bounding the history a prompt drags along (token audit, finding **S1**).
 *
 * ## The problem this solves
 *
 * Two blocks of a brief grow without limit: the card's own notes (`taskNotes` — every
 * comment and chat message on its timeline) and the linked ticket's comment thread
 * (`collectTicketComments`). Both are re-read fresh on **every launch**, and a chain
 * averages 8.6 steps, so a card's history is re-paid once per step.
 *
 * Measured, today's cards are small: the heaviest holds 11,493 chars ≈ 2,900 tokens, and
 * across the audit's 5.3-day window the whole finding is worth $1–5. It is on the list
 * because it is **unbounded**, not because it is large — a JIRA ticket with 100 comments
 * of 700 chars is ~70 KB ≈ 17,500 tokens *per launch*, and long before that costs real
 * money it has crowded out the context window of every step with a thread that mostly
 * predates the work.
 *
 * ## Why recency, and why it must say what it dropped
 *
 * Recency, because the newest note is the one the human wrote about *this* run — the
 * instructions typed in the assign dialog, the answer to the last question, the correction
 * after the last failure. The oldest are the ones the ticket accumulated before anyone
 * picked it up.
 *
 * And the cap announces itself, always. Silently truncating history an agent then acts as
 * if it has is the failure mode this whole change exists to avoid: an agent told a partial
 * thread is the whole thread will confidently contradict something the human said on
 * comment 3. One extra line makes the omission visible and recoverable — the agent can ask.
 *
 * Pure, in the shape of `chainSummary.ts`'s `condense()` — the app's existing precedent for
 * bounding agent-facing text. Callers read the store and pass plain values.
 */

/** What survived a bounding pass, and how much did not. */
export interface BoundedHistory<T = string> {
  /** The kept entries, **oldest first** — the order the prompts already render. */
  kept: T[];
  /** How many entries were dropped, for the omission line. Zero when nothing was. */
  omitted: number;
}

/** How much history one block of a prompt may carry. */
export interface HistoryBudget {
  /** Total characters the kept entries may occupy together. */
  maxChars: number;
}

/**
 * The card's own notes: its timeline comments plus its chat messages.
 *
 * 12,000 chars ≈ 3,000 tokens, set just above the heaviest card measured in the audit
 * (11,493 chars) so this is a guard on the tail rather than a change to how today's cards
 * are briefed. Every step of a chain pays it, so it is deliberately the tighter of the two.
 */
export const NOTES_CHAR_BUDGET = 12_000;

/**
 * The linked ticket's comment thread.
 *
 * 16,000 chars ≈ 4,000 tokens, roughly 23 comments at the audit's 700-char yardstick. Wider
 * than the notes budget because a tracker thread is genuinely other people's context that
 * the agent has no other way to see — but only ONE run pays it: a step of a plan is briefed
 * on its step and never on the thread (`collectTicketComments` returns nothing for a
 * subtask), and that omission is the bigger saving of the two.
 */
export const TICKET_COMMENT_CHAR_BUDGET = 16_000;

/**
 * Keep the most recent entries that fit the budget, returned oldest-first.
 *
 * The generic core, so a list of anything can be bounded on whatever text it renders as —
 * a ticket comment costs what `author: body` costs, not what `body` costs.
 *
 * Walks newest-to-oldest and **stops** at the first entry that will not fit rather than
 * skipping it to squeeze in a smaller older one: a hole in the middle of a thread is a
 * worse thing to hand an agent than a thread that starts late.
 *
 * The newest entry is always kept, even alone over budget. A block that renders as nothing
 * but an omission line tells the agent there is history and gives it none of it; keeping
 * the one entry that was written about this run is strictly better.
 */
export function boundEntries<T>(
  entries: readonly T[],
  size: (entry: T) => number,
  budget: HistoryBudget,
): BoundedHistory<T> {
  const maxChars = Math.max(0, budget.maxChars);
  const kept: T[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const cost = size(entry);
    if (kept.length > 0 && used + cost > maxChars) break;
    kept.push(entry);
    used += cost;
  }
  kept.reverse();
  return { kept, omitted: entries.length - kept.length };
}

/** {@link boundEntries} for plain strings — the notes case. */
export function boundHistory(entries: readonly string[], budget: HistoryBudget): BoundedHistory {
  return boundEntries(entries, (entry) => entry.length, budget);
}

/**
 * The one line that keeps a capped brief honest, or nothing when nothing was dropped.
 *
 * Returned as an array so a prompt builder can splice it in with `...` alongside the block
 * it belongs to. It goes directly under that block's heading, because the entries are
 * rendered oldest-first and what was dropped is always the older end.
 */
export function omissionLine(omitted: number, noun: string): string[] {
  if (omitted <= 0) return [];
  const plural = omitted === 1 ? noun : `${noun}s`;
  return [`_(${omitted} earlier ${plural} omitted — ask if you need them.)_`];
}
