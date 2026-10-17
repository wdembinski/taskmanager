/**
 * Pure mapping between a `review_drafts` row and `ReviewComment` (`@shared/review`).
 * Imports only types from `@shared/review` and never `better-sqlite3`, so it loads under
 * vitest without the native addon (see memory *the-store-has-no-tests*).
 */
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
  return comment;
}
