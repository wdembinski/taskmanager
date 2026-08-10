/**
 * Working out which ticket a merge request belongs to.
 *
 * GitLab has no idea about JIRA, so the link is whatever the human typed: a branch named
 * `feature/ENG-431`, a title starting `ENG-431:`, a description mentioning it. Scanning
 * for "something that looks like a key" alone is far too eager — `UTF-8`, `ISO-8601`,
 * `RFC-2119` and `IE-11` all match the shape — so every candidate is intersected with
 * the keys the board ACTUALLY holds. A key nothing on the board carries is not a key.
 *
 * Pure: no fetch, no DB.
 */

/**
 * Anything shaped like a tracker key: letters, then `-` or `_`, then digits.
 *
 * `_` is accepted because branch names often carry `eng_431` where a slug has replaced
 * the dash, and normalised back to `-` so it compares against the real key.
 *
 * The trailing guard is `(?![A-Za-z0-9])` rather than `\b`: in `eng_431_login` there is
 * no word boundary after `431` — `_` is itself a word character — so `\b` matched
 * nothing at all on exactly the branch names this is meant to read.
 */
const KEY_PATTERN = /([A-Za-z][A-Za-z0-9]*)[-_](\d+)(?![A-Za-z0-9])/g;

/** Every distinct key-shaped token in a string, upper-cased and dash-normalised. */
function candidates(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(KEY_PATTERN)) {
    out.add(`${match[1].toUpperCase()}-${match[2]}`);
  }
  return [...out];
}

export interface MergeRequestText {
  title?: string | null;
  description?: string | null;
  sourceBranch?: string | null;
}

/**
 * The board keys this MR names, in the order the sources are trusted: branch first
 * (someone deliberately named it), then title, then description (where a key is often
 * just a passing reference).
 *
 * `knownKeys` is the whole safety net — without it, "bump to UTF-8" files an MR under a
 * ticket called UTF-8. Matching is case-insensitive; the returned keys are the board's
 * own spelling, so callers can compare them directly.
 */
export function discoverIssueKeys(mr: MergeRequestText, knownKeys: readonly string[]): string[] {
  const known = new Map(knownKeys.map((k) => [k.trim().toUpperCase(), k]));
  if (known.size === 0) return [];

  const found: string[] = [];
  for (const source of [mr.sourceBranch, mr.title, mr.description]) {
    if (!source) continue;
    for (const candidate of candidates(source)) {
      const real = known.get(candidate);
      if (real && !found.includes(real)) found.push(real);
    }
  }
  return found;
}

/**
 * The one key an MR is filed under, or null.
 *
 * The first, which by the ordering above means the branch's key beats the title's. An MR
 * naming two tickets is filed under the one whose branch it is on — that is the ticket
 * being worked; the others are references. Every key is still stored, so a later change
 * to the board can re-match without re-reading GitLab.
 */
export function pickTaskKey(keys: readonly string[]): string | null {
  return keys[0] ?? null;
}
