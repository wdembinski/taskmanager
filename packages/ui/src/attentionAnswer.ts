/**
 * Picks the IPC channel that answers an attention item (F8.8). A "Trust and run" reply to a
 * parked gate must go through the dedicated, desktop-only `gate:trust` channel — the one path
 * allowed to grant trust — never through `attention:answer`, which refuses it and re-parks the
 * same ask. Every other answer, including "Decline", is unchanged.
 */
import { GATE_TRUST_ACTION } from '@tm/shared/workflow';
import type { AttentionAnswer, AttentionItem } from '@tm/shared/attention';
import type { Transport } from './transport';

/** The one-click that parks a planning question on its card (`attention:toDecision`). */
export const MAKE_DECISION_LABEL = 'Make this a decision on the card';

/**
 * Whether an item offers {@link MAKE_DECISION_LABEL}: only a `@@NEEDS_INPUT@@` question a
 * planning run raised — the engine refuses every other item, so no other gets the button.
 */
export function canMakeDecision(item: AttentionItem): boolean {
  return item.kind === 'question' && item.duringPlanning === true;
}

export function attentionAnswerCall(
  id: string,
  answer: AttentionAnswer,
): ['gate:trust', string] | ['attention:answer', string, AttentionAnswer] {
  if (answer.decision === 'reply' && answer.text === GATE_TRUST_ACTION.trust) {
    return ['gate:trust', id];
  }
  return ['attention:answer', id, answer];
}

/**
 * Calls through to whichever channel `attentionAnswerCall` picks. A plain `transport.invoke
 * (...attentionAnswerCall(id, answer))` can't typecheck — the two arms of the tuple union
 * have different arities — so this narrows by hand instead, once, for every caller.
 */
export async function invokeAttentionAnswer(
  transport: Transport,
  id: string,
  answer: AttentionAnswer,
): Promise<void> {
  const call = attentionAnswerCall(id, answer);
  if (call[0] === 'gate:trust') {
    await transport.invoke(call[0], call[1]);
  } else {
    await transport.invoke(call[0], call[1], call[2]);
  }
}
