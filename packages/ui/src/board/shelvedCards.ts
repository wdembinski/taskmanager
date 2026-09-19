/**
 * Which board cards have been parked onto the shelf — `shelvedCardIds` in `AppSettings`.
 *
 * The same shape `foldedSteps.ts` keeps for a card's folded steps, and the same two
 * operations: a human's click toggles, and a caller acting on the human's behalf (dropping
 * a card onto the shelf strip) only ever adds. Kept as its own module rather than reusing
 * `toggleFoldedCard`/`ensureFoldedCard` directly — "the shelf" and "folded steps" are two
 * different lists that happen to share a shape, and importing the fold module's functions
 * under a shelf's name would read as one concept borrowing the other's code.
 */

/**
 * Add or remove one card, and forget every card that has left the board — see
 * `toggleFoldedCard`, which this mirrors exactly. The pane offering "Move to shelf" /
 * "Return to board" as one menu item is what makes a toggle the right shape here: the
 * click always means "the opposite of whatever this card is now."
 */
export function toggleShelvedCard(
  shelved: readonly string[],
  taskId: string,
  onBoard: ReadonlySet<string>,
): string[] {
  const kept = shelved.filter((id, i) => onBoard.has(id) && shelved.indexOf(id) === i);
  const next = kept.filter((id) => id !== taskId);
  return shelved.includes(taskId) ? next : [...next, taskId];
}

/**
 * Add one card to the shelf if it is not there already, and prune the rest — the
 * add-if-absent half of the pair, for a card dropped onto the shelf strip rather than
 * clicked. Idempotent, so a drop that lands on an already-shelved card is a no-op rather
 * than bouncing it back onto the board.
 */
export function ensureShelvedCard(
  shelved: readonly string[],
  taskId: string,
  onBoard: ReadonlySet<string>,
): string[] {
  const kept = shelved.filter((id, i) => onBoard.has(id) && shelved.indexOf(id) === i);
  return kept.includes(taskId) ? kept : [...kept, taskId];
}

/** The set shelved cards are drawn from — one `Set` per render, not a scan per card. */
export function shelvedCardSet(shelved: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(shelved ?? []);
}
