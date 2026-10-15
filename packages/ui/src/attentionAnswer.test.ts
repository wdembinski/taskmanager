import { describe, expect, it, vi } from 'vitest';
import { GATE_TRUST_ACTION } from '@tm/shared/workflow';
import type { AttentionAnswer } from '@tm/shared/attention';
import { attentionAnswerCall, invokeAttentionAnswer } from './attentionAnswer';
import type { Transport } from './transport';

describe('attentionAnswerCall', () => {
  it('routes a "Trust and run" reply through the desktop-only gate:trust channel', () => {
    const answer: AttentionAnswer = { decision: 'reply', text: GATE_TRUST_ACTION.trust };
    expect(attentionAnswerCall('item-1', answer)).toEqual(['gate:trust', 'item-1']);
  });

  it('routes "Decline" through attention:answer unchanged', () => {
    const answer: AttentionAnswer = { decision: 'reply', text: GATE_TRUST_ACTION.decline };
    expect(attentionAnswerCall('item-1', answer)).toEqual(['attention:answer', 'item-1', answer]);
  });

  it('routes every other answer through attention:answer unchanged', () => {
    const answers: AttentionAnswer[] = [
      { decision: 'approve' },
      { decision: 'deny', note: 'because' },
      { decision: 'reply', text: 'Run again' },
      { decision: 'answers', selections: [['a']], freeText: [null] },
      { decision: 'discuss', text: 'tell me more' },
    ];
    for (const answer of answers) {
      expect(attentionAnswerCall('item-2', answer)).toEqual(['attention:answer', 'item-2', answer]);
    }
  });
});

describe('invokeAttentionAnswer', () => {
  function fakeTransport(): { transport: Transport; invoke: ReturnType<typeof vi.fn> } {
    const invoke = vi.fn().mockResolvedValue(undefined);
    return { transport: { invoke } as unknown as Transport, invoke };
  }

  it('calls gate:trust with just the item id for a trust reply', async () => {
    const { transport, invoke } = fakeTransport();
    const answer: AttentionAnswer = { decision: 'reply', text: GATE_TRUST_ACTION.trust };
    await invokeAttentionAnswer(transport, 'item-1', answer);
    expect(invoke).toHaveBeenCalledWith('gate:trust', 'item-1');
  });

  it('calls attention:answer with the full answer for a decline reply', async () => {
    const { transport, invoke } = fakeTransport();
    const answer: AttentionAnswer = { decision: 'reply', text: GATE_TRUST_ACTION.decline };
    await invokeAttentionAnswer(transport, 'item-1', answer);
    expect(invoke).toHaveBeenCalledWith('attention:answer', 'item-1', answer);
  });
});
