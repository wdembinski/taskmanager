/**
 * The verdict sheet an agent drops beside its screenshots, and the comment it becomes.
 *
 * `scripts/ui-shots.mjs --attach` lays every screen next to its mockup in
 * `.vipper/attach/`; this is the shape of the ONE extra file an agent writes into that same
 * outbox by hand — `verdicts.txt`, one line per screen naming whether it matched. Parsing
 * and formatting both live here, in `@tm/shared`, rather than in `apps/client`'s own
 * `attachOutbox.ts` (`ingestAttachOutbox`), because the same verdicts are read again by the
 * card panel and by the PR body — three readers that must never drift into disagreeing
 * about what a line means.
 *
 * Nothing here writes `verdicts.txt` or decides which screens exist — `scripts/ui-shots.mjs`'s
 * own `SCREENS` map still owns that; an agent fills this file in per the Verification rule
 * in `CONTRIBUTING.md` §6.
 */

export const VISUAL_VERDICTS_FILE = 'verdicts.txt';

export type VisualVerdictStatus = 'ok' | 'mismatch';

/** One screen's verdict, read off one line of `verdicts.txt`. */
export interface VisualVerdict {
  /** The screen's own name, e.g. `board-light` — its screenshot is `${screen}.png`. */
  screen: string;
  status: VisualVerdictStatus;
  /** Why, in the agent's own words. Empty for `ok`. */
  note: string;
}

/** The screenshot a verdict's line names — what `ingestAttachOutbox` attaches. */
export function visualVerdictFileName(screen: string): string {
  return `${screen}.png`;
}

/** Every screenshot name a set of verdicts names, for clearing a previous ingest's set. */
export function visualVerdictFileNames(verdicts: readonly VisualVerdict[]): string[] {
  return verdicts.map((v) => visualVerdictFileName(v.screen));
}

/**
 * Parse `verdicts.txt`'s one-line-per-screen format: `<screen>: ok` or
 * `<screen>: mismatch - <why>` (the dash is optional — `mismatch the header drifted` parses
 * the same note as `mismatch - the header drifted`).
 *
 * A verdict word other than `ok`/`mismatch` is read as a `mismatch` whose note is the whole
 * remainder, on the theory that a line an agent got half-right is worth a human's look, not
 * a silent drop. Blank lines, and ones with no `:` or no screen name, are skipped.
 */
export function parseVisualVerdicts(text: string): VisualVerdict[] {
  const verdicts: VisualVerdict[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const screen = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (!screen || !rest) continue;

    const match = /^(ok|mismatch)\b[\s:-]*(.*)$/i.exec(rest);
    const status: VisualVerdictStatus =
      match && match[1].toLowerCase() === 'ok' ? 'ok' : 'mismatch';
    const note = status === 'ok' ? '' : match ? match[2].trim() : rest;
    verdicts.push({ screen, status, note });
  }
  return verdicts;
}

/** `"1 screen"` / `"2 screens"`. */
function countScreens(n: number): string {
  return `${n} screen${n === 1 ? '' : 's'}`;
}

/**
 * The comment posted on the owner card once its shots are ingested — the human-facing half
 * of the sign-off, so a look at the card's attachments and a read of its thread agree on
 * what still needs eyes.
 *
 * An empty `verdicts` (shots dropped with no `verdicts.txt`, or one that parsed to nothing)
 * still says a human has to look — silence here would read as "nothing to check" rather
 * than "nobody said".
 */
export function formatVisualSignOffComment(
  verdicts: readonly VisualVerdict[],
  stepTitle: string,
): string {
  if (verdicts.length === 0) {
    return (
      `Visual sign-off from "${stepTitle}": screenshots attached, but no verdicts.txt — ` +
      `a human still has to look.`
    );
  }
  const mismatches = verdicts.filter((v) => v.status === 'mismatch');
  const heading =
    mismatches.length === 0
      ? `Visual sign-off from "${stepTitle}": all ${countScreens(verdicts.length)} matched the mockup.`
      : `Visual sign-off from "${stepTitle}": ${countScreens(mismatches.length)} of ` +
        `${verdicts.length} need a look.`;
  if (mismatches.length === 0) return heading;

  const lines = mismatches.map((v) => `- ${v.screen}: ${v.note || 'flagged, no reason given'}`);
  return [heading, '', ...lines].join('\n');
}
