/**
 * Colouring a card's status note by keyword.
 *
 * A status note is free text — "waiting on infra for the cert", "reproduced, fixing
 * now" — because the useful thing to record is rarely one of five canned states. But
 * free text on a board is a wall of grey: you have to read every card to find the two
 * that are stuck. So the user defines a handful of KEYWORDS with colours in Settings,
 * and any note containing one is painted that colour. A note with no keyword keeps the
 * card's ordinary muted text colour — the vocabulary is an accent, never a requirement.
 *
 * Order is the user's priority control: the FIRST keyword in the list that appears in
 * the note wins, so a note that says "blocked, will review after" reads as blocked if
 * that is how they ordered them.
 */

/** One entry of the user's vocabulary: a word to look for and the colour it means. */
export interface StatusKeyword {
  keyword: string;
  /** Any CSS colour; the Settings editor writes hex from a fixed palette. */
  color: string;
}

/**
 * The colour for a status note, or null when no keyword matched (the caller then uses
 * its ordinary text colour). Matched case-insensitively as a plain substring: people
 * type "blocked on X" and "Blocker", and demanding a word boundary would miss both
 * halves of that often enough to be annoying.
 */
export function statusNoteColor(
  note: string | null | undefined,
  keywords: readonly StatusKeyword[] | undefined,
): string | null {
  if (!note || !keywords?.length) return null;
  const text = note.toLowerCase();
  for (const { keyword, color } of keywords) {
    const needle = keyword.trim().toLowerCase();
    // A blank keyword would match every note, painting the whole board one colour.
    if (needle && color && text.includes(needle)) return color;
  }
  return null;
}
