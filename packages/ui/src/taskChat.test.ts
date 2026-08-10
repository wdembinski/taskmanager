/**
 * The composer's copy of the scheduler's chat rules. These tests are the guard on
 * "the button lies": every disabled state here must correspond to a refusal the
 * scheduler would actually give (see `Scheduler.chatWithAgent` / `resumeForChat`).
 */
import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionKind } from '@tm/shared/attention';
import type { Task } from '@tm/shared/model';
import { MAX_PLAN_STEPS } from '@tm/shared/board';
import { canReplan, chatAvailability, REFUSAL_HINT } from './taskChat';

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

  it('refuses a card with no session that no agent owns', () => {
    const a = chatAvailability(
      task({ status: 'pending', sessionId: null, agentProjectId: null }),
      [],
      null,
    );
    expect(a.can).toBe(false);
    expect(a.hint).toBe(REFUSAL_HINT['never-ran']);
  });

  // `resumeForChat` starts a FRESH run for a delegated card with no session — that is how a
  // staged card is begun, and how a card whose plan has finished is talked to at all
  // (`finishParentChain` clears its session on purpose). Refusing it here made that card
  // unreachable and told the human it had "never run" right after it ran six steps.
  it('opens a fresh conversation on a delegated card with no session', () => {
    const a = chatAvailability(task({ status: 'pending', sessionId: null }), [], null);
    expect(a.can).toBe(true);
    expect(a.hint).toMatch(/fresh conversation/i);
  });

  it('still talks to a card whose chain has landed and cleared its session', () => {
    const steps = [step('s1', 'done'), step('s2', 'done')];
    const landed = task({ status: 'in-progress', sessionId: null, chainLandedAt: 123 });
    const a = chatAvailability(landed, steps, null);
    expect(a.can).toBe(true);
    expect(a.hint).toMatch(/fresh conversation/i);
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

/**
 * The re-plan button's copy of `Scheduler.replanCard`'s guards. Same contract as
 * `chatAvailability` above: every disabled state here must match a refusal the scheduler
 * would actually give, or the button lies about what pressing it would do.
 */
describe('canReplan', () => {
  it('is not offered for a card that was never delegated', () => {
    expect(canReplan(task({ agentProjectId: null }), []).offered).toBe(false);
  });

  it('is not offered on a step — a step cannot own a plan', () => {
    expect(canReplan(step('s1', 'done'), []).offered).toBe(false);
  });

  // The case the whole feature is for: the chain is finished and the human wants more.
  it('is offered on a card whose chain has finished', () => {
    const steps = [step('s1', 'done'), step('s2', 'done')];
    expect(canReplan(task(), steps)).toMatchObject({ offered: true, can: true });
  });

  it('is offered on a delegated card with no steps at all', () => {
    expect(canReplan(task(), [])).toMatchObject({ offered: true, can: true });
  });

  it('is blocked while the chain is still running', () => {
    const steps = [step('s1', 'done'), step('s2', 'pending')];
    const r = canReplan(task(), steps);
    expect(r).toMatchObject({ offered: true, can: false });
    expect(r.hint).toBe(REFUSAL_HINT['chain-busy']);
  });

  it('is blocked while the card itself is mid-turn', () => {
    // Pressing it would stop the very answer the human is reading.
    expect(canReplan(task({ status: 'running' }), []).can).toBe(false);
    expect(canReplan(task({ status: 'waiting-input' }), []).can).toBe(false);
  });

  it('is blocked behind a usage limit', () => {
    const r = canReplan(task({ status: 'blocked-by-limit' }), []);
    expect(r.can).toBe(false);
    expect(r.hint).toBe(REFUSAL_HINT.limit);
  });

  it('is blocked once the card is full', () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS }, (_, i) => step(`s${i}`, 'done'));
    const r = canReplan(task(), steps);
    expect(r.can).toBe(false);
    expect(r.hint).toBe(REFUSAL_HINT['chain-full']);
  });
});
