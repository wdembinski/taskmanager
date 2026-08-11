/**
 * What the **Show Done** switch says while the column it controls is shut.
 *
 * The switch is the one control on the board whose job is done by its LABEL: DONE is the
 * only column a card can reach without anybody dragging it there — a run that failed, a
 * ticket whose JIRA status maps into it — so with the column closed those cards simply
 * stopped existing as far as the board was concerned. The column still stays shut until
 * you open it (a board that opens its own columns cannot be reasoned about); the numeral
 * is what makes a hidden card impossible to mistake for a lost one.
 *
 * Split the way {@link archivedCountLabel}/{@link archivedCountTitle} are, and for the same
 * reason: the bare count on the control, the sentence in the tooltip — which is also what a
 * screen reader is given. The count answers "is anything in there"; the sentence answers
 * the question that follows, which is whether any of them got there by failing.
 *
 * Pure and untested until now: this was two inline expressions in `MyTasks.tsx`, and the
 * `notMarkedDone` clause — the whole reason the tooltip exists — had no test anywhere.
 * Shared, because the web board hides the same column and needs the same numeral (nothing
 * over there can drag a card out of DONE either, and a mirrored card that failed lands in
 * it with nobody having touched it).
 */

/** What {@link hiddenDoneSummary} answers with — the closed column, counted. */
export interface HiddenDoneSummary {
  /** Cards sitting in the DONE column. */
  total: number;
  /** How many of those the human never marked done: failed, stopped or cancelled. */
  notMarkedDone: number;
}

/**
 * The switch's label. Bare `Show Done` whenever the count would say nothing — the column
 * is open (you can see what is in it), or there is nothing in it to see.
 */
export function doneSwitchLabel(showDone: boolean, hidden: HiddenDoneSummary): string {
  if (showDone || hidden.total === 0) return 'Show Done';
  return `Show Done (${hidden.total})`;
}

/**
 * The switch's tooltip: what the count is counting, and how many of them ended badly.
 *
 * `null` — no tooltip at all — in exactly the cases the label carries no count, rather than
 * a sentence saying nothing is hidden. A tooltip that appears on every hover teaches people
 * to ignore it, and this one has to be read on the one board where it matters.
 */
export function doneSwitchTitle(showDone: boolean, hidden: HiddenDoneSummary): string | null {
  if (showDone || hidden.total === 0) return null;
  const { total, notMarkedDone } = hidden;
  if (total === 1) {
    return notMarkedDone === 0
      ? '1 finished card is hidden'
      : '1 finished card is hidden — it was cancelled, stopped or failed rather than done';
  }
  const opening = `${total} finished cards are hidden`;
  return notMarkedDone === 0
    ? opening
    : `${opening} — ${notMarkedDone} of them cancelled, stopped or failed rather than done`;
}
