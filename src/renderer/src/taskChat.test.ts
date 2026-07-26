/**
 * The composer's copy of the scheduler's chat rules. These tests are the guard on
 * "the button lies": every disabled state here must correspond to a refusal the
 * scheduler would actually give (see `Scheduler.chatWithAgent` / `resumeForChat`).
 */
import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionKind } from '@shared/attention';
import type { Task } from '@shared/model';
import { chatAvailability, REFUSAL_HINT } from './taskChat';

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 'c1',
    projectId: 'personal',
    phase: 'JIRA',
    title: 'Card',
    status: 'in-progress',
    order: 0,
    source: 'jira',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    sessionId: 'sess-1',
    agentProjectId: 'agent-p',
    ...over,
  }) as Task;

const step = (id: string, status: Task['status'], over: Partial<Task> = {}): Task =>
  task({ id, status, parentTaskId: 'c1', title: `Step ${id}`, ...over });

const item = (kind: AttentionKind): AttentionItem => ({ id: 'i1', kind }) as AttentionItem;

describe('chatAvailability', () => {
  it('is not offered for a card that was never delegated', () => {
    const a = chatAvailability(task({ agentProjectId: null }), [], null);
    expect(a.offered).toBe(false);
  });

  it('sends into a live run', () => {
    const a = chatAvailability(task({ status: 'running' }), [], null);
    expect(a).toMatchObject({ offered: true, can: true, live: true });
    expect(a.target.id).toBe('c1');
  });

  it('targets the working step, not the card', () => {
    const steps = [step('s1', 'done'), step('s2', 'running')];
    const a = chatAvailability(task({ status: 'in-progress' }), steps, null);
    expect(a.target.id).toBe('s2');
    expect(a.can).toBe(true);
  });

  it('lets a parked question be answered by chatting', () => {
    const a = chatAvailability(task({ status: 'waiting-input' }), [], item('question'));
    expect(a.can).toBe(true);
    expect(a.hint).toMatch(/answer/i);
  });

  it.each(['permission', 'plan-approval'] as const)(
    'refuses while the run is blocked on a %s decision',
    (kind) => {
      const a = chatAvailability(task({ status: 'waiting-input' }), [], item(kind));
      expect(a.can).toBe(false);
      expect(a.hint).toMatch(/pending request/i);
    },
  );

  it('offers a resume for an idle card that has run before', () => {
    const a = chatAvailability(task({ status: 'in-progress' }), [], null);
    expect(a).toMatchObject({ can: true, live: false });
    expect(a.hint).toMatch(/new run/i);
  });

  it('refuses a card that has never run', () => {
    const a = chatAvailability(task({ status: 'pending', sessionId: null }), [], null);
    expect(a.can).toBe(false);
    expect(a.hint).toBe(REFUSAL_HINT['never-ran']);
  });

  it('refuses a limit-parked card', () => {
    const a = chatAvailability(task({ status: 'blocked-by-limit' }), [], null);
    expect(a.can).toBe(false);
    expect(a.hint).toBe(REFUSAL_HINT.limit);
  });

  it('refuses a card mid-chain and points at the step instead', () => {
    const steps = [step('s1', 'done'), step('s2', 'failed')];
    const a = chatAvailability(task({ status: 'in-progress' }), steps, null);
    expect(a.target.id).toBe('c1'); // nothing is live, so the card is the target…
    expect(a.can).toBe(false); // …but its planner session must not be resumed
    expect(a.hint).toBe(REFUSAL_HINT['chain-busy']);
  });

  it('lets a card talk again once its chain has finished', () => {
    const steps = [step('s1', 'done'), step('s2', 'done')];
    expect(chatAvailability(task({ status: 'in-progress' }), steps, null).can).toBe(true);
  });

  it('lets a finished step be chatted with directly', () => {
    const s = step('s2', 'done', { sessionId: 'sess-2' });
    const a = chatAvailability(s, [step('s1', 'done'), s], null);
    expect(a.target.id).toBe('s2');
    expect(a.can).toBe(true);
  });
});
