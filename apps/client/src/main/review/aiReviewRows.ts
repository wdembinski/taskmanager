/**
 * Pure mapping between an `ai_reviews` row and `AiReview` (`@shared/aiReview`). Never imports
 * `better-sqlite3`, so it loads under vitest without the native addon (see memory
 * *the-store-has-no-tests*), like `../reviewCommentRows`.
 */
import { AI_REVIEW_RESULT_MAX_BYTES } from '@shared/aiReview';
import type {
  AiReview,
  AiReviewRequester,
  AiReviewStatus,
  AiReviewTokens,
  AiReviewVerdict,
} from '@shared/aiReview';

/**
 * An ai_reviews row — `AiReview` with `tokens` as JSON, plus the capped raw `resultText`
 * (kept for debugging, never on `AiReview`) and the row's `createdAt`.
 */
export interface AiReviewRow {
  id: string;
  subjectId: string;
  diffId: string;
  headSha: string;
  status: string;
  parkReason: string | null;
  model: string;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number | null;
  tokens: string | null;
  summary: string | null;
  verdict: string | null;
  findingCount: number;
  droppedCount: number;
  error: string | null;
  requestedBy: string;
  resultText: string | null;
  createdAt: number;
}

const STATUSES: readonly AiReviewStatus[] = [
  'queued',
  'running',
  'parked-limit',
  'parked-signin',
  'failed',
  'done',
  'cancelled',
];
const VERDICTS: readonly AiReviewVerdict[] = ['approve', 'comment', 'request-changes'];
const REQUESTERS: readonly AiReviewRequester[] = ['human', 'automation'];

function isOneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return (values as readonly (string | null)[]).includes(value);
}

/**
 * `text` cut to at most `AI_REVIEW_RESULT_MAX_BYTES` UTF-8 bytes, never splitting a code
 * point: the cut backs off past any continuation bytes to the start of the character it
 * landed in, so the kept prefix always decodes cleanly.
 */
export function capResultText(text: string, maxBytes = AI_REVIEW_RESULT_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function parseTokens(json: string | null): AiReviewTokens | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const t = value as Record<string, unknown>;
    const keys = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
    if (!keys.every((k) => typeof t[k] === 'number')) return null;
    return {
      inputTokens: t.inputTokens as number,
      outputTokens: t.outputTokens as number,
      cacheCreationTokens: t.cacheCreationTokens as number,
      cacheReadTokens: t.cacheReadTokens as number,
    };
  } catch {
    return null;
  }
}

/**
 * Every column present, never absent — better-sqlite3 binds by named parameter and refuses
 * an object missing one the statement declares. `resultText` is capped on the way in.
 */
export function aiReviewToRow(
  r: AiReview,
  createdAt: number,
  resultText: string | null = null,
): AiReviewRow {
  return {
    id: r.id,
    subjectId: r.subjectId,
    diffId: r.diffId,
    headSha: r.headSha,
    status: r.status,
    parkReason: r.parkReason,
    model: r.model,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    costUsd: r.costUsd,
    tokens: r.tokens === null ? null : JSON.stringify(r.tokens),
    summary: r.summary,
    verdict: r.verdict,
    findingCount: r.findingCount,
    droppedCount: r.droppedCount,
    error: r.error,
    requestedBy: r.requestedBy,
    resultText: resultText === null ? null : capResultText(resultText),
    createdAt,
  };
}

/**
 * The inverse of `aiReviewToRow`, dropping `resultText` and `createdAt`. The enums are plain
 * TEXT, so each is coerced rather than trusted (the kind-coercion defence, memory
 * *phase24-tickets-design*): an unknown `status` reads as `'failed'`, an unknown `verdict` as
 * `null`, an unknown `requestedBy` as `'human'`, and `tokens` that do not parse as `null`.
 */
export function rowToAiReview(r: AiReviewRow): AiReview {
  return {
    id: r.id,
    subjectId: r.subjectId,
    diffId: r.diffId,
    headSha: r.headSha,
    status: isOneOf(STATUSES, r.status) ? r.status : 'failed',
    parkReason: r.parkReason,
    model: r.model,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    costUsd: r.costUsd,
    tokens: parseTokens(r.tokens),
    summary: r.summary,
    verdict: isOneOf(VERDICTS, r.verdict) ? r.verdict : null,
    findingCount: r.findingCount,
    droppedCount: r.droppedCount,
    error: r.error,
    requestedBy: isOneOf(REQUESTERS, r.requestedBy) ? r.requestedBy : 'human',
  };
}
