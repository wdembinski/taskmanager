import { describe, expect, it } from 'vitest';
import type { ReviewComment } from './review';
import { isSendableDraft } from './review';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    taskId: 'task-1',
    diffId: 'diff-1',
    path: 'src/example.ts',
    side: 'new',
    line: 1,
    body: 'Rename this.',
    excerpt: 'const a = 1;',
    createdAt: 1,
    updatedAt: 1,
    sentAt: null,
    ...overrides,
  };
}

describe('isSendableDraft', () => {
  it('sends an unsent human draft', () => {
    expect(isSendableDraft(comment())).toBe(true);
    expect(isSendableDraft(comment({ origin: 'human' }))).toBe(true);
  });

  it('holds back an AI draft nobody accepted yet', () => {
    expect(isSendableDraft(comment({ origin: 'ai', acceptedAt: null, dismissedAt: null }))).toBe(
      false,
    );
    expect(isSendableDraft(comment({ origin: 'ai' }))).toBe(false);
  });

  it('sends an accepted AI draft', () => {
    expect(isSendableDraft(comment({ origin: 'ai', acceptedAt: 5, dismissedAt: null }))).toBe(true);
  });

  it('never sends a dismissed draft, whoever wrote it', () => {
    expect(isSendableDraft(comment({ origin: 'ai', dismissedAt: 5 }))).toBe(false);
    expect(isSendableDraft(comment({ origin: 'ai', acceptedAt: 4, dismissedAt: 5 }))).toBe(false);
    expect(isSendableDraft(comment({ dismissedAt: 5 }))).toBe(false);
  });

  it('never sends a comment that already went out', () => {
    expect(isSendableDraft(comment({ sentAt: 9 }))).toBe(false);
    expect(isSendableDraft(comment({ origin: 'ai', acceptedAt: 5, sentAt: 9 }))).toBe(false);
  });
});
