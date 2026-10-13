/**
 * Unit tests for the pure review_comments row mapper. No database, no Electron —
 * see the module doc for why this stays importable under plain vitest.
 */
import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '@shared/review';
import { type ReviewCommentRow, reviewCommentToRow, rowToReviewComment } from './reviewCommentRows';

function baseComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    taskId: 't1',
    diffId: 'd1',
    path: 'src/foo.ts',
    side: 'new',
    line: 10,
    body: 'why does this branch exist?',
    excerpt: 'if (x) {',
    createdAt: 1000,
    updatedAt: 1000,
    sentAt: null,
    ...overrides,
  };
}

describe('reviewCommentToRow / rowToReviewComment', () => {
  it('round-trips a single-line comment', () => {
    const comment = baseComment();
    const row = reviewCommentToRow(comment);
    expect(row).toEqual<ReviewCommentRow>({
      id: 'c1',
      taskId: 't1',
      diffId: 'd1',
      path: 'src/foo.ts',
      oldPath: null,
      side: 'new',
      line: 10,
      startSide: null,
      startLine: null,
      body: 'why does this branch exist?',
      excerpt: 'if (x) {',
      createdAt: 1000,
      updatedAt: 1000,
      sentAt: null,
    });
    expect(rowToReviewComment(row)).toEqual(comment);
  });

  it('round-trips a range comment (start set)', () => {
    const comment = baseComment({ line: 15, start: { side: 'new', line: 12 } });
    const row = reviewCommentToRow(comment);
    expect(row.startSide).toBe('new');
    expect(row.startLine).toBe(12);
    expect(rowToReviewComment(row)).toEqual(comment);
  });

  it('round-trips a renamed-file old-side comment with oldPath', () => {
    const comment = baseComment({
      path: 'src/renamed.ts',
      oldPath: 'src/original.ts',
      side: 'old',
      line: 3,
    });
    const row = reviewCommentToRow(comment);
    expect(row.oldPath).toBe('src/original.ts');
    expect(rowToReviewComment(row)).toEqual(comment);
  });

  it('round-trips a sent comment', () => {
    const comment = baseComment({ sentAt: 2000 });
    const row = reviewCommentToRow(comment);
    expect(row.sentAt).toBe(2000);
    expect(rowToReviewComment(row)).toEqual(comment);
  });

  it('omits oldPath on the way back when the column is NULL, rather than nulling it', () => {
    const row = reviewCommentToRow(baseComment());
    const back = rowToReviewComment(row);
    expect('oldPath' in back).toBe(false);
  });

  it('omits start on the way back when both columns are NULL', () => {
    const row = reviewCommentToRow(baseComment());
    const back = rowToReviewComment(row);
    expect('start' in back).toBe(false);
  });

  it('drops to no start when startSide is set but startLine is not (a half-set start)', () => {
    const row: ReviewCommentRow = {
      ...reviewCommentToRow(baseComment()),
      startSide: 'new',
      startLine: null,
    };
    const back = rowToReviewComment(row);
    expect('start' in back).toBe(false);
  });

  it('coerces an unknown side to "new"', () => {
    const row: ReviewCommentRow = { ...reviewCommentToRow(baseComment()), side: 'weird' };
    expect(rowToReviewComment(row).side).toBe('new');
  });

  it('coerces an unknown startSide to no start at all', () => {
    const row: ReviewCommentRow = {
      ...reviewCommentToRow(baseComment()),
      startSide: 'weird',
      startLine: 5,
    };
    const back = rowToReviewComment(row);
    expect('start' in back).toBe(false);
  });
});
