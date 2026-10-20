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
 *
 * Below that: {@link shotPairs}, which groups the owner card's own attachments back into one
 * row per screen for the card panel's "Visual sign-off" section
 * (`packages/ui/src/VisualSignOff.tsx`), and {@link formatSignOff}/{@link parseSignOff}/
 * {@link latestVisualState}, the human-facing half of the same sign-off — read by that same
 * section to decide its pending/approved/needs-changes badge.
 */
import type { TaskAttachment } from './attachments';
import type { TaskActivityEntry } from './model';

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

/**
 * One screen's real shot, its mockup and its side-by-side page — grouped back out of the
 * owner card's flat attachment list by the names `ui-shots.mjs` wrote them under
 * (`<name>.png`, `<name>-mockup.png`, `<name>.html` — see the plan's own "names stay as the
 * script wrote them" decision). `mockup`/`html` are absent for a screen the script ran with
 * no mockup, or whose side-by-side page was never ingested; `real` is never absent — it is
 * what makes a `.png` a screen in the first place.
 */
export interface ShotPair {
  /** The screen's own name, e.g. `board-light` — `shots.json`'s own `name`. */
  name: string;
  real: TaskAttachment;
  mockup?: TaskAttachment;
  html?: TaskAttachment;
}

/** {@link shotPairs}'s own answer: every screen found, plus the shared contact sheet. */
export interface ShotPairs {
  pairs: readonly ShotPair[];
  /** `ui-shots.mjs`'s own `index.html`, linking every screen's side-by-side page. */
  indexHtml?: TaskAttachment;
}

/** Lowercased, so a name compares the way `attachmentName`'s own dedupe already does. */
function byLowerName(attachments: readonly TaskAttachment[]): Map<string, TaskAttachment> {
  return new Map(attachments.map((a) => [a.name.toLowerCase(), a]));
}

/**
 * Group an owner card's attachments into one {@link ShotPair} per screen.
 *
 * A screen is any `.png` that is not itself a `-mockup.png` — the real shot is the one file
 * every screen is guaranteed to have, so it is what this scans for; the mockup and the
 * side-by-side page are then looked up by the name that screen's shot implies. Order follows
 * `attachments`' own order (oldest first, same as `store.attachmentsForTask`).
 */
export function shotPairs(attachments: readonly TaskAttachment[]): ShotPairs {
  const byName = byLowerName(attachments);
  const pairs: ShotPair[] = [];
  for (const a of attachments) {
    const lower = a.name.toLowerCase();
    if (!lower.endsWith('.png') || lower.endsWith('-mockup.png')) continue;
    const screen = a.name.slice(0, -'.png'.length);
    pairs.push({
      name: screen,
      real: a,
      mockup: byName.get(`${screen}-mockup.png`.toLowerCase()),
      html: byName.get(`${screen}.html`.toLowerCase()),
    });
  }
  return { pairs, indexHtml: byName.get('index.html') };
}

/** The prefix that tells a human's own sign-off comment apart from the agent's — see
 *  {@link formatVisualSignOffComment}'s `Visual sign-off from "..."`, which this must never
 *  be mistaken for: that one never puts a colon directly after `sign-off`. */
export const HUMAN_SIGNOFF_PREFIX = 'Visual sign-off:';
/** What an AI reviewer's approval adds after `approved` — the only sign-off it ever posts;
 *  its needs-changes is a note of its own (`aiVisualReview.ts`), never a sign-off. */
const AI_REVIEWER_SUFFIX = '(AI reviewer)';

export type SignOffStatus = 'approved' | 'needs-changes';
/** Who posted a sign-off: the human's own button, or the project's AI reviewer. */
export type SignOffBy = 'human' | 'ai';

/**
 * The comment a human's own Approve/Needs-changes button posts via `task:addComment` —
 * `Visual sign-off: approved`, or `Visual sign-off: needs changes — <screens>` naming which
 * rows they flagged. `screens` is ignored (and may be omitted) for `'approved'`. An approval
 * `by: 'ai'` is `Visual sign-off: approved (AI reviewer)` — still an approval, so it arms
 * auto-merge through the same gate as the human's.
 */
export function formatSignOff(
  status: 'approved',
  screens?: readonly string[],
  by?: SignOffBy,
): string;
export function formatSignOff(status: 'needs-changes', screens: readonly string[]): string;
export function formatSignOff(
  status: SignOffStatus,
  screens: readonly string[] = [],
  by: SignOffBy = 'human',
): string {
  if (status === 'approved') {
    return by === 'ai'
      ? `${HUMAN_SIGNOFF_PREFIX} approved ${AI_REVIEWER_SUFFIX}`
      : `${HUMAN_SIGNOFF_PREFIX} approved`;
  }
  return `${HUMAN_SIGNOFF_PREFIX} needs changes — ${screens.join(', ')}`;
}

/** The screens a `needs changes` sign-off named, read back out of {@link formatSignOff}'s own
 *  `, `-joined list, and who posted it. */
export interface ParsedSignOff {
  status: SignOffStatus;
  screens: readonly string[];
  by: SignOffBy;
}

/** The inverse of {@link formatSignOff}, or `null` for a comment that is not one. */
export function parseSignOff(body: string): ParsedSignOff | null {
  if (!body.startsWith(HUMAN_SIGNOFF_PREFIX)) return null;
  const rest = body.slice(HUMAN_SIGNOFF_PREFIX.length).trim();
  if (rest === 'approved') return { status: 'approved', screens: [], by: 'human' };
  if (rest === `approved ${AI_REVIEWER_SUFFIX}`) {
    return { status: 'approved', screens: [], by: 'ai' };
  }
  const match = /^needs changes(?: — (.*))?$/.exec(rest);
  if (!match) return null;
  const screens = match[1]
    ? match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return { status: 'needs-changes', screens, by: 'human' };
}

/** One screen's agent verdict, as the card panel reads it back off the latest sign-off
 *  comment — `'unknown'` is "no agent verdict said anything about this screen yet", kept
 *  apart from `VisualVerdictStatus`'s `'ok'`/`'mismatch'` because a verdicts-less ingest
 *  (`formatVisualSignOffComment`'s own "a human still has to look" case) must read as this,
 *  not as a silent `ok`. */
export interface VisualRowState {
  status: 'ok' | 'mismatch' | 'unknown';
  /** Why, in the agent's own words — empty for `ok` and `unknown`. */
  note: string;
}

/** {@link latestVisualState}'s own answer: the human's current call, and the agent's latest
 *  verdict per screen. */
export interface VisualSignOffState {
  human: 'pending' | SignOffStatus;
  /** The screens named by the latest `needs changes` sign-off — empty otherwise. */
  needsChangesScreens: readonly string[];
  /** Who posted the latest sign-off — `null` while `human` is still `pending`. */
  signedOffBy: SignOffBy | null;
  rows: ReadonlyMap<string, VisualRowState>;
}

const AGENT_SIGNOFF_PREFIX = 'Visual sign-off from "';
const AGENT_NO_VERDICTS_MARK = 'screenshots attached, but no verdicts.txt';
/** `- <screen>: <note>`, one of {@link formatVisualSignOffComment}'s own mismatch lines. */
const AGENT_MISMATCH_LINE = /^- (.+): (.+)$/;

/**
 * The latest `formatVisualSignOffComment` entry's mismatch lines, by screen name — `null`
 * for an entry whose screenshots were ingested with no `verdicts.txt`, since that comment
 * names no screen as matched OR mismatched; every row stays `'unknown'` for it, same as if
 * no agent comment existed at all. A screen the map has no entry for matched.
 */
function parseAgentMismatches(body: string): ReadonlyMap<string, string> | null {
  if (body.includes(AGENT_NO_VERDICTS_MARK)) return null;
  const mismatches = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = AGENT_MISMATCH_LINE.exec(line);
    if (match) mismatches.set(match[1], match[2]);
  }
  return mismatches;
}

/**
 * The card panel's whole sign-off state for `screens` (a {@link shotPairs} result's own
 * screen names): the human's pending/approved/needs-changes call, plus the agent's latest
 * per-screen verdict.
 *
 * Both halves read the LATEST matching comment in `activity` and nothing else — an older
 * sign-off or a superseded verdict is exactly what a re-run or a second look is for.
 */
export function latestVisualState(
  activity: readonly TaskActivityEntry[],
  screens: readonly string[],
): VisualSignOffState {
  const comments = [...activity]
    .filter((e): e is TaskActivityEntry & { kind: 'comment' } => e.kind === 'comment')
    .sort((a, b) => b.createdAt - a.createdAt);

  const rows = new Map<string, VisualRowState>(
    screens.map((name) => [name, { status: 'unknown', note: '' }]),
  );
  const latestAgent = comments.find((c) => c.body.startsWith(AGENT_SIGNOFF_PREFIX));
  if (latestAgent) {
    const mismatches = parseAgentMismatches(latestAgent.body);
    if (mismatches) {
      for (const name of screens) {
        const note = mismatches.get(name);
        rows.set(
          name,
          note !== undefined ? { status: 'mismatch', note } : { status: 'ok', note: '' },
        );
      }
    }
  }

  const latestHuman = comments.find((c) => c.body.startsWith(HUMAN_SIGNOFF_PREFIX));
  const parsedHuman = latestHuman ? parseSignOff(latestHuman.body) : null;

  return {
    human: parsedHuman?.status ?? 'pending',
    needsChangesScreens: parsedHuman?.screens ?? [],
    signedOffBy: parsedHuman?.by ?? null,
    rows,
  };
}
