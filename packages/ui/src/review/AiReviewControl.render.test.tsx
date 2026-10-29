/**
 * Static-markup coverage for `AiReviewControl` and `AiReviewSummaryCard` (F16.13): every control
 * state, the run colour on the running chip alone, and both summary-card forms.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiReview } from '@tm/shared/aiReview';
import type { AiReviewControlState } from './aiReviewModel';
import { AiReviewControl } from './AiReviewControl';
import { AiReviewSummaryCard } from './AiReviewSummaryCard';

const noop = (): void => {};

function control(state: AiReviewControlState): string {
  return renderToStaticMarkup(<AiReviewControl control={state} onAsk={noop} onCancel={noop} />);
}

function review(over: Partial<AiReview> = {}): AiReview {
  return {
    id: 'r1',
    subjectId: 'pr:1',
    diffId: 'd1',
    headSha: 'abc',
    status: 'done',
    parkReason: null,
    model: 'claude-sonnet-5',
    startedAt: 1,
    finishedAt: 2,
    costUsd: 1.84,
    tokens: null,
    summary: 'The retry loop swallows its last error.',
    verdict: 'request-changes',
    findingCount: 2,
    droppedCount: 0,
    error: null,
    requestedBy: 'human',
    reviewDoc: 'REVIEW.md',
    ...over,
  };
}

const STATES: Record<string, AiReviewControlState> = {
  ask: { kind: 'ask', label: 'Ask AI to review', reason: null },
  running: { kind: 'running', chip: 'AI reviewing… 1m 12s · $0.42' },
  queued: { kind: 'queued', chip: 'AI review queued' },
  parked: { kind: 'parked', chip: 'parked — usage limit, resumes 14:05' },
  failed: { kind: 'failed', label: 'Ask AI again', error: 'boom', reason: null },
  done: { kind: 'done', label: 'AI: 2 findings', reason: null },
};

/** The running chip's class: the one class this control's run style compiles to. */
function runClass(html: string): string | null {
  return /data-running/.test(html)
    ? (/class="([^"]*)"[^>]*data-running/.exec(html)?.[1] ?? null)
    : null;
}

describe('AiReviewControl', () => {
  it('draws the outlined bot button while a review can be asked for', () => {
    const html = control(STATES.ask!);
    expect(html).toMatch(/<button[^>]*data-ai-review="ask"[^>]*>.*Ask AI to review<\/button>/);
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('Cancel');
    expect(control(STATES.done!)).toContain('AI: 2 findings');
    expect(control(STATES.failed!)).toContain('Ask AI again');
  });

  it('disables the button with the refusal as its reason', () => {
    const reason = 'add the repo as a project to let the AI review it';
    const html = control({ kind: 'ask', label: 'Ask AI to review', reason });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"/);
    expect(html).toContain(`data-refusal="${reason}"`);
  });

  it('draws a chip and a subtle Cancel while a review is under way', () => {
    for (const kind of ['running', 'queued', 'parked'] as const) {
      const html = control(STATES[kind]!);
      expect(html).toContain(`data-ai-review="${kind}"`);
      expect(html).toContain((STATES[kind] as { chip: string }).chip);
      expect(html).toMatch(/<button[^>]*data-ai-cancel[^>]*>Cancel<\/button>/);
      expect(html).not.toContain('Ask AI');
    }
  });

  it('marks only the running chip as running, with its own class and dot', () => {
    const running = control(STATES.running!);
    const cls = runClass(running);
    expect(cls).not.toBeNull();
    for (const kind of ['ask', 'queued', 'parked', 'failed', 'done']) {
      const html = control(STATES[kind]!);
      expect(html).not.toContain('data-running');
      // The running chip carries a class no other state draws: the run-token style.
      const extra = cls!.split(' ').filter((c) => !html.includes(c));
      expect(extra.length).toBeGreaterThan(0);
    }
  });
});

describe('AiReviewSummaryCard', () => {
  function card(r: AiReview): string {
    return renderToStaticMarkup(
      <AiReviewSummaryCard review={r} modelLabel="Sonnet 5" onAskAgain={noop} />,
    );
  }

  it('reads a done review as four plain lines', () => {
    const html = card(review());
    expect(html).toContain('data-ai-summary="done"');
    expect(html).toMatch(/data-verdict="request-changes"[^>]*>Request changes</);
    expect(html).toContain('The retry loop swallows its last error.');
    expect(html).toMatch(/data-ai-summary-line[^>]*>2 findings · 0 dropped · \$1\.84 · Sonnet 5</);
    expect(html).toMatch(/data-ai-checklist[^>]*>used REVIEW\.md</);
    expect(html).not.toContain('Ask AI again');
    expect(html).not.toContain('data-running');
  });

  it('says which checklist, and nothing for an older row', () => {
    expect(card(review({ reviewDoc: 'default', verdict: 'approve' }))).toMatch(
      /used the default checklist/,
    );
    expect(card(review({ verdict: 'comment' }))).toMatch(/>Comment</);
    expect(card(review({ reviewDoc: null }))).not.toContain('data-ai-checklist');
  });

  it('reads a failed review as its error and Ask AI again', () => {
    const html = card(review({ status: 'failed', error: 'the session exited (1)' }));
    expect(html).toContain('data-ai-summary="failed"');
    expect(html).toMatch(/data-ai-error[^>]*>the session exited \(1\)</);
    expect(html).toMatch(/<button[^>]*>.*Ask AI again<\/button>/);
  });

  it('draws nothing for a review still under way', () => {
    for (const status of ['queued', 'running', 'parked-limit', 'cancelled'] as const) {
      expect(card(review({ status }))).toBe('');
    }
  });
});
