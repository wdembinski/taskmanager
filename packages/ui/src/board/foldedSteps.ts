/**
 * Which board cards have their **Steps** section folded away.
 *
 * The list itself lives in `AppSettings.foldedStepCards`, because a fold has to survive the
 * board being unmounted — which happens every time you leave the screen — and a relaunch.
 * The two functions here are everything the board does to it, kept out of the component so
 * they can be tested without one.
 */

/**
 * Fold or unfold one card, and forget every card that has left the board.
 *
 * The prune rides along with the toggle rather than running on a timer of its own: a written
 * list is the only moment there is anything to prune, and it is the moment the board's own
 * ids are in hand anyway. Without it the list would only ever grow — a card deleted, archived
 * or dropped by a JIRA sync would leave its id behind for good, and a board synced daily for
 * a year would carry a settings blob mostly made of cards nobody can see.
 *
 * `onBoard` is the ids the board is currently showing, INCLUDING steps: pruning against cards
 * alone would need this function to know what a step is, and a step id can never be in the
 * list anyway (only a card's own section folds).
 *
 * Deliberately order-preserving and duplicate-free, so the saved blob does not churn: a list
 * that reshuffled itself on every toggle would make every settings diff unreadable.
 */
export function toggleFoldedSteps(
  folded: readonly string[],
  taskId: string,
  onBoard: ReadonlySet<string>,
): string[] {
  const kept = folded.filter((id, i) => onBoard.has(id) && folded.indexOf(id) === i);
  // The toggled card is filtered out either way, so folding a card that had somehow been
  // listed twice unfolds it once and for all rather than leaving a copy behind.
  const next = kept.filter((id) => id !== taskId);
  return folded.includes(taskId) ? next : [...next, taskId];
}

/**
 * The set the cards are drawn from. A `Set` because every card on the board asks it whether
 * it is folded, and an array would make that a scan per card per render.
 */
export function foldedStepsSet(folded: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(folded ?? []);
}
