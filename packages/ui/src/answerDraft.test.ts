/**
 * The compact answer form's pure state machine.
 *
 * What matters most here is what must NEVER happen: a partial answer reaching the agent
 * (live or as a chat fallback), a selection getting lost to expiry or a failed send, and
 * a restored draft answering the wrong question set. Everything else follows from those.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AttentionQuestion } from '@tm/shared/attention';
import { clearDrafts } from './drafts';
import {
  chatFallbackMessage,
  initialDraft,
  isComplete,
  noted,
  parkAnswerDraft,
  permissionDecision,
  planDecision,
  restoreAnswerDraft,
  sendFailed,
  sendStarted,
  sendSucceeded,
  submission,
  tapOption,
  typed,
} from './answerDraft';

beforeEach(() => clearDrafts());

function question(overrides: Partial<AttentionQuestion> = {}): AttentionQuestion {
  return {
    header: '',
    question: 'Which auth method?',
    multiSelect: false,
    options: [{ label: 'OAuth' }, { label: 'API key' }],
    ...overrides,
  };
}

describe('initialDraft', () => {
  it('starts empty and positional against the questions', () => {
    const draft = initialDraft([question(), question({ question: 'Second?' })]);
    expect(draft).toEqual({
      selections: [[], []],
      freeText: ['', ''],
      note: '',
      phase: 'editing',
      error: null,
    });
  });
});

describe('tapOption', () => {
  it('replaces the row for a single-select question', () => {
    const questions = [question()];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = tapOption(draft, questions, 0, 'API key', false).state;
    expect(draft.selections).toEqual([['API key']]);
  });

  it('toggles a label in and out for a multi-select question', () => {
    const questions = [question({ multiSelect: true })];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = tapOption(draft, questions, 0, 'API key', false).state;
    expect(draft.selections).toEqual([['OAuth', 'API key']]);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    expect(draft.selections).toEqual([['API key']]);
  });

  it('leaves other questions untouched', () => {
    const questions = [question(), question({ question: 'Second?' })];
    const draft = initialDraft(questions);
    const next = tapOption(draft, questions, 1, 'OAuth', false).state;
    expect(next.selections).toEqual([[], ['OAuth']]);
  });

  it('auto-sends a single, non-multi-select, unexpired tap with nothing in flight', () => {
    const questions = [question()];
    const draft = initialDraft(questions);
    expect(tapOption(draft, questions, 0, 'OAuth', false).autoSend).toBe(true);
  });

  it('never auto-sends a multi-select question', () => {
    const questions = [question({ multiSelect: true })];
    const draft = initialDraft(questions);
    expect(tapOption(draft, questions, 0, 'OAuth', false).autoSend).toBe(false);
  });

  it('never auto-sends when there is more than one question', () => {
    const questions = [question(), question({ question: 'Second?' })];
    const draft = initialDraft(questions);
    expect(tapOption(draft, questions, 0, 'OAuth', false).autoSend).toBe(false);
  });

  it('never auto-sends an expired question', () => {
    const questions = [question()];
    const draft = initialDraft(questions);
    expect(tapOption(draft, questions, 0, 'OAuth', true).autoSend).toBe(false);
  });

  it('never auto-sends while a send is already in flight', () => {
    const questions = [question()];
    const draft = sendStarted(initialDraft(questions));
    expect(tapOption(draft, questions, 0, 'OAuth', false).autoSend).toBe(false);
  });
});

describe('typed and noted', () => {
  it('sets free text for one question without touching the others', () => {
    const questions = [question(), question({ question: 'Second?' })];
    const draft = typed(initialDraft(questions), 1, 'my answer');
    expect(draft.freeText).toEqual(['', 'my answer']);
  });

  it('sets the note', () => {
    const draft = noted(initialDraft([question()]), 'go ahead');
    expect(draft.note).toBe('go ahead');
  });
});

describe('sendStarted / sendFailed / sendSucceeded', () => {
  it('moves to sending and clears any previous error', () => {
    const questions = [question()];
    const failed = sendFailed(initialDraft(questions), 'boom');
    const started = sendStarted(failed);
    expect(started.phase).toBe('sending');
    expect(started.error).toBeNull();
  });

  it('keeps every selection and every piece of text on failure', () => {
    const questions = [question(), question({ question: 'Second?' })];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = typed(draft, 1, 'my answer');
    draft = sendStarted(draft);
    draft = sendFailed(draft, 'network error');
    expect(draft.phase).toBe('failed');
    expect(draft.error).toBe('network error');
    expect(draft.selections).toEqual([['OAuth'], []]);
    expect(draft.freeText).toEqual(['', 'my answer']);
  });

  it('is the only way to reach answered', () => {
    const draft = sendSucceeded(sendStarted(initialDraft([question()])));
    expect(draft.phase).toBe('answered');
    expect(draft.error).toBeNull();
  });
});

describe('isComplete', () => {
  it('requires every question to have a selection or typed text', () => {
    const questions = [question(), question({ question: 'Second?' })];
    let draft = initialDraft(questions);
    expect(isComplete(questions, draft)).toBe(false);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    expect(isComplete(questions, draft)).toBe(false);
    draft = typed(draft, 1, 'my answer');
    expect(isComplete(questions, draft)).toBe(true);
  });

  it('treats whitespace-only free text as no answer', () => {
    const questions = [question()];
    const draft = typed(initialDraft(questions), 0, '   ');
    expect(isComplete(questions, draft)).toBe(false);
  });
});

describe('submission', () => {
  it('is null when incomplete, even when expired', () => {
    const questions = [question(), question({ question: 'Second?' })];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    expect(submission(questions, draft, false)).toBeNull();
    expect(submission(questions, draft, true)).toBeNull();
  });

  it('sends a live answer when complete and not expired', () => {
    const questions = [question()];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    expect(submission(questions, draft, false)).toEqual({
      kind: 'answer',
      answer: { decision: 'answers', selections: [['OAuth']], freeText: [null] },
    });
  });

  it('trims free text and sends null for an untyped question', () => {
    const questions = [question(), question({ question: 'Second?' })];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = typed(draft, 1, '  extra context  ');
    const result = submission(questions, draft, false);
    expect(result).toEqual({
      kind: 'answer',
      answer: {
        decision: 'answers',
        selections: [['OAuth'], []],
        freeText: [null, 'extra context'],
      },
    });
  });

  it('falls back to chat when complete and expired, keeping the selection', () => {
    const questions = [question()];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    const result = submission(questions, draft, true);
    expect(result).toEqual({ kind: 'chat', message: chatFallbackMessage(questions, draft) });
  });
});

describe('chatFallbackMessage', () => {
  it('reads as prose naming the question and the answer', () => {
    const questions = [question()];
    const draft = tapOption(initialDraft(questions), questions, 0, 'OAuth', false).state;
    expect(chatFallbackMessage(questions, draft)).toBe(
      '(Your question timed out; here is my answer.) Re "Which auth method?": OAuth',
    );
  });

  it('joins labels and free text on the same line', () => {
    const questions = [question({ multiSelect: true })];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = typed(draft, 0, 'prefer OAuth if possible');
    expect(chatFallbackMessage(questions, draft)).toBe(
      '(Your question timed out; here is my answer.) Re "Which auth method?": OAuth; prefer OAuth if possible',
    );
  });

  it('lists multiple questions on their own lines', () => {
    const questions = [question(), question({ question: 'Second?' })];
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = typed(draft, 1, 'my answer');
    expect(chatFallbackMessage(questions, draft)).toBe(
      '(Your question timed out; here is my answer.) Re "Which auth method?": OAuth\n\n' +
        'Re "Second?": my answer',
    );
  });
});

describe('planDecision', () => {
  it('approves with an optional note', () => {
    expect(planDecision('approve', '')).toEqual({ decision: 'approve' });
    expect(planDecision('approve', '  looks good  ')).toEqual({
      decision: 'approve',
      note: 'looks good',
    });
  });

  it('requires a non-empty note to request changes', () => {
    expect(planDecision('request-changes', '')).toBeNull();
    expect(planDecision('request-changes', '   ')).toBeNull();
    expect(planDecision('request-changes', 'split step 3')).toEqual({
      decision: 'deny',
      note: 'split step 3',
    });
  });
});

describe('permissionDecision', () => {
  it('allows or denies with an always-optional note', () => {
    expect(permissionDecision(true, '')).toEqual({ decision: 'approve' });
    expect(permissionDecision(true, 'go ahead')).toEqual({
      decision: 'approve',
      note: 'go ahead',
    });
    expect(permissionDecision(false, '')).toEqual({ decision: 'deny' });
    expect(permissionDecision(false, 'too risky')).toEqual({
      decision: 'deny',
      note: 'too risky',
    });
  });
});

describe('parkAnswerDraft / restoreAnswerDraft', () => {
  const questions = [question(), question({ question: 'Second?' })];

  it('restores exactly what was parked', () => {
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = typed(draft, 1, 'my answer');
    parkAnswerDraft('item-1', draft);
    expect(restoreAnswerDraft('item-1', questions)).toEqual(draft);
  });

  it('forgets a draft nobody touched', () => {
    parkAnswerDraft('item-1', initialDraft(questions));
    expect(restoreAnswerDraft('item-1', questions)).toBeNull();
  });

  it('forgets an answered draft', () => {
    const draft = sendSucceeded(
      sendStarted(tapOption(initialDraft(questions), questions, 0, 'OAuth', false).state),
    );
    parkAnswerDraft('item-1', draft);
    expect(restoreAnswerDraft('item-1', questions)).toBeNull();
  });

  it('restores a sending draft as editing, so a remount never shows a stale spinner', () => {
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    draft = sendStarted(draft);
    parkAnswerDraft('item-1', draft);
    const restored = restoreAnswerDraft('item-1', questions);
    expect(restored?.phase).toBe('editing');
    expect(restored?.selections).toEqual([['OAuth'], []]);
  });

  it('discards a draft whose shape no longer matches the questions', () => {
    let draft = initialDraft(questions);
    draft = tapOption(draft, questions, 0, 'OAuth', false).state;
    parkAnswerDraft('item-1', draft);
    expect(restoreAnswerDraft('item-1', [question()])).toBeNull();
  });

  it('keeps one item from clobbering another', () => {
    const draftA = tapOption(initialDraft(questions), questions, 0, 'OAuth', false).state;
    const draftB = typed(initialDraft(questions), 1, 'other item');
    parkAnswerDraft('item-a', draftA);
    parkAnswerDraft('item-b', draftB);
    expect(restoreAnswerDraft('item-a', questions)).toEqual(draftA);
    expect(restoreAnswerDraft('item-b', questions)).toEqual(draftB);
  });
});
