import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@tm/shared/attention';
import {
  inboxCardActions,
  inboxCardTitle,
  inboxKindTone,
  inboxKindWord,
  runInboxCardAction,
  taskDisplayKey,
} from './inboxCard';

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    id: 'i1',
    runId: 'r1',
    taskId: 't1',
    projectId: 'p1',
    taskTitle: 'In-app code review',
    kind: 'question',
    prompt: 'The prompt',
    options: [],
    toolName: null,
    reason: null,
    createdAt: 0,
    ...over,
  };
}

const QUESTION = item({
  kind: 'agent-question',
  prompt: 'Pick a base',
  questions: [
    {
      header: 'Base',
      question: 'Which base branch should the review compare against?',
      multiSelect: false,
      options: [{ label: 'development' }, { label: 'main' }],
    },
  ],
});

describe('inboxKindWord / inboxKindTone', () => {
  it('names every kind in sentence case', () => {
    expect(inboxKindWord('agent-question')).toBe('Question');
    expect(inboxKindWord('question')).toBe('Question');
    expect(inboxKindWord('plan-approval')).toBe('Plan to approve');
    expect(inboxKindWord('task-failed')).toBe('Task failed');
    expect(inboxKindWord('merge-conflict')).toBe('Merge conflict');
    expect(inboxKindWord('permission')).toBe('Permission');
    expect(inboxKindWord('proposal')).toBe('Proposal');
  });

  it('marks failures as danger and every other ask as attention', () => {
    expect(inboxKindTone('task-failed')).toBe('danger');
    expect(inboxKindTone('merge-conflict')).toBe('danger');
    expect(inboxKindTone('agent-question')).toBe('attention');
    expect(inboxKindTone('plan-approval')).toBe('attention');
  });
});

describe('inboxCardTitle', () => {
  it("uses an agent question's own question", () => {
    expect(inboxCardTitle(QUESTION)).toBe('Which base branch should the review compare against?');
  });

  it('summarises a plan by its step count, else falls back to the prompt', () => {
    expect(inboxCardTitle(item({ kind: 'plan-approval', steps: ['a', 'b', 'c', 'd'] }))).toBe(
      '4 steps',
    );
    expect(inboxCardTitle(item({ kind: 'plan-approval', steps: ['a'] }))).toBe('1 step');
    expect(inboxCardTitle(item({ kind: 'plan-approval', prompt: 'Approve?' }))).toBe('Approve?');
  });

  it('uses the prompt for every other kind', () => {
    expect(inboxCardTitle(item({ kind: 'task-failed', prompt: 'The run failed.' }))).toBe(
      'The run failed.',
    );
  });
});

describe('inboxCardActions', () => {
  it('offers a single-select question its options, then Other…', () => {
    const actions = inboxCardActions(QUESTION, false);
    expect(actions.map((a) => a.label)).toEqual(['development', 'main', 'Other…']);
    expect(actions[0]).toMatchObject({
      kind: 'answer',
      primary: true,
      answer: { decision: 'answers', selections: [['development']], freeText: [null] },
    });
    expect(actions[1]).toMatchObject({ kind: 'answer', primary: false });
    expect(actions[2]).toMatchObject({ kind: 'open', link: true });
  });

  it('never answers an expired, multi-select or multi-question ask inline', () => {
    expect(inboxCardActions(QUESTION, true)).toEqual([
      { kind: 'open', label: 'Answer', link: false },
    ]);
    const multi = item({
      kind: 'agent-question',
      questions: [{ ...QUESTION.questions![0], multiSelect: true }],
    });
    expect(inboxCardActions(multi, false).map((a) => a.kind)).toEqual(['open']);
    const two = item({
      kind: 'agent-question',
      questions: [QUESTION.questions![0], QUESTION.questions![0]],
    });
    expect(inboxCardActions(two, false).map((a) => a.kind)).toEqual(['open']);
  });

  it("replies a sentinel question's options as text", () => {
    const actions = inboxCardActions(item({ kind: 'question', options: ['Yes', 'No'] }), false);
    expect(actions.map((a) => a.label)).toEqual(['Yes', 'No', 'Other…']);
    expect(actions[1]).toMatchObject({ answer: { decision: 'reply', text: 'No' } });
    expect(inboxCardActions(item({ kind: 'question' }), false)).toEqual([
      { kind: 'open', label: 'Reply', link: false },
    ]);
  });

  it('offers a plan Approve and Read plan', () => {
    const actions = inboxCardActions(item({ kind: 'plan-approval' }), false);
    expect(actions).toEqual([
      { kind: 'answer', label: 'Approve', answer: { decision: 'approve' }, primary: true },
      { kind: 'open', label: 'Read plan', link: true },
    ]);
  });

  it('offers a failed task Retry and Open only when the engine offered Retry', () => {
    const failed = item({
      kind: 'task-failed',
      options: ['Retry', 'Retry fresh (discard branch)', 'AI fix & retry'],
    });
    expect(inboxCardActions(failed, false)).toEqual([
      {
        kind: 'answer',
        label: 'Retry',
        answer: { decision: 'reply', text: 'Retry' },
        primary: true,
      },
      { kind: 'open', label: 'Open', link: true },
    ]);
    expect(
      inboxCardActions(item({ kind: 'task-failed', options: ['Retry integration'] }), false),
    ).toEqual([{ kind: 'open', label: 'Open', link: false }]);
  });

  it('only opens a permission, merge conflict or proposal', () => {
    for (const kind of ['permission', 'merge-conflict', 'proposal'] as const) {
      expect(inboxCardActions(item({ kind }), false).map((a) => a.kind)).toEqual(['open']);
    }
  });
});

describe('taskDisplayKey', () => {
  it('prefers the native key, then the tracker key', () => {
    expect(taskDisplayKey({ ticketKey: 'TM-87', externalKey: 'LIN-1' })).toBe('TM-87');
    expect(taskDisplayKey({ externalKey: 'LIN-1' })).toBe('LIN-1');
    expect(taskDisplayKey({})).toBeNull();
  });
});

describe('runInboxCardAction', () => {
  it('answers through the host, or opens', async () => {
    const answer = vi.fn(() => Promise.resolve());
    const open = vi.fn();
    const [approve, read] = inboxCardActions(item({ kind: 'plan-approval' }), false);
    await runInboxCardAction(item({ id: 'x' }), approve, { answer, open });
    expect(answer).toHaveBeenCalledWith('x', { decision: 'approve' });
    await runInboxCardAction(item({ id: 'x' }), read, { answer, open });
    expect(open).toHaveBeenCalledWith('x');
  });
});
