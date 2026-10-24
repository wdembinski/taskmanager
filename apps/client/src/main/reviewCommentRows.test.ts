/**
 * Unit tests for the pure review_drafts row mapper. No database, no Electron —
 * see the module doc for why this stays importable under plain vitest.
 */
import { describe, expect, it } from 'vitest';
import type { AiDraftInput } from '@shared/aiReview';
import type { ReviewComment } from '@shared/review';
import {
  type ReviewCommentRow,
  aiDraftToRow,
  reviewCommentToRow,
  rowToReviewComment,
} from './reviewCommentRows';

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
      subjectId: 'task:t1',
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
      origin: 'human',
      aiReviewId: null,
      severity: null,
      suggestion: null,
      acceptedAt: null,
      dismissedAt: null,
      fileLevel: 0,
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

  it('falls back to an empty taskId when subjectId is not a task — a case a task-keyed read can never hit', () => {
    const row: ReviewCommentRow = { ...reviewCommentToRow(baseComment()), subjectId: 'gh-1-2' };
    expect(rowToReviewComment(row).taskId).toBe('');
  });
});

const AI_KEYS = [
  'origin',
  'aiReviewId',
  'severity',
  'suggestion',
  'acceptedAt',
  'dismissedAt',
  'fileLevel',
] as const;

describe('the F16 AI columns', () => {
  it('round-trips an AI draft with every AI field set', () => {
    const comment = baseComment({
      origin: 'ai',
      aiReviewId: 'r1',
      severity: 'major',
      suggestion: 'return x;',
      acceptedAt: 3000,
      dismissedAt: 4000,
      fileLevel: true,
    });
    const row = reviewCommentToRow(comment);
    expect(row).toMatchObject({
      origin: 'ai',
      aiReviewId: 'r1',
      severity: 'major',
      suggestion: 'return x;',
      acceptedAt: 3000,
      dismissedAt: 4000,
      fileLevel: 1,
    });
    expect(rowToReviewComment(row)).toEqual(comment);
  });

  it('round-trips an existing human comment with none of the new keys', () => {
    const comment = baseComment({ sentAt: 2000, start: { side: 'new', line: 8 } });
    const back = rowToReviewComment(reviewCommentToRow(comment));
    expect(back).toEqual(comment);
    for (const key of AI_KEYS) expect(key in back).toBe(false);
  });

  it('reads a row with the migration defaults as a human comment', () => {
    const row: ReviewCommentRow = {
      id: 'c9',
      subjectId: 'task:t1',
      diffId: 'd1',
      path: 'a.ts',
      oldPath: null,
      side: 'new',
      line: 1,
      startSide: null,
      startLine: null,
      body: 'b',
      excerpt: 'e',
      createdAt: 1,
      updatedAt: 1,
      sentAt: null,
      origin: 'human',
      aiReviewId: null,
      severity: null,
      suggestion: null,
      acceptedAt: null,
      dismissedAt: null,
      fileLevel: 0,
    };
    const back = rowToReviewComment(row);
    for (const key of AI_KEYS) expect(key in back).toBe(false);
  });

  it('omits an unknown severity and an unknown origin', () => {
    const row: ReviewCommentRow = {
      ...reviewCommentToRow(baseComment()),
      origin: 'robot',
      severity: 'catastrophic',
    };
    const back = rowToReviewComment(row);
    expect('origin' in back).toBe(false);
    expect('severity' in back).toBe(false);
  });
});

describe('aiDraftToRow', () => {
  function draft(overrides: Partial<AiDraftInput> = {}): AiDraftInput {
    return {
      subjectId: 'gh-1-2',
      diffId: 'd1',
      path: 'src/new.ts',
      side: 'new',
      line: 20,
      body: '**Title**\n\nbody',
      excerpt: 'x = 1;',
      origin: 'ai',
      aiReviewId: 'r1',
      severity: 'nit',
      suggestion: null,
      acceptedAt: null,
      dismissedAt: null,
      fileLevel: false,
      ...overrides,
    };
  }

  it('maps start, oldPath and fileLevel onto their columns', () => {
    const row = aiDraftToRow(
      draft({ oldPath: 'src/old.ts', start: { side: 'new', line: 18 }, fileLevel: true }),
      'c1',
      5000,
    );
    expect(row).toEqual<ReviewCommentRow>({
      id: 'c1',
      subjectId: 'gh-1-2',
      diffId: 'd1',
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      side: 'new',
      line: 20,
      startSide: 'new',
      startLine: 18,
      body: '**Title**\n\nbody',
      excerpt: 'x = 1;',
      createdAt: 5000,
      updatedAt: 5000,
      sentAt: null,
      origin: 'ai',
      aiReviewId: 'r1',
      severity: 'nit',
      suggestion: null,
      acceptedAt: null,
      dismissedAt: null,
      fileLevel: 1,
    });
  });

  it('writes NULLs and fileLevel 0 for a single-line draft on an unrenamed file', () => {
    const row = aiDraftToRow(draft({ suggestion: 'y = 2;' }), 'c2', 6000);
    expect(row.oldPath).toBeNull();
    expect(row.startSide).toBeNull();
    expect(row.startLine).toBeNull();
    expect(row.fileLevel).toBe(0);
    expect(row.suggestion).toBe('y = 2;');
  });

  it('reads back as an AI draft of a task subject', () => {
    const back = rowToReviewComment(aiDraftToRow(draft({ subjectId: 'task:t7' }), 'c3', 1));
    expect(back.taskId).toBe('t7');
    expect(back.origin).toBe('ai');
    expect(back.severity).toBe('nit');
    expect('suggestion' in back).toBe(false);
    expect('fileLevel' in back).toBe(false);
  });
});
