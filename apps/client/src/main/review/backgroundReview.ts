/**
 * The trigger behind `features.aiReviewOnOpen` (F16.13): which pull requests in a
 * `review:queues:changed` snapshot are NEW, and so get an AI review started on their own.
 *
 * Pure, so the one rule that costs money can be pinned without a forge, a store or a runner:
 * the first snapshot only seeds what is already there — launching the app (or turning the
 * switch on) must never review the whole backlog at once — and a card's own Changes subject
 * (`task:<id>`) never counts, because the switch is about pull requests arriving.
 */
import type { ReviewQueuesSnapshot } from '@tm/shared/review';

/**
 * The PR subject ids in `snapshot` that `prev` has not seen, in snapshot order and without
 * repeats. `prev === null` means no snapshot has been seen yet: the answer is `[]`, and the
 * caller seeds its set from this one.
 */
export function newPrSubjects(
  prev: Set<string> | null,
  snapshot: Pick<ReviewQueuesSnapshot, 'items'>,
): string[] {
  if (prev === null) return [];
  const fresh = new Set<string>();
  for (const item of snapshot.items) {
    if (item.subject.kind !== 'pr') continue;
    if (prev.has(item.subjectId)) continue;
    fresh.add(item.subjectId);
  }
  return [...fresh];
}

/** Every PR subject id in `snapshot` — what the caller folds into its seen set. */
export function prSubjectIds(snapshot: Pick<ReviewQueuesSnapshot, 'items'>): string[] {
  return snapshot.items.filter((i) => i.subject.kind === 'pr').map((i) => i.subjectId);
}
