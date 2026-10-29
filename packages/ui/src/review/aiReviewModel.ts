/**
 * The pure half of *Ask AI to review* (F16.13): a subject's AI reviews, its diff summary and the
 * last refused start in, the one control the workspace header draws out — no transport, no
 * clock of its own, so a test can walk every status through it.
 *
 * **Which review counts.** `aiReview:list` answers newest first, and `useAiReview` keeps its
 * list in that order (a fresh review is prepended, a changed one replaced in place), so the
 * latest is the first row for the subject.
 *
 * **Why the button is disabled.** In order: the desktop is unreachable, a start is in flight,
 * the last start was refused (its reason, verbatim), then `aiReviewPrecheck` — the same strings
 * the main process refuses with, so the tooltip never disagrees with the refusal it saves.
 *
 * **Colour.** Only `running` moves, so only `running` is drawn in the run colour; a queued or
 * parked review is a neutral chip that names what it waits for, never a spinner.
 */
import { formatElapsed } from '@tm/shared/elapsed';
import { aiReviewPrecheck, type AiReview, type AiReviewVerdict } from '@tm/shared/aiReview';
import type { DiffSummary } from '@tm/shared/review';
import { formatCost } from '../usageFormat';

/** What the header's AI slot draws. `reason` is a disabled button's tooltip; null = enabled. */
export type AiReviewControlState =
  | { kind: 'ask'; label: string; reason: string | null }
  | { kind: 'running'; chip: string }
  | { kind: 'queued'; chip: string }
  | { kind: 'parked'; chip: string }
  | { kind: 'failed'; label: string; error: string; reason: string | null }
  | { kind: 'done'; label: string; reason: string | null };

export interface AiReviewControlInput {
  /** {@link latestReview}'s answer for the selected subject. */
  review: AiReview | null;
  /** The selected subject's diff summary; null while loading or with nothing to diff. */
  summary: DiffSummary | null;
  /** The last `aiReview:start` refusal's reason for this subject, until a review arrives. */
  refusal: string | null;
  /** An `aiReview:start` call is in flight. */
  starting: boolean;
  /** The desktop host cannot be reached (the web). */
  unreachable: boolean;
  /** The clock a running review's elapsed time is measured against. */
  now: number;
}

const ASK = 'Ask AI to review';
const ASK_AGAIN = 'Ask AI again';

/** The newest review of `subjectId` in a newest-first list — see the module header. */
export function latestReview(reviews: readonly AiReview[], subjectId: string): AiReview | null {
  return reviews.find((r) => r.subjectId === subjectId) ?? null;
}

/** The disabled button's tooltip, or null when asking is allowed — see the module header. */
function askBlocker(input: AiReviewControlInput): string | null {
  if (input.unreachable) return 'the desktop app is unreachable';
  if (input.starting) return 'asking the AI…';
  if (input.refusal !== null) return input.refusal;
  if (input.summary === null) return 'there are no changes to review';
  return aiReviewPrecheck(input.summary);
}

/** "parked — usage limit, resumes 14:05" or "parked — signed out of Claude Code". */
export function shortPark(review: Pick<AiReview, 'status' | 'parkReason'>): string {
  if (review.status === 'parked-signin') return 'parked — signed out of Claude Code';
  // The scheduler writes "usage limit reached — resumes at <toLocaleTimeString()>".
  const at = /resumes at (.+)$/.exec(review.parkReason ?? '')?.[1]?.trim();
  if (!at) return 'parked — usage limit';
  return `parked — usage limit, resumes ${at.replace(/^(\d{1,2}:\d{2}):\d{2}/, '$1')}`;
}

/** The running chip: elapsed time, then the cost once a turn has reported one. */
function runningChip(review: AiReview, now: number): string {
  const parts = ['AI reviewing…'];
  if (review.startedAt !== null) parts.push(formatElapsed(now - review.startedAt));
  const text = parts.join(' ');
  return review.costUsd === null ? text : `${text} · ${formatCost(review.costUsd)}`;
}

function findings(n: number): string {
  return `${n} finding${n === 1 ? '' : 's'}`;
}

/** What the header's AI slot draws for `input`. */
export function aiReviewControlState(input: AiReviewControlInput): AiReviewControlState {
  const { review } = input;
  switch (review?.status) {
    case 'running':
      return { kind: 'running', chip: runningChip(review, input.now) };
    case 'queued':
      return { kind: 'queued', chip: 'AI review queued' };
    case 'parked-limit':
    case 'parked-signin':
      return { kind: 'parked', chip: shortPark(review) };
    case 'failed':
      return {
        kind: 'failed',
        label: ASK_AGAIN,
        error: review.error ?? 'the AI review failed',
        reason: askBlocker(input),
      };
    case 'done':
      return {
        kind: 'done',
        label: `AI: ${findings(review.findingCount)}`,
        reason: askBlocker(input),
      };
    default:
      // No review yet, or the last one was cancelled.
      return { kind: 'ask', label: ASK, reason: askBlocker(input) };
  }
}

/** "3 findings · 1 dropped · $1.84 · Sonnet 5" — the cost left out until one is known. */
export function summaryLine(review: AiReview, modelLabel: string): string {
  const parts = [findings(review.findingCount), `${review.droppedCount} dropped`];
  if (review.costUsd !== null) parts.push(formatCost(review.costUsd));
  parts.push(modelLabel);
  return parts.join(' · ');
}

const VERDICT_TEXT: Record<AiReviewVerdict, string> = {
  approve: 'Approve',
  comment: 'Comment',
  'request-changes': 'Request changes',
};

/** The verdict as plain text: "Approve", "Comment" or "Request changes". */
export function verdictText(verdict: AiReviewVerdict): string {
  return VERDICT_TEXT[verdict];
}

/** "used REVIEW.md" / "used the default checklist"; null for a review from before it was kept. */
export function checklistLine(review: Pick<AiReview, 'reviewDoc'>): string | null {
  if (review.reviewDoc === 'REVIEW.md') return 'used REVIEW.md';
  if (review.reviewDoc === 'default') return 'used the default checklist';
  return null;
}
