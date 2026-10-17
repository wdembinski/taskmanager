/**
 * The shared detail pane's own "Back" trail inside the Projects screen (F12.9) — the ids a
 * follow-a-link click left behind, so a chain of ticket links can be unwound one hop at a
 * time instead of only ever returning to wherever the list/timeline/graph selection sits.
 *
 * Kept pure and apart from `Projects.tsx` so the stack rules — the cap, the no-op pushes, the
 * skip-what's-gone pop — are tested without a DOM or a transport.
 */

/** How many hops back the pane remembers — the oldest one drops off past this. */
export const PANEL_HISTORY_LIMIT = 10;

export interface PanelHistory {
  /** The ids left behind, oldest first — the next `backHistory` pop is the last entry. */
  readonly stack: readonly string[];
}

export const EMPTY_HISTORY: PanelHistory = { stack: [] };

/**
 * Leave `fromId` behind before moving on to wherever the link points.
 *
 * A no-op for `null` (nothing to return to, e.g. the pane was empty) and for the id already
 * on top (following a link back to the ticket you just left should not grow the stack at
 * all). The oldest entry is dropped once the stack would otherwise exceed
 * {@link PANEL_HISTORY_LIMIT}.
 */
export function pushHistory(history: PanelHistory, fromId: string | null): PanelHistory {
  if (fromId === null) return history;
  if (history.stack[history.stack.length - 1] === fromId) return history;
  const stack = [...history.stack, fromId];
  const capped =
    stack.length > PANEL_HISTORY_LIMIT ? stack.slice(stack.length - PANEL_HISTORY_LIMIT) : stack;
  return { stack: capped };
}

/**
 * Pop the most recent id still worth returning to, skipping any entry `exists` says is gone
 * (a ticket deleted since it was left behind). Popping an already-empty history is a no-op —
 * the same `history` reference comes back, `taskId: null`. Popping past every remaining entry
 * (all deleted) also lands on `taskId: null`, with the stack left empty.
 */
export function backHistory(
  history: PanelHistory,
  exists: (id: string) => boolean,
): { history: PanelHistory; taskId: string | null } {
  if (history.stack.length === 0) return { history, taskId: null };
  const stack = history.stack.slice();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (exists(id)) return { history: { stack }, taskId: id };
  }
  return { history: { stack }, taskId: null };
}
