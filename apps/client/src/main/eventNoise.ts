/**
 * What is worth showing a human, and what a tool failure actually said.
 *
 * Two complaints, one cause: the chat printed `A tool call failed.` with no reason (the
 * event carried none), and `Usage limit: allowed (five_hour)` in red — which means the
 * account is *fine*. Both were the renderer rendering raw events with no judgement about
 * whether they mean anything.
 *
 * Judging noise HERE, once, is what stops the renderer's push and the persisted transcript
 * from disagreeing about what happened: they call the same predicate, so a run you scroll
 * back to a week later reads exactly like the one you watched live.
 *
 * Pure and total — no CLI, no store, no Electron.
 */
import type { SessionEvent } from '@shared/session';
import { isBlockingLimitStatus } from './limitGate';

/**
 * A stack trace is not a UI message. Long enough to carry a real compiler error, short
 * enough that a runaway tool can't bloat the transcript table.
 */
export const MAX_TOOL_ERROR_CHARS = 2000;

/**
 * Pull the text out of a raw `tool_result` `content`, which the CLI sends either as a
 * bare string or as an array of `{ type, text }` blocks depending on the tool.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object') {
      const text = (block as Record<string, unknown>)['text'];
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Failures an agent routinely recovers from on its own next turn: a stale edit, a file it
 * hasn't read yet, a call it cancelled. Announcing these interrupts the thread to report
 * something that was already handled before you finished reading it.
 *
 * Matched as literal substrings, case-insensitively, so that when the CLI's wording drifts
 * the failure degrades to **shown** rather than **hidden**. Hiding a real failure is the
 * expensive mistake; showing a benign one is merely untidy.
 */
const BENIGN_FAILURES: readonly string[] = [
  'string to replace not found',
  'has not been read yet',
  'file has been modified since read',
  'has been modified externally',
  'no such tool available',
  'was cancelled',
  'was canceled',
  'interrupted by user',
  'found 0 matches',
  'no matches found',
];

/** `Found 3 matches of the string` — the ambiguous-edit retry, which the agent fixes itself. */
const AMBIGUOUS_EDIT = /found \d+ matches of the string/i;

/**
 * Whether a tool failure is one the agent handles without you.
 *
 * Takes only the text: `mapRawEvent` is stateless per raw event and a `tool_result` carries
 * nothing but its `tool_use_id`, so the tool's NAME is not available at the point this is
 * called. Threading a toolId→name map through would make the mapper stateful and destroy
 * its testability, for a classifier the text already answers.
 */
export function isBenignToolFailure(errorText: string): boolean {
  const text = errorText.trim().toLowerCase();
  // An error with nothing to say cannot be reported usefully, so reporting it is pure noise.
  if (text === '') return true;
  if (AMBIGUOUS_EDIT.test(text)) return true;
  return BENIGN_FAILURES.some((phrase) => text.includes(phrase));
}

/**
 * Whether an event is worth showing a human at all.
 *
 * Today this suppresses exactly one thing: a `rate-limit` event whose status is not
 * blocking. Claude emits those routinely while the account is healthy — `allowed`,
 * `allowed_warning` — and the renderer painted every one of them as an error. The engine
 * has always known better ({@link isBlockingLimitStatus} is what decides whether to park a
 * run); this makes the UI use the same knowledge.
 *
 * NOT extended to benign tool failures: `tool-use` and `tool-result` are paired by
 * `toolId` and the renderer folds them together, so dropping the result would leave a
 * spinner that never resolves. Those carry a `benign` flag instead, and the UI collapses
 * them into the "worked with N tools" row.
 */
export function shouldSurfaceEvent(event: SessionEvent): boolean {
  if (event.kind === 'rate-limit') return isBlockingLimitStatus(event.status);
  return true;
}
