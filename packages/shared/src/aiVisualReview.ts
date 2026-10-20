/**
 * The pure half of "Visual sign-off by AI reviewer" — the project setting that lets a fresh,
 * read-only review session judge a UI card's shots instead of waiting for the owner's Approve.
 *
 * Everything here reads or writes the card's own timeline, the only record that survives a
 * restart: whether to review now ({@link aiReviewNext}), what a finished review means
 * ({@link aiReviewOutcome}), whether a human overtook it ({@link aiReviewSuperseded}), the
 * verdict the session hands back ({@link parseAiReviewVerdict}), and the notes it leaves.
 *
 * Only an AI APPROVAL is a `Visual sign-off:` comment (`formatSignOff('approved', [], 'ai')`),
 * so it arms auto-merge through the same gate as the human's button. An AI needs-changes is a
 * note of its own: posting a sign-off would flip the gate to `needs-changes`, and the fix
 * step's push would then never reach `await-sign-off` again to trigger the next review.
 * A human's own sign-off always wins, because the latest `Visual sign-off:` comment does.
 */
import type { TaskActivityEntry } from './model';
import { HUMAN_SIGNOFF_PREFIX } from './visualSignOff';

/**
 * The rubric the reviewer judges by — quoted verbatim in the review prompt and in
 * CONTRIBUTING.md §6's "Verification — the AI reviewer's rubric".
 */
export const AI_REVIEW_RUBRIC = [
  '- judge ONLY what this ticket adds or changes; the mockup is the intent for that part, not a pixel spec;',
  '- every element the ticket asks for is visible, readable and in the right place, in light and dark;',
  '- nothing clipped, overlapping, empty where it should have content, or showing a raw error/placeholder;',
  "- shell or styling differences outside the ticket's scope (old layout vs a newer mockup) are NOT a mismatch — note them, don't fail on them.",
].join('\n');

/** The prefix of the note a review run leaves as it starts. */
export const AI_REVIEW_STARTED_PREFIX = 'AI visual review started';
/** The prefix of a needs-changes note — one per automatic fix round. */
export const AI_REVIEW_NEEDS_CHANGES_PREFIX = 'AI visual review: needs changes';
/** The prefix of the note left once the rounds run out and a human has to look. */
export const AI_REVIEW_GAVE_UP_PREFIX = 'AI visual review: stopped after';
/** The prefix of the note left for a verdict that could not be read — never a round. */
export const AI_REVIEW_INVALID_PREFIX = 'AI visual review: no readable verdict';

/** One screen's call in the reviewer's verdict. */
export interface AiReviewScreen {
  screen: string;
  status: 'ok' | 'mismatch';
  /** Why, in the reviewer's words — empty when it gave none. */
  reason: string;
}

/** The fenced ```json block the review session ends its answer with. */
export interface AiReviewVerdict {
  verdict: 'approve' | 'needs-changes';
  screens: readonly AiReviewScreen[];
  /** Differences the reviewer saw outside the ticket's scope — noted, never failed on. */
  outOfScope: readonly string[];
}

/**
 * What {@link aiReviewNext} answers when a UI card's auto-merge is held for sign-off:
 *
 * - `await-human` — leave it to the owner's own Approve/Needs changes: the setting is off, or
 *   the reviewer already gave up since the latest sign-off (so the Inbox is raised once, not
 *   on every push).
 * - `review` — start a review round.
 * - `exhausted` — more fix rounds already ran than the setting allows now (it was lowered);
 *   give up without reviewing.
 */
export type AiReviewNext = 'await-human' | 'review' | 'exhausted';

/**
 * What {@link aiReviewOutcome} makes of a finished review:
 *
 * - `approve` — post the AI sign-off.
 * - `fix-step` — post a needs-changes note and add a fix step to the card.
 * - `exhausted` — the fix rounds are used up; post the gave-up note and raise the Inbox.
 * - `invalid` — no readable verdict; note it and raise the Inbox, counting no round.
 */
export type AiReviewOutcome = 'approve' | 'fix-step' | 'exhausted' | 'invalid';

type Comment = TaskActivityEntry & { kind: 'comment' };

/** The card's comments newer than its latest `Visual sign-off:` comment — the current
 *  review cycle, since any sign-off (human or AI) starts the count over. */
function sinceLatestSignOff(activity: readonly TaskActivityEntry[]): Comment[] {
  const comments = activity.filter((e): e is Comment => e.kind === 'comment');
  const latest = comments
    .filter((c) => c.body.startsWith(HUMAN_SIGNOFF_PREFIX))
    .reduce((max, c) => Math.max(max, c.createdAt), -Infinity);
  return comments.filter((c) => c.createdAt > latest);
}

/** How many automatic fix rounds ran since the latest sign-off — the needs-changes notes. */
export function aiReviewRoundsSoFar(activity: readonly TaskActivityEntry[]): number {
  return sinceLatestSignOff(activity).filter((c) =>
    c.body.startsWith(AI_REVIEW_NEEDS_CHANGES_PREFIX),
  ).length;
}

/**
 * Whether to run the AI reviewer now, for a card whose auto-merge is held for sign-off.
 * `maxRounds` is the number of automatic FIX steps: with 2, the card is reviewed up to three
 * times; with 0, once and never fixed.
 */
export function aiReviewNext(input: {
  enabled: boolean;
  maxRounds: number;
  activity: readonly TaskActivityEntry[];
}): AiReviewNext {
  if (!input.enabled) return 'await-human';
  const cycle = sinceLatestSignOff(input.activity);
  if (cycle.some((c) => c.body.startsWith(AI_REVIEW_GAVE_UP_PREFIX))) return 'await-human';
  const rounds = cycle.filter((c) => c.body.startsWith(AI_REVIEW_NEEDS_CHANGES_PREFIX)).length;
  return rounds > input.maxRounds ? 'exhausted' : 'review';
}

/** Whether a review needs changes — an `approve` that still flags a screen does too. */
function needsChanges(verdict: AiReviewVerdict): boolean {
  return (
    verdict.verdict === 'needs-changes' || verdict.screens.some((s) => s.status === 'mismatch')
  );
}

/** What a finished review means, given the fix rounds already run ({@link aiReviewRoundsSoFar}). */
export function aiReviewOutcome(
  verdict: AiReviewVerdict | null,
  roundsSoFar: number,
  maxRounds: number,
): AiReviewOutcome {
  if (!verdict) return 'invalid';
  if (!needsChanges(verdict)) return 'approve';
  return roundsSoFar < maxRounds ? 'fix-step' : 'exhausted';
}

/** True when a `Visual sign-off:` comment landed after the review started — a human (or an
 *  earlier reviewer) already decided, so this review's result is discarded. */
export function aiReviewSuperseded(
  activity: readonly TaskActivityEntry[],
  startedAt: number,
): boolean {
  return activity.some(
    (e) =>
      e.kind === 'comment' && e.body.startsWith(HUMAN_SIGNOFF_PREFIX) && e.createdAt >= startedAt,
  );
}

const JSON_FENCE = /```json[^\n]*\n([\s\S]*?)```/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScreen(value: unknown): AiReviewScreen | null {
  if (!isRecord(value)) return null;
  const { screen, status, reason } = value;
  if (typeof screen !== 'string' || !screen.trim()) return null;
  if (status !== 'ok' && status !== 'mismatch') return null;
  return { screen: screen.trim(), status, reason: typeof reason === 'string' ? reason.trim() : '' };
}

/**
 * The verdict out of the review session's `resultText` — its LAST fenced ```json block, so a
 * reviewer that drafts one and then corrects itself is read by its final answer. `null` for
 * no block, bad JSON, or any field of the wrong shape: a half-read verdict is never acted on.
 */
export function parseAiReviewVerdict(resultText: string): AiReviewVerdict | null {
  const blocks = [...resultText.matchAll(JSON_FENCE)];
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(last[1]);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { verdict, screens, outOfScope } = raw;
  if (verdict !== 'approve' && verdict !== 'needs-changes') return null;
  if (!Array.isArray(screens)) return null;
  const parsed = screens.map(parseScreen);
  if (parsed.some((s) => s === null)) return null;
  if (outOfScope !== undefined && !Array.isArray(outOfScope)) return null;
  return {
    verdict,
    screens: parsed as AiReviewScreen[],
    outOfScope: (outOfScope ?? []).filter((s): s is string => typeof s === 'string'),
  };
}

/** `"1 round"` / `"2 rounds"`. */
function countRounds(n: number): string {
  return `${n} round${n === 1 ? '' : 's'}`;
}

/** The `- <screen>: <reason>` lines, then the out-of-scope ones, under a note's heading. */
function withReasons(heading: string, verdict: AiReviewVerdict): string {
  const lines = verdict.screens
    .filter((s) => s.status === 'mismatch')
    .map((s) => `- ${s.screen}: ${s.reason || 'flagged, no reason given'}`);
  const parts = [heading];
  if (lines.length > 0) parts.push('', ...lines);
  if (verdict.outOfScope.length > 0) {
    parts.push('', 'Out of scope (not a mismatch):', ...verdict.outOfScope.map((s) => `- ${s}`));
  }
  return parts.join('\n');
}

/** The note a review leaves as it starts — `round` of every review the setting allows. */
export function aiReviewStartedNote(round: number, maxRounds: number): string {
  return `${AI_REVIEW_STARTED_PREFIX} (round ${round} of ${maxRounds + 1}).`;
}

/** The note for a needs-changes review that adds fix step `round` of `maxRounds`. */
export function aiReviewNeedsChangesNote(
  round: number,
  maxRounds: number,
  verdict: AiReviewVerdict,
): string {
  return withReasons(`${AI_REVIEW_NEEDS_CHANGES_PREFIX} (round ${round} of ${maxRounds})`, verdict);
}

/** The note left once the reviewer gives up after `rounds` reviews. */
export function aiReviewGaveUpNote(rounds: number, verdict: AiReviewVerdict): string {
  return withReasons(
    `${AI_REVIEW_GAVE_UP_PREFIX} ${countRounds(rounds)} — a human has to look.`,
    verdict,
  );
}

/** The Inbox question raised with the gave-up note. */
export function aiReviewInboxQuestion(rounds: number): string {
  return (
    `AI visual review could not approve after ${countRounds(rounds)} — check the shots and ` +
    `press Approve or Needs changes.`
  );
}

/** The note for a review that ended without a readable verdict. */
export function aiReviewInvalidNote(): string {
  return `${AI_REVIEW_INVALID_PREFIX} — a human has to look.`;
}

/** The Inbox question raised with {@link aiReviewInvalidNote}. */
export function aiReviewInvalidInboxQuestion(): string {
  return (
    'AI visual review returned no readable verdict — check the shots and press Approve or ' +
    'Needs changes.'
  );
}
