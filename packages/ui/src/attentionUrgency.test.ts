import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionKind } from '@tm/shared/attention';
import {
  QUESTION_TIMEOUT_MS,
  attentionUrgency,
  questionDeadline,
  sortByUrgency,
} from './attentionUrgency';

const NOW = 1_700_000_000_000;

let nextId = 0;
function item(kind: AttentionKind, overrides: Partial<AttentionItem> = {}): AttentionItem {
  nextId += 1;
  return {
    id: overrides.id ?? `item-${nextId}`,
    runId: 'run-1',
    taskId: 'task-1',
    projectId: 'project-1',
    taskTitle: 'A task',
    kind,
    prompt: 'prompt',
    options: [],
    toolName: null,
    reason: null,
    createdAt: overrides.createdAt ?? NOW,
    ...overrides,
  };
}

describe('questionDeadline', () => {
  it('returns null for every kind except agent-question', () => {
    const kinds: AttentionKind[] = [
      'permission',
      'question',
      'merge-conflict',
      'task-failed',
      'proposal',
      'plan-approval',
    ];
    for (const kind of kinds) {
      expect(questionDeadline(item(kind), NOW)).toBeNull();
    }
  });

  it('is the full timeout at createdAt', () => {
    const it1 = item('agent-question', { createdAt: NOW });
    expect(questionDeadline(it1, NOW)).toEqual({
      kind: 'counting',
      remainingMs: QUESTION_TIMEOUT_MS,
    });
  });

  it('is half the timeout halfway through', () => {
    const it1 = item('agent-question', { createdAt: NOW });
    expect(questionDeadline(it1, NOW + QUESTION_TIMEOUT_MS / 2)).toEqual({
      kind: 'counting',
      remainingMs: QUESTION_TIMEOUT_MS / 2,
    });
  });

  it('is expired at exactly the timeout boundary', () => {
    const it1 = item('agent-question', { createdAt: NOW });
    expect(questionDeadline(it1, NOW + QUESTION_TIMEOUT_MS)).toEqual({ kind: 'expired' });
  });

  it('is expired past the timeout', () => {
    const it1 = item('agent-question', { createdAt: NOW });
    expect(questionDeadline(it1, NOW + QUESTION_TIMEOUT_MS + 1)).toEqual({ kind: 'expired' });
  });

  it('clamps a future createdAt to the full timeout, never more', () => {
    const it1 = item('agent-question', { createdAt: NOW + 60_000 });
    expect(questionDeadline(it1, NOW)).toEqual({
      kind: 'counting',
      remainingMs: QUESTION_TIMEOUT_MS,
    });
  });
});

describe('attentionUrgency', () => {
  it('orders the seven kinds into their tiers', () => {
    expect(attentionUrgency(item('agent-question', { createdAt: NOW }), NOW)).toBe(0);
    expect(attentionUrgency(item('question'), NOW)).toBe(1);
    expect(attentionUrgency(item('plan-approval'), NOW)).toBe(2);
    expect(attentionUrgency(item('permission'), NOW)).toBe(3);
    expect(attentionUrgency(item('merge-conflict'), NOW)).toBe(4);
    expect(attentionUrgency(item('task-failed'), NOW)).toBe(5);
    expect(attentionUrgency(item('proposal'), NOW)).toBe(6);
  });

  it('drops an expired agent-question to the question tier', () => {
    const expired = item('agent-question', { createdAt: NOW - QUESTION_TIMEOUT_MS });
    expect(attentionUrgency(expired, NOW)).toBe(1);
  });
});

describe('sortByUrgency', () => {
  it('sorts all seven kinds, shuffled, into tier order', () => {
    const kinds: AttentionKind[] = [
      'proposal',
      'task-failed',
      'merge-conflict',
      'permission',
      'plan-approval',
      'question',
      'agent-question',
    ];
    const items = kinds.map((kind) => item(kind, { createdAt: NOW }));
    const sorted = sortByUrgency(items, NOW);
    expect(sorted.map((i) => i.kind)).toEqual([
      'agent-question',
      'question',
      'plan-approval',
      'permission',
      'merge-conflict',
      'task-failed',
      'proposal',
    ]);
  });

  it('orders within a kind by createdAt, oldest first', () => {
    const newer = item('permission', { createdAt: NOW, id: 'newer' });
    const older = item('permission', { createdAt: NOW - 1000, id: 'older' });
    const sorted = sortByUrgency([newer, older], NOW);
    expect(sorted.map((i) => i.id)).toEqual(['older', 'newer']);
  });

  it('sorts the soonest agent-question deadline first within tier 0', () => {
    const soon = item('agent-question', { createdAt: NOW - 1000, id: 'soon' });
    const later = item('agent-question', { createdAt: NOW, id: 'later' });
    const sorted = sortByUrgency([later, soon], NOW);
    expect(sorted.map((i) => i.id)).toEqual(['soon', 'later']);
  });

  it('drops an expired agent-question below a live one, and below nothing else in tier 1', () => {
    const live = item('agent-question', { createdAt: NOW, id: 'live' });
    const expired = item('agent-question', { createdAt: NOW - QUESTION_TIMEOUT_MS, id: 'expired' });
    const question = item('question', { createdAt: NOW, id: 'question' });
    const sorted = sortByUrgency([question, live, expired], NOW);
    expect(sorted.map((i) => i.id)).toEqual(['live', 'expired', 'question']);
  });

  it('breaks ties on id when tier and createdAt both match', () => {
    const a = item('permission', { createdAt: NOW, id: 'b' });
    const b = item('permission', { createdAt: NOW, id: 'a' });
    const sorted = sortByUrgency([a, b], NOW);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const items = [
      item('proposal', { id: 'z' }),
      item('agent-question', { id: 'a', createdAt: NOW }),
    ];
    const copy = [...items];
    sortByUrgency(items, NOW);
    expect(items).toEqual(copy);
  });
});
