/**
 * Unit tests for the pure ai_reviews row mapper. No database, no Electron — see the module
 * doc for why this stays importable under plain vitest.
 */
import { describe, expect, it } from 'vitest';
import { AI_REVIEW_RESULT_MAX_BYTES } from '@shared/aiReview';
import type { AiReview } from '@shared/aiReview';
import { type AiReviewRow, aiReviewToRow, capResultText, rowToAiReview } from './aiReviewRows';

function minimalReview(overrides: Partial<AiReview> = {}): AiReview {
  return {
    id: 'r1',
    subjectId: 'task:t1',
    diffId: 'd1',
    headSha: 'abc123',
    status: 'queued',
    parkReason: null,
    model: 'claude-opus-5-5',
    startedAt: null,
    finishedAt: null,
    costUsd: null,
    tokens: null,
    summary: null,
    verdict: null,
    findingCount: 0,
    droppedCount: 0,
    error: null,
    requestedBy: 'human',
    reviewDoc: 'default',
    ...overrides,
  };
}

const fullReview = minimalReview({
  status: 'done',
  parkReason: 'limit until 14:00',
  startedAt: 1000,
  finishedAt: 2000,
  costUsd: 0.42,
  tokens: { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40 },
  summary: 'Looks mostly fine.',
  verdict: 'request-changes',
  findingCount: 3,
  droppedCount: 1,
  error: 'repair turn used',
  requestedBy: 'automation',
  reviewDoc: 'REVIEW.md',
});

describe('aiReviewToRow / rowToAiReview', () => {
  it('round-trips a minimal review', () => {
    const review = minimalReview();
    const row = aiReviewToRow(review, 500);
    expect(row).toEqual<AiReviewRow>({ ...review, tokens: null, resultText: null, createdAt: 500 });
    expect(rowToAiReview(row)).toEqual(review);
  });

  it('round-trips a full review', () => {
    const row = aiReviewToRow(fullReview, 500, 'raw reply');
    expect(row.resultText).toBe('raw reply');
    expect(row.createdAt).toBe(500);
    expect(rowToAiReview(row)).toEqual(fullReview);
  });

  it('stores tokens as JSON', () => {
    const row = aiReviewToRow(fullReview, 1);
    expect(JSON.parse(row.tokens ?? '')).toEqual(fullReview.tokens);
  });

  it('caps resultText on the way in', () => {
    const row = aiReviewToRow(minimalReview(), 1, 'a'.repeat(AI_REVIEW_RESULT_MAX_BYTES + 5));
    expect(row.resultText).toHaveLength(AI_REVIEW_RESULT_MAX_BYTES);
  });

  it('never carries resultText or createdAt onto the AiReview', () => {
    const back = rowToAiReview(aiReviewToRow(fullReview, 1, 'raw'));
    expect('resultText' in back).toBe(false);
    expect('createdAt' in back).toBe(false);
  });

  it('coerces an unknown status to failed', () => {
    const row: AiReviewRow = { ...aiReviewToRow(minimalReview(), 1), status: 'exploded' };
    expect(rowToAiReview(row).status).toBe('failed');
  });

  it('coerces an unknown verdict to null', () => {
    const row: AiReviewRow = { ...aiReviewToRow(fullReview, 1), verdict: 'lgtm' };
    expect(rowToAiReview(row).verdict).toBeNull();
  });

  it('coerces an unknown requestedBy to human', () => {
    const row: AiReviewRow = { ...aiReviewToRow(minimalReview(), 1), requestedBy: 'cron' };
    expect(rowToAiReview(row).requestedBy).toBe('human');
  });

  it.each(['REVIEW.md', 'default'] as const)('round-trips reviewDoc %j', (reviewDoc) => {
    const row = aiReviewToRow(minimalReview({ reviewDoc }), 1);
    expect(row.reviewDoc).toBe(reviewDoc);
    expect(rowToAiReview(row).reviewDoc).toBe(reviewDoc);
  });

  it('reads a review from before the column (NULL) as not recorded', () => {
    const row = aiReviewToRow(minimalReview({ reviewDoc: null }), 1);
    expect(row.reviewDoc).toBeNull();
    expect(rowToAiReview(row).reviewDoc).toBeNull();
  });

  it('coerces an unknown reviewDoc to null', () => {
    const row: AiReviewRow = { ...aiReviewToRow(minimalReview(), 1), reviewDoc: 'CHECKLIST.md' };
    expect(rowToAiReview(row).reviewDoc).toBeNull();
  });

  it.each(['not json', '[1,2]', '{"inputTokens":1}', 'null', '"x"'])(
    'reads tokens %j as null',
    (tokens) => {
      const row: AiReviewRow = { ...aiReviewToRow(minimalReview(), 1), tokens };
      expect(rowToAiReview(row).tokens).toBeNull();
    },
  );
});

describe('capResultText', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it('keeps text under the cap unchanged', () => {
    expect(capResultText('hello')).toBe('hello');
  });

  it('keeps text exactly at the cap unchanged', () => {
    const text = 'x'.repeat(AI_REVIEW_RESULT_MAX_BYTES);
    expect(capResultText(text)).toBe(text);
  });

  it('cuts text over the cap to the cap', () => {
    const text = 'x'.repeat(AI_REVIEW_RESULT_MAX_BYTES + 1);
    expect(bytes(capResultText(text))).toBe(AI_REVIEW_RESULT_MAX_BYTES);
  });

  it('backs off a cut that lands inside a multi-byte character', () => {
    // 'é' is 2 bytes and '😀' is 4: the cap of 4 lands inside the emoji.
    expect(capResultText('é😀', 4)).toBe('é');
    expect(capResultText('é😀', 6)).toBe('é😀');
    expect(capResultText('é😀', 1)).toBe('');
  });

  it('never splits a code point at the real cap', () => {
    const text = `${'x'.repeat(AI_REVIEW_RESULT_MAX_BYTES - 1)}€`;
    const capped = capResultText(text);
    expect(capped).toBe('x'.repeat(AI_REVIEW_RESULT_MAX_BYTES - 1));
    expect(capped.includes('�')).toBe(false);
  });
});
