/**
 * Urgency ordering for the compact Inbox screen (F3.3).
 *
 * The wide board shows every open `AttentionItem` at once; the compact inbox is a
 * single scrolling list, so it needs one total order across all seven kinds rather
 * than per-section grouping. `attentionUrgency` is that order, and `questionDeadline`
 * is the one piece of it that changes with the clock: a held `agent-question` has an
 * actual timeout, so its row needs a live countdown, not just a static tier.
 */
import type { AttentionItem } from '@tm/shared/attention';

/**
 * The CLI's own MCP relay timeout on a held `AskUserQuestion` tool call — thirty
 * minutes. This is not a value we configure; it is how long the relay itself will
 * wait before the tool call times out server-side, so the countdown here is read-only:
 * it tells the human how long they actually have, it does not decide it.
 */
export const QUESTION_TIMEOUT_MS = 1_800_000;

export type QuestionDeadline = { kind: 'counting'; remainingMs: number } | { kind: 'expired' };

/**
 * The countdown for a held `agent-question`, or `null` for every other kind — only a
 * held tool call has a timeout; a `question` is a sentinel in the agent's own prose
 * and never expires on its own.
 *
 * `remainingMs` is clamped to `QUESTION_TIMEOUT_MS` so a phone clock running ahead of
 * the desktop's `createdAt` never shows more time left than the relay could possibly
 * still be waiting.
 */
export function questionDeadline(item: AttentionItem, now: number): QuestionDeadline | null {
  if (item.kind !== 'agent-question') return null;
  const remainingMs = Math.min(item.createdAt + QUESTION_TIMEOUT_MS - now, QUESTION_TIMEOUT_MS);
  if (remainingMs <= 0) return { kind: 'expired' };
  return { kind: 'counting', remainingMs };
}

/**
 * The inbox's sort tier for one item — lower is more urgent.
 *
 * An expired `agent-question` drops to the same tier as `question`: the relay has
 * already timed the tool call out, so from here on the agent has moved on and the
 * human's answer can only ever land as a chat message, exactly like a `question`.
 */
export function attentionUrgency(item: AttentionItem, now: number): number {
  switch (item.kind) {
    case 'agent-question':
      return questionDeadline(item, now)?.kind === 'expired' ? 1 : 0;
    case 'question':
      return 1;
    case 'plan-approval':
      return 2;
    case 'permission':
      return 3;
    case 'merge-conflict':
      return 4;
    case 'task-failed':
      return 5;
    case 'proposal':
      return 6;
  }
}

/**
 * Items sorted by `attentionUrgency`, then `createdAt` ascending (oldest first, so
 * within tier 0 the soonest deadline sorts first), then `id` for a stable order when
 * both are equal. Returns a new array — the input is never mutated.
 */
export function sortByUrgency(items: readonly AttentionItem[], now: number): AttentionItem[] {
  return [...items].sort((a, b) => {
    const tierDiff = attentionUrgency(a, now) - attentionUrgency(b, now);
    if (tierDiff !== 0) return tierDiff;
    const createdDiff = a.createdAt - b.createdAt;
    if (createdDiff !== 0) return createdDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
