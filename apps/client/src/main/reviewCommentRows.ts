/**
 * Pure mapping between a `review_drafts` row and `ReviewComment` (`@shared/review`).
 * Imports only types from `@shared/review` and never `better-sqlite3`, so it loads under
 * vitest without the native addon (see memory *the-store-has-no-tests*).
 */
import { AI_FINDING_SEVERITIES } from '@shared/aiReview';
import type { AiDraftInput, AiFindingSeverity } from '@shared/aiReview';
import { parseSubjectId, taskSubjectId, type DiffSide, type ReviewComment } from '@shared/review';

/** A review_drafts row — `ReviewComment` with `taskId` as a `subjectId` and `start` flattened into two columns. */
export interface ReviewCommentRow {
  id: string;
  subjectId: string;
  diffId: string;
  path: string;
  oldPath: string | null;
  side: string;
  line: number;
  startSide: string | null;
  startLine: number | null;
  body: string;
  excerpt: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  /** `'human'` or `'ai'`; the column defaults to `'human'` for rows from before F16. */
  origin: string;
  aiReviewId: string | null;
  severity: string | null;
  suggestion: string | null;
  acceptedAt: number | null;
  dismissedAt: number | null;
  /** `1` for a file-level AI finding, else `0`. */
  fileLevel: number;
}

function isSeverity(value: string | null): value is AiFindingSeverity {
  return (AI_FINDING_SEVERITIES as readonly (string | null)[]).includes(value);
}

function isDiffSide(value: string | null): value is DiffSide {
  return value === 'old' || value === 'new';
}

/**
 * Flattens `start` into `startSide`/`startLine`, turns an absent `oldPath` into `null`,
 * and writes `c.taskId` as `taskSubjectId(c.taskId)` — every row this writes is a task's,
 * since `addReviewComment`'s input is still `ReviewComment` shaped. Every column is
 * present, never absent — better-sqlite3 binds by named parameter and refuses an object
 * missing one the statement declares.
 */
export function reviewCommentToRow(c: ReviewComment): ReviewCommentRow {
  return {
    id: c.id,
    subjectId: taskSubjectId(c.taskId),
    diffId: c.diffId,
    path: c.path,
    oldPath: c.oldPath ?? null,
    side: c.side,
    line: c.line,
    startSide: c.start?.side ?? null,
    startLine: c.start?.line ?? null,
    body: c.body,
    excerpt: c.excerpt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sentAt: c.sentAt,
    origin: c.origin ?? 'human',
    aiReviewId: c.aiReviewId ?? null,
    severity: c.severity ?? null,
    suggestion: c.suggestion ?? null,
    acceptedAt: c.acceptedAt ?? null,
    dismissedAt: c.dismissedAt ?? null,
    fileLevel: c.fileLevel ? 1 : 0,
  };
}

/**
 * One AI draft as a row, keyed by its own `subjectId` (not a task's) and stamped `at` for
 * both timestamps. Unsent, and `origin` is always `'ai'` — this is the only writer of it.
 */
export function aiDraftToRow(d: AiDraftInput, id: string, at: number): ReviewCommentRow {
  return {
    id,
    subjectId: d.subjectId,
    diffId: d.diffId,
    path: d.path,
    oldPath: d.oldPath ?? null,
    side: d.side,
    line: d.line,
    startSide: d.start?.side ?? null,
    startLine: d.start?.line ?? null,
    body: d.body,
    excerpt: d.excerpt,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
    origin: 'ai',
    aiReviewId: d.aiReviewId,
    severity: d.severity,
    suggestion: d.suggestion,
    acceptedAt: d.acceptedAt,
    dismissedAt: d.dismissedAt,
    fileLevel: d.fileLevel ? 1 : 0,
  };
}

/**
 * The inverse of `reviewCommentToRow`. An unknown `side` degrades to `'new'` — the
 * kind-coercion defence (memory *phase24-tickets-design*) — rather than throwing on a
 * row a future rename left behind. `oldPath` and `start` are OMITTED, not set to
 * `null`/`undefined`, when their columns are NULL, so a round trip never reintroduces a
 * key the original `ReviewComment` didn't have. `start` is only built when both of its
 * columns are set and `startSide` is itself a valid side.
 *
 * The F16 AI fields follow the same rule, so a human row reads back with none of them:
 * `origin` only when `'ai'`, `fileLevel` only when `1`, the rest only when non-NULL — and an
 * unknown `severity` is omitted rather than trusted.
 *
 * `taskId` is recovered with `parseSubjectId`, falling back to `''` when `subjectId`
 * isn't a task — a case every call site that reads by task id can't actually hit, since
 * it only ever reaches a row whose `subjectId` it itself built from a `taskId`.
 */
export function rowToReviewComment(r: ReviewCommentRow): ReviewComment {
  const key = parseSubjectId(r.subjectId);
  const comment: ReviewComment = {
    id: r.id,
    taskId: key?.kind === 'task' ? key.taskId : '',
    diffId: r.diffId,
    path: r.path,
    side: isDiffSide(r.side) ? r.side : 'new',
    line: r.line,
    body: r.body,
    excerpt: r.excerpt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    sentAt: r.sentAt,
  };
  if (r.oldPath !== null) comment.oldPath = r.oldPath;
  if (r.startSide !== null && r.startLine !== null && isDiffSide(r.startSide)) {
    comment.start = { side: r.startSide, line: r.startLine };
  }
  if (r.origin === 'ai') comment.origin = 'ai';
  if (r.aiReviewId !== null) comment.aiReviewId = r.aiReviewId;
  if (isSeverity(r.severity)) comment.severity = r.severity;
  if (r.suggestion !== null) comment.suggestion = r.suggestion;
  if (r.acceptedAt !== null) comment.acceptedAt = r.acceptedAt;
  if (r.dismissedAt !== null) comment.dismissedAt = r.dismissedAt;
  if (r.fileLevel === 1) comment.fileLevel = true;
  return comment;
}
