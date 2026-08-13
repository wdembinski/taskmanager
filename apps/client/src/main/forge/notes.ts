/**
 * The newest note on a merge request that somebody ELSE wrote — whichever forge it came from.
 *
 * This lived inside `gitlab/gitlabSync.ts` until GitHub needed the same signal, and lifting it
 * is the point rather than a tidy-up. The rule it encodes is *your own comments are not news*,
 * and it is the whole difference between an unread ring that means something and one that
 * every merge request you have ever spoken on wears for good. A second forge re-deriving it
 * would have derived it slightly differently — that is what happened to the removal guard
 * before `forge/removalGuard.ts` existed — and the only symptom would be a board that shouts.
 *
 * Pure: no DB, no Electron, no network.
 */

/**
 * The author of a note, in the spellings the two forges use.
 *
 * Both fields are here rather than one normalised `name`, because normalising would put the
 * decision *which field identifies a person* in the wrong place: GitLab's `username` and
 * GitHub's `login` are the same idea but they are issued by different servers, and only the
 * forge's own `identity.ts` knows which one its identity cache holds. So the shape is shared
 * and the comparison is not — see {@link latestForeignNoteAt}'s `isMine`.
 */
export interface ForgeNoteAuthor {
  /** The numeric user id — stable across renames, and what both forges put on a comment. */
  id?: number;
  /** GitLab's spelling. */
  username?: string;
  /** GitHub's spelling of the same thing. */
  login?: string;
}

/**
 * One note, reduced to the two things attention depends on.
 *
 * `createdAt` is the forge's own timestamp string rather than a number, because that is what
 * arrives on the wire and parsing it in one place means one rule for what an unparseable one
 * does. The body is deliberately absent: nothing here reads a comment, it only asks *when*
 * and *whose*.
 */
export interface ForgeNote {
  /** ISO 8601, as the forge wrote it. */
  createdAt: string;
  author?: ForgeNoteAuthor | null;
}

/**
 * The newest note NOT written by you, in epoch ms, or null when there is none.
 *
 * `isMine` is a predicate rather than an identity object on purpose: GitLab matches an author
 * by id then `username`, GitHub by id then `login`, and folding both into this function would
 * make it the third place that has to be told about a new forge. Passing the forge's own
 * `…AuthorIsMe` keeps that knowledge where the identity cache already is.
 *
 * Null has one meaning and it is not "no comments": the callers spell an *unfetched*
 * discussion as `notes === undefined` and keep what they knew, so null here only ever narrows
 * to "nothing newer than what we already recorded".
 */
export function latestForeignNoteAt<T extends ForgeNote>(
  notes: readonly T[],
  isMine: (note: T) => boolean,
): number | null {
  let latest: number | null = null;
  for (const note of notes) {
    if (isMine(note)) continue;
    const at = Date.parse(note.createdAt);
    // An unparseable timestamp is skipped rather than read as the epoch: a zero would sort
    // below every real note and quietly claim the discussion had not moved.
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}
