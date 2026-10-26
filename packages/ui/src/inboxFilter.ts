/**
 * The compact Inbox's filter chips (v9-4/v9-5's chip row under the "Inbox" title) — which
 * `AttentionKind` lands under which chip. Pure, so the mapping is testable without a DOM.
 *
 * "Needs you" is everything; every other chip is a partition of the kinds — each kind sits in
 * exactly one of them, so no item can vanish from every narrower chip at once. The mockup's
 * Mentions and Reviews chips are left out: neither feature exists yet.
 *
 * `KIND_CHIP` is a `Record<AttentionKind, …>`, so adding a kind to `AttentionKind` without
 * mapping it here is a type error, and `inboxFilter.test.ts` checks the same at runtime.
 */
import type { AttentionItem, AttentionKind } from '@tm/shared/attention';

export type InboxChip = 'needs-you' | 'questions' | 'plans' | 'failures';

/** In render order, with each chip's visible label. */
export const INBOX_CHIPS: readonly { id: InboxChip; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'questions', label: 'Questions' },
  { id: 'plans', label: 'Plans' },
  { id: 'failures', label: 'Failures' },
];

/** The one narrower chip each kind belongs to. A permission prompt is a yes/no question to
 *  the human, so it files under Questions; a proposal is a plan the agent wants approved. */
export const KIND_CHIP: Readonly<Record<AttentionKind, Exclude<InboxChip, 'needs-you'>>> = {
  question: 'questions',
  'agent-question': 'questions',
  permission: 'questions',
  'plan-approval': 'plans',
  proposal: 'plans',
  'task-failed': 'failures',
  'merge-conflict': 'failures',
};

/** True when `kind` shows under `chip`. */
export function chipIncludes(chip: InboxChip, kind: AttentionKind): boolean {
  return chip === 'needs-you' || KIND_CHIP[kind] === chip;
}

/** `items` narrowed to `chip`, order preserved — callers sort first (`sortByUrgency`). */
export function filterInbox<T extends Pick<AttentionItem, 'kind'>>(
  items: readonly T[],
  chip: InboxChip,
): T[] {
  return items.filter((item) => chipIncludes(chip, item.kind));
}
