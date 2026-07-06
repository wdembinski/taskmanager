/**
 * Question detection (Phase 4) — pure, unit-tested.
 *
 * PERMISSIONS no longer come from watching the event stream — they are vetoed
 * pre-execution by the permission broker + MCP tool (see `permissionBroker.ts`).
 * What remains here is detecting when Claude asks the HUMAN a question mid-task.
 *
 * Rather than guess from prose (the old "message ends in ?" heuristic, which both
 * missed multi-line questions and fired on rhetorical ones), we define an
 * explicit contract: the task prompt instructs Claude to prefix a line with a
 * sentinel when — and only when — it needs a human decision to continue. Here we
 * detect that sentinel deterministically. `NEEDS_INPUT_SENTINEL` is the single
 * source of truth, shared with the prompt builder so the two never drift.
 */
import type { SessionEvent } from '@shared/session';

/** The marker Claude is told to put at the start of a line to ask for input. */
export const NEEDS_INPUT_SENTINEL = '@@NEEDS_INPUT@@';

/** A detected clarifying question, optionally with discrete choices to offer. */
export interface DetectedQuestion {
  kind: 'question';
  prompt: string;
  /** Multiple-choice options (empty = free-text answer expected). */
  options: string[];
}

/**
 * Extract the question from an assistant message if it uses the sentinel, else
 * `null`. The question is the text on the sentinel's line; any following lines
 * that are dash/asterisk bullets (`- SQLite`) are parsed as multiple-choice
 * OPTIONS. This lets Claude offer concrete choices the human answers in one click,
 * while a bare question (no bullets) stays a free-text prompt.
 */
export function detectQuestion(text: string): DetectedQuestion | null {
  const index = text.indexOf(NEEDS_INPUT_SENTINEL);
  if (index === -1) return null;

  const after = text.slice(index + NEEDS_INPUT_SENTINEL.length);
  const [firstLine, ...rest] = after.split('\n');
  const options: string[] = [];
  const prose: string[] = [];
  for (const line of rest) {
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) options.push(bullet[1]);
    else if (line.trim()) prose.push(line.trim());
  }

  // The question is the sentinel line; if that was empty, fall back to any
  // non-bullet prose that followed, then to a generic prompt.
  const prompt = firstLine.trim() || prose.join(' ') || 'Claude needs input to continue.';
  return { kind: 'question', prompt, options };
}

/**
 * Classify one event. Returns a detected question, or `null` when the event needs
 * no human. Pure and side-effect free.
 */
export function detectAttention(event: SessionEvent): DetectedQuestion | null {
  if (event.kind === 'assistant') return detectQuestion(event.text);
  return null;
}
