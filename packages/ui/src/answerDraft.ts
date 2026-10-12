/**
 * The compact answer form's (F3.4) state, kept as a pure reducer for the same reason
 * `inboxState.ts` is: the one thing worth proving hard here — a partial answer never
 * reaching the agent, live or as a chat fallback — has to survive expiry, a relay
 * failure, and a remount mid-flight, and none of that is worth testing through React.
 *
 * Positional against `questions`, exactly like `AgentQuestionForm` today:
 * `selections[i]` are the chosen labels for question `i`, and `freeText[i]` is what was
 * typed instead of picking. A compact form taps one option at a time rather than filling
 * a whole form before submitting, so `tapOption` — not a bulk "set and submit" — is the
 * one mutation a tap produces, and it says whether that tap was itself enough to send
 * (a single non-multi-select question with nothing in flight).
 */
import type { AttentionAnswer, AttentionQuestion } from '@tm/shared/attention';
import { draftKey, parkDraft, readDraft } from './drafts';

export type AnswerDraftPhase = 'editing' | 'sending' | 'failed' | 'answered';

export interface AnswerDraftState {
  selections: string[][];
  freeText: string[];
  note: string;
  phase: AnswerDraftPhase;
  error: string | null;
}

export type AnswerSubmission =
  { kind: 'answer'; answer: AttentionAnswer } | { kind: 'chat'; message: string };

/** A fresh draft: nothing chosen, nothing typed, nothing in flight. */
export function initialDraft(questions: readonly AttentionQuestion[]): AnswerDraftState {
  return {
    selections: questions.map(() => []),
    freeText: questions.map(() => ''),
    note: '',
    phase: 'editing',
    error: null,
  };
}

/**
 * A chip was tapped for question `qi`. Single-select replaces the row; multi-select
 * toggles the label in or out — the same rules `AgentQuestionForm.choose` uses today, so
 * the wide and compact forms can never disagree about what a tap means.
 *
 * `autoSend` is true only when there is exactly one question, it does not accept more
 * than one answer, it has not expired, and no send is already in flight — the one case
 * where a single tap is itself a complete, unambiguous answer.
 */
export function tapOption(
  state: AnswerDraftState,
  questions: readonly AttentionQuestion[],
  qi: number,
  label: string,
  expired: boolean,
): { state: AnswerDraftState; autoSend: boolean } {
  const multi = questions[qi]?.multiSelect ?? false;
  const current = state.selections[qi] ?? [];
  const nextRow = !multi
    ? [label]
    : current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];

  const selections = state.selections.map((row, i) => (i === qi ? nextRow : row));
  const autoSend =
    questions.length === 1 && !questions[0].multiSelect && !expired && state.phase !== 'sending';

  return { state: { ...state, selections }, autoSend };
}

/** Free text was typed for question `qi`, replacing whatever was typed there before. */
export function typed(state: AnswerDraftState, qi: number, text: string): AnswerDraftState {
  return { ...state, freeText: state.freeText.map((t, i) => (i === qi ? text : t)) };
}

/** The plan/permission note field changed. */
export function noted(state: AnswerDraftState, text: string): AnswerDraftState {
  return { ...state, note: text };
}

/** A send (live answer or chat fallback) started. */
export function sendStarted(state: AnswerDraftState): AnswerDraftState {
  return { ...state, phase: 'sending', error: null };
}

/**
 * A send failed — a rejected invoke, or `task:chat` refusing it. Keeps every selection
 * and every piece of typed text: the whole point of a draft is that a failure never
 * costs the human what they already chose.
 */
export function sendFailed(state: AnswerDraftState, message: string): AnswerDraftState {
  return { ...state, phase: 'failed', error: message };
}

/** The only way to reach `answered`. */
export function sendSucceeded(state: AnswerDraftState): AnswerDraftState {
  return { ...state, phase: 'answered', error: null };
}

/**
 * Every question has a selection or trimmed free text — the rule `AgentQuestionForm`
 * documents today, lifted here so the compact and wide forms enforce exactly one rule.
 */
export function isComplete(
  questions: readonly AttentionQuestion[],
  state: AnswerDraftState,
): boolean {
  return questions.every(
    (_q, i) =>
      (state.selections[i]?.length ?? 0) > 0 || (state.freeText[i]?.trim().length ?? 0) > 0,
  );
}

/**
 * Readable prose for the expired-question fallback: "(Your question timed out; here is
 * my answer.)" followed by one `Re "<question>": <labels>; <free text>` line per
 * question. Built from the same `selections`/`freeText` as a live answer, so expiry
 * never discards what was chosen — it only changes which channel carries it.
 */
export function chatFallbackMessage(
  questions: readonly AttentionQuestion[],
  state: AnswerDraftState,
): string {
  const lines = questions.map((q, i) => {
    const labels = state.selections[i] ?? [];
    const text = state.freeText[i]?.trim() ?? '';
    const parts = [
      labels.length > 0 ? labels.join(', ') : null,
      text.length > 0 ? text : null,
    ].filter((p): p is string => p !== null);
    return `Re "${q.question}": ${parts.join('; ')}`;
  });
  return `(Your question timed out; here is my answer.) ${lines.join('\n\n')}`;
}

/**
 * What tapping "Send" (or the auto-send from a single tap) should do. Completeness is
 * checked FIRST and always wins: a partial answer is never sent, live or as chat — only
 * once every question has something does expiry decide which channel it goes out on.
 */
export function submission(
  questions: readonly AttentionQuestion[],
  state: AnswerDraftState,
  expired: boolean,
): AnswerSubmission | null {
  if (!isComplete(questions, state)) return null;
  if (expired) {
    return { kind: 'chat', message: chatFallbackMessage(questions, state) };
  }
  return {
    kind: 'answer',
    answer: {
      decision: 'answers',
      selections: state.selections,
      freeText: state.freeText.map((t) => (t.trim() ? t.trim() : null)),
    },
  };
}

/**
 * A plan approval's decision. `approve` sends the optional note as-is. `request-changes`
 * requires a non-empty note — the human must say what to change — and becomes a `deny`
 * so the planning session re-plans with that note as the reason. `null` means the note
 * box is empty and there is nothing to send yet.
 */
export function planDecision(
  kind: 'approve' | 'request-changes',
  note: string,
): AttentionAnswer | null {
  const trimmed = note.trim();
  if (kind === 'approve') {
    return trimmed ? { decision: 'approve', note: trimmed } : { decision: 'approve' };
  }
  if (!trimmed) return null;
  return { decision: 'deny', note: trimmed };
}

/** A permission's decision. Unlike a plan's "request changes", a note is always optional. */
export function permissionDecision(allow: boolean, note: string): AttentionAnswer {
  const trimmed = note.trim();
  return allow
    ? trimmed
      ? { decision: 'approve', note: trimmed }
      : { decision: 'approve' }
    : trimmed
      ? { decision: 'deny', note: trimmed }
      : { decision: 'deny' };
}

/** Whether a draft has anything worth coming back to. */
function isUntouched(state: AnswerDraftState): boolean {
  return (
    state.selections.every((row) => row.length === 0) &&
    state.freeText.every((t) => t.trim().length === 0) &&
    state.note.trim().length === 0
  );
}

/**
 * Park `state` for `itemId`, or drop whatever was parked there. `answered` is never worth
 * restoring — the item is gone — and neither is a draft nobody touched, so both are
 * forgotten rather than kept.
 */
export function parkAnswerDraft(itemId: string, state: AnswerDraftState): void {
  parkDraft(draftKey(itemId, 'answer'), state, state.phase !== 'answered' && !isUntouched(state));
}

/**
 * The parked draft for `itemId`, or `null` if there is none, or if its shape no longer
 * matches `questions` (a positional draft from a different question set is not a draft
 * for this one — restoring it would answer the wrong questions). A `sending` draft
 * restores as `editing`: whatever was in flight when the view unmounted did not survive
 * it, and a remount must never show a spinner for a send nobody is waiting on.
 */
export function restoreAnswerDraft(
  itemId: string,
  questions: readonly AttentionQuestion[],
): AnswerDraftState | null {
  const draft = readDraft<AnswerDraftState>(draftKey(itemId, 'answer'));
  if (!draft) return null;
  if (draft.selections.length !== questions.length || draft.freeText.length !== questions.length) {
    return null;
  }
  return draft.phase === 'sending' ? { ...draft, phase: 'editing' } : draft;
}
