/**
 * The effects half of *Ask AI to review* (F16.13): reads a subject's AI reviews, follows
 * `aiReview:changed`, and starts or cancels one — then hands {@link aiReviewControlState} what
 * it needs. `aiReviewModel.ts` decides everything that is drawn.
 *
 * **One counter, every race** — the workspace's own `seq` pattern: a list answer for a subject
 * the viewer has already left is dropped, and so is a start's answer once a later list or
 * start has gone out.
 *
 * **A refusal belongs to its subject.** It is cleared on a subject change and by any review row
 * that arrives for the subject, so a tooltip never outlives the state it described.
 *
 * The clock ticks once a second only while the latest review is running (`useElapsedClock`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isAiReviewRefusal, type AiReview } from '@tm/shared/aiReview';
import type { DiffSummary } from '@tm/shared/review';
import { useModelLabels } from '../ModelField';
import { useTransport } from '../transport';
import { useElapsedClock } from '../useElapsedClock';
import { aiReviewControlState, latestReview, type AiReviewControlState } from './aiReviewModel';

export interface AiReviewHandle {
  /** The subject's newest review, or null before the first. */
  review: AiReview | null;
  control: AiReviewControlState;
  /** The review's model as the CLI names it ("Sonnet 5"), or '' with no review. */
  modelLabel: string;
  /** Starts a review — a no-op unless the control offers one, enabled. */
  ask: () => void;
  /** Cancels the latest review while it is queued, running or parked. */
  cancel: () => void;
}

/** Newest first: a known row replaced in place, a new one prepended. */
function upsert(reviews: readonly AiReview[], review: AiReview): AiReview[] {
  return reviews.some((r) => r.id === review.id)
    ? reviews.map((r) => (r.id === review.id ? review : r))
    : [review, ...reviews];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useAiReview(
  subjectId: string | null,
  summary: DiffSummary | null,
  unreachable: boolean,
): AiReviewHandle {
  const transport = useTransport();
  const labelOf = useModelLabels();
  const [reviews, setReviews] = useState<readonly AiReview[]>([]);
  const [refusal, setRefusal] = useState<{ subjectId: string; reason: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);
  const current = useRef(subjectId);
  current.current = subjectId;

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    setReviews([]);
    setRefusal(null);
    if (subjectId === null) return;
    try {
      const rows = await transport.invoke('aiReview:list', subjectId);
      if (seq.current === mySeq) setReviews(rows);
    } catch {
      // Nothing to show is the honest answer: the button still offers a review.
    }
  }, [transport, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload once the host becomes reachable again — the read a fresh mount would do.
  const wasUnreachable = useRef(unreachable);
  useEffect(() => {
    if (wasUnreachable.current && !unreachable) void load();
    wasUnreachable.current = unreachable;
  }, [unreachable, load]);

  useEffect(
    () =>
      transport.on('aiReview:changed', (review) => {
        if (review.subjectId !== current.current) return;
        setReviews((rows) => upsert(rows, review));
        setRefusal(null);
      }),
    [transport],
  );

  const review = subjectId === null ? null : latestReview(reviews, subjectId);
  const now = useElapsedClock(review?.status === 'running');
  const control = aiReviewControlState({
    review,
    summary,
    refusal: refusal !== null && refusal.subjectId === subjectId ? refusal.reason : null,
    starting,
    unreachable,
    now,
  });

  const askable =
    (control.kind === 'ask' || control.kind === 'failed' || control.kind === 'done') &&
    control.reason === null;

  function ask(): void {
    if (subjectId === null || !askable) return;
    const key = subjectId;
    const mySeq = ++seq.current;
    setStarting(true);
    void transport.invoke('aiReview:start', key).then(
      (answer) => {
        setStarting(false);
        if (seq.current !== mySeq) return;
        if (isAiReviewRefusal(answer)) setRefusal({ subjectId: key, reason: answer.reason });
        else setReviews((rows) => upsert(rows, answer));
      },
      (e: unknown) => {
        setStarting(false);
        if (seq.current === mySeq) setRefusal({ subjectId: key, reason: message(e) });
      },
    );
  }

  function cancel(): void {
    if (review === null || unreachable) return;
    void transport.invoke('aiReview:cancel', review.id).catch(() => undefined);
  }

  return { review, control, modelLabel: review ? labelOf(review.model) : '', ask, cancel };
}
