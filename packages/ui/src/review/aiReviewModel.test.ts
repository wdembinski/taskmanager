import { describe, expect, it } from 'vitest';
import type { AiReview } from '@tm/shared/aiReview';
import type { DiffFileEntry, DiffSummary } from '@tm/shared/review';
import { FORGE_API_CAPABILITIES, WORKTREE_CAPABILITIES } from '@tm/shared/review';
import {
  aiReviewControlState,
  checklistLine,
  latestReview,
  shortPark,
  summaryLine,
  verdictText,
  type AiReviewControlInput,
} from './aiReviewModel';

function review(over: Partial<AiReview> = {}): AiReview {
  return {
    id: 'r1',
    subjectId: 'pr:1',
    diffId: 'd1',
    headSha: 'abc',
    status: 'done',
    parkReason: null,
    model: 'claude-sonnet-5',
    startedAt: 1_000,
    finishedAt: 2_000,
    costUsd: 1.84,
    tokens: null,
    summary: 'Looks fine.',
    verdict: 'comment',
    findingCount: 3,
    droppedCount: 1,
    error: null,
    requestedBy: 'human',
    reviewDoc: 'default',
    ...over,
  };
}

function entry(path: string, additions = 3): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions,
    deletions: 0,
    binary: false,
    image: false,
    bytes: 100,
  };
}

function diff(over: Partial<DiffSummary> = {}): DiffSummary {
  return {
    diffId: 'd1',
    baseRef: 'development',
    baseSha: 'base',
    headSha: 'abc',
    includesWorkingTree: false,
    files: [entry('a.ts')],
    truncated: false,
    source: 'worktree',
    capabilities: WORKTREE_CAPABILITIES,
    ...over,
  };
}

function input(over: Partial<AiReviewControlInput> = {}): AiReviewControlInput {
  return {
    review: null,
    summary: diff(),
    refusal: null,
    starting: false,
    unreachable: false,
    now: 73_000,
    ...over,
  };
}

describe('latestReview', () => {
  it('takes the first row for the subject from a newest-first list', () => {
    const rows = [review({ id: 'other', subjectId: 'pr:2' }), review({ id: 'new' }), review()];
    expect(latestReview(rows, 'pr:1')?.id).toBe('new');
    expect(latestReview(rows, 'pr:3')).toBeNull();
    expect(latestReview([], 'pr:1')).toBeNull();
  });
});

describe('aiReviewControlState', () => {
  it('offers a review when there is none, or the last was cancelled', () => {
    expect(aiReviewControlState(input())).toEqual({
      kind: 'ask',
      label: 'Ask AI to review',
      reason: null,
    });
    expect(aiReviewControlState(input({ review: review({ status: 'cancelled' }) }))).toEqual({
      kind: 'ask',
      label: 'Ask AI to review',
      reason: null,
    });
  });

  it('draws a running chip with elapsed time, and the cost only once one is known', () => {
    const first = aiReviewControlState(
      input({ review: review({ status: 'running', costUsd: null, startedAt: 1_000 }) }),
    );
    expect(first).toEqual({ kind: 'running', chip: 'AI reviewing… 1m 12s' });
    const later = aiReviewControlState(
      input({ review: review({ status: 'running', costUsd: 0.42, startedAt: 1_000 }) }),
    );
    expect(later).toEqual({ kind: 'running', chip: 'AI reviewing… 1m 12s · $0.4200' });
  });

  it('draws a neutral queued chip', () => {
    expect(aiReviewControlState(input({ review: review({ status: 'queued' }) }))).toEqual({
      kind: 'queued',
      chip: 'AI review queued',
    });
  });

  it('draws a parked chip for both gates', () => {
    const limit = review({
      status: 'parked-limit',
      parkReason: 'usage limit reached — resumes at 14:05:00',
    });
    expect(aiReviewControlState(input({ review: limit }))).toEqual({
      kind: 'parked',
      chip: 'parked — usage limit, resumes 14:05',
    });
    expect(
      aiReviewControlState(input({ review: review({ status: 'parked-signin', parkReason: 'x' }) })),
    ).toEqual({ kind: 'parked', chip: 'parked — signed out of Claude Code' });
  });

  it('offers Ask AI again with the failure text on a failed review', () => {
    expect(
      aiReviewControlState(input({ review: review({ status: 'failed', error: 'boom' }) })),
    ).toEqual({ kind: 'failed', label: 'Ask AI again', error: 'boom', reason: null });
    const silent = aiReviewControlState(input({ review: review({ status: 'failed' }) }));
    expect(silent).toMatchObject({ kind: 'failed', error: 'the AI review failed' });
  });

  it('names the findings on a done review', () => {
    expect(aiReviewControlState(input({ review: review() }))).toEqual({
      kind: 'done',
      label: 'AI: 3 findings',
      reason: null,
    });
    expect(aiReviewControlState(input({ review: review({ findingCount: 1 }) }))).toMatchObject({
      label: 'AI: 1 finding',
    });
  });

  it('is refused by the precheck, with the main process’s own text', () => {
    expect(
      aiReviewControlState(input({ summary: diff({ capabilities: FORGE_API_CAPABILITIES }) })),
    ).toMatchObject({ kind: 'ask', reason: 'add the repo as a project to let the AI review it' });
    expect(
      aiReviewControlState(input({ summary: diff({ files: [entry('a.ts', 4001)] }) })),
    ).toMatchObject({
      kind: 'ask',
      reason: 'too large to review — 4,001 changed lines, cap 4,000',
    });
    expect(aiReviewControlState(input({ summary: null }))).toMatchObject({
      reason: 'there are no changes to review',
    });
  });

  it('is refused by the last start, ahead of the precheck', () => {
    const reason = 'these changes have already been reviewed';
    expect(aiReviewControlState(input({ review: review(), refusal: reason }))).toEqual({
      kind: 'done',
      label: 'AI: 3 findings',
      reason,
    });
    expect(
      aiReviewControlState(
        input({ refusal: reason, summary: diff({ capabilities: FORGE_API_CAPABILITIES }) }),
      ),
    ).toMatchObject({ reason });
  });

  it('is disabled while unreachable or while a start is in flight', () => {
    expect(aiReviewControlState(input({ unreachable: true }))).toMatchObject({
      reason: 'the desktop app is unreachable',
    });
    expect(aiReviewControlState(input({ starting: true }))).toMatchObject({
      reason: 'asking the AI…',
    });
  });
});

describe('shortPark', () => {
  it('names the resume time without its seconds, in either clock', () => {
    const at = (time: string) =>
      shortPark({ status: 'parked-limit', parkReason: `usage limit reached — resumes at ${time}` });
    expect(at('14:05:00')).toBe('parked — usage limit, resumes 14:05');
    expect(at('2:05:00 PM')).toBe('parked — usage limit, resumes 2:05 PM');
  });

  it('says only "usage limit" when the reason names no time', () => {
    expect(shortPark({ status: 'parked-limit', parkReason: null })).toBe('parked — usage limit');
  });

  it('names the sign-in gate', () => {
    expect(shortPark({ status: 'parked-signin', parkReason: 'Claude Code is signed out' })).toBe(
      'parked — signed out of Claude Code',
    );
  });
});

describe('summaryLine', () => {
  it('reads "N findings · M dropped · $x · Model"', () => {
    expect(summaryLine(review(), 'Sonnet 5')).toBe('3 findings · 1 dropped · $1.84 · Sonnet 5');
    expect(summaryLine(review({ findingCount: 1, droppedCount: 0 }), 'Opus')).toBe(
      '1 finding · 0 dropped · $1.84 · Opus',
    );
  });

  it('leaves the cost out when none was recorded', () => {
    expect(summaryLine(review({ costUsd: null }), 'Sonnet 5')).toBe(
      '3 findings · 1 dropped · Sonnet 5',
    );
  });
});

describe('verdictText and checklistLine', () => {
  it('reads every verdict as plain text', () => {
    expect(verdictText('approve')).toBe('Approve');
    expect(verdictText('comment')).toBe('Comment');
    expect(verdictText('request-changes')).toBe('Request changes');
  });

  it('names the checklist, and nothing for an older row', () => {
    expect(checklistLine({ reviewDoc: 'REVIEW.md' })).toBe('used REVIEW.md');
    expect(checklistLine({ reviewDoc: 'default' })).toBe('used the default checklist');
    expect(checklistLine({ reviewDoc: null })).toBeNull();
  });
});
