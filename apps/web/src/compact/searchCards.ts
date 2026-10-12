/**
 * The compact shell's Search tab (F3.2): a case-insensitive substring match over the board
 * already mirrored in this tab, so a search here never issues a relayed read of its own —
 * `board.state.tasks` is all it ever sees, which is the same data the board itself is already
 * drawing from, and the same reason the strip and `connectionState.ts` never touch
 * `transport.invoke` either.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Matches title and ticket key**, case-insensitively, as a plain substring — not a fuzzy
 *   or token match. `Task.ticketKey` is checked when present (`undefined`/`null` is simply
 *   never a match on that half), so typing `TM-42` finds a ticket and typing a few words of
 *   its title still finds it too.
 * - **An empty (or all-whitespace) query returns `[]`**, not the whole board — the screen
 *   this backs starts on an empty results list rather than dumping every card the moment the
 *   tab opens.
 * - **Capped at {@link SEARCH_CARDS_RESULT_LIMIT} results.** A phone screen has room for a
 *   handful of rows at a time; a cap here is cheaper than asking the results list to virtualise
 *   for a query that happens to match everything.
 */
import type { Task } from '@tm/shared/model';

/** How many rows `searchCards` ever returns — see the module header. */
export const SEARCH_CARDS_RESULT_LIMIT = 50;

/**
 * `tasks` filtered to the ones whose title or ticket key contains `query`, case-insensitive,
 * capped at {@link SEARCH_CARDS_RESULT_LIMIT}. `''` (or all-whitespace) → `[]`.
 */
export function searchCards(tasks: readonly Task[], query: string): Task[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const needle = trimmed.toLowerCase();
  const matches = tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(needle) ||
      (task.ticketKey ?? '').toLowerCase().includes(needle),
  );
  return matches.slice(0, SEARCH_CARDS_RESULT_LIMIT);
}
