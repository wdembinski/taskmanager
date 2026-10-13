import { describe, expect, it } from 'vitest';
import { PERSONAL_PROJECT_ID, type Task, type TaskStatus } from './model';
import { RUN_REFUSAL_MESSAGE } from './scheduler';
import {
  VARIANT_HINTS,
  VARIANT_REFUSAL_MESSAGE,
  canStartVariants,
  planVariants,
  variantGroupState,
  type VariantFields,
} from './variants';

const task = (over: Partial<Task> & VariantFields & { id: string }): Task & VariantFields => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const leader = task({
  id: 'L',
  title: 'Fix the parser',
  description: 'It drops the last line.',
  agentProjectId: 'repo',
  agentMode: 'acceptEdits',
  agentModel: 'sonnet',
});

const row = (id: string, label: 'A' | 'B' | 'C', status: TaskStatus, over: Partial<Task> = {}) =>
  task({ id, variantOf: 'L', variantLabel: label, status, ...over });

describe('canStartVariants', () => {
  it('accepts a delegated board card at rest', () => {
    expect(canStartVariants(leader)).toEqual({ ok: true });
  });

  it('refuses a step', () => {
    expect(canStartVariants(task({ id: 's', parentTaskId: 'L', agentProjectId: 'repo' }))).toEqual({
      refused: 'is-step',
    });
  });

  it.each<TaskStatus>(['running', 'waiting-input', 'blocked-by-limit'])(
    'refuses a %s leader as already-running',
    (status) => {
      expect(canStartVariants({ ...leader, status })).toEqual({ refused: 'already-running' });
    },
  );

  it('refuses a missing or archived card', () => {
    expect(canStartVariants(undefined)).toEqual({ refused: 'unknown-task' });
    expect(canStartVariants({ ...leader, archivedAt: 1 })).toEqual({ refused: 'unknown-task' });
  });

  it('refuses a plan-project task and a row that is itself a variant', () => {
    expect(canStartVariants({ ...leader, projectId: 'plan-1', source: 'plan' })).toEqual({
      refused: 'not-a-card',
    });
    expect(canStartVariants(row('A1', 'A', 'pending', { agentProjectId: 'repo' }))).toEqual({
      refused: 'not-a-card',
    });
  });

  it('needs an agent project from the card or the dialog', () => {
    const bare = { ...leader, agentProjectId: null };
    expect(canStartVariants(bare)).toEqual({ refused: 'no-project' });
    expect(canStartVariants(bare, { agentProjectId: 'repo' })).toEqual({ ok: true });
  });

  it('shares the run refusals’ sentences', () => {
    expect(VARIANT_REFUSAL_MESSAGE['already-running']).toBe(RUN_REFUSAL_MESSAGE['already-running']);
  });
});

describe('planVariants', () => {
  it('×2 yields A and B with exactly one hint', () => {
    const drafts = planVariants(leader, 2, { agentProjectId: 'repo' });
    expect(drafts.map((d) => d.variantLabel)).toEqual(['A', 'B']);
    expect(drafts.filter((d) => d.hint !== null)).toHaveLength(1);
    expect(drafts[0]!.description).toBe('It drops the last line.');
    expect(drafts[1]!.description).toBe(`It drops the last line.\n\n${VARIANT_HINTS.B}`);
  });

  it('×3 yields A, B, C with distinct hints for B and C', () => {
    const drafts = planVariants(leader, 3, { agentProjectId: 'repo' });
    expect(drafts.map((d) => d.variantLabel)).toEqual(['A', 'B', 'C']);
    expect(drafts[1]!.hint).not.toBe(drafts[2]!.hint);
    expect(drafts.every((d) => d.variantOf === 'L' && d.title === 'Fix the parser')).toBe(true);
  });

  it('copies attachments and agent settings, the dialog winning over the card', () => {
    const drafts = planVariants(
      leader,
      2,
      { agentProjectId: 'other', model: 'opus', notes: 'be careful' },
      [{ name: 'log.txt' }, { name: 'shot.png' }],
    );
    for (const d of drafts) {
      expect(d).toMatchObject({
        agentProjectId: 'other',
        agentMode: 'acceptEdits',
        agentModel: 'opus',
        agentPlanningModel: null,
        notes: 'be careful',
        attachmentNames: ['log.txt', 'shot.png'],
      });
    }
  });

  it('gives a card with no description the hint alone', () => {
    const drafts = planVariants({ ...leader, description: null }, 2, { agentProjectId: 'repo' });
    expect(drafts[0]!.description).toBeNull();
    expect(drafts[1]!.description).toBe(VARIANT_HINTS.B);
  });

  it('rejects a count outside 2–3', () => {
    expect(() => planVariants(leader, 4 as never, { agentProjectId: 'repo' })).toThrow();
  });
});

describe('variantGroupState', () => {
  const state = (...statuses: TaskStatus[]) =>
    variantGroupState(
      leader,
      statuses.map((s, i) => row(`r${i}`, (['A', 'B', 'C'] as const)[i]!, s)),
    ).state;

  it('is none without rows', () => {
    expect(state()).toBe('none');
  });

  it.each<[TaskStatus[], string]>([
    [['running', 'pending'], 'running'],
    [['running', 'done', 'failed'], 'running'],
    [['blocked-by-limit', 'done'], 'running'],
    [['running', 'waiting-input'], 'waiting'],
    [['done', 'waiting-input', 'failed'], 'waiting'],
    [['pending', 'done'], 'queued'],
    [['done', 'done'], 'done'],
    [['done', 'failed', 'failed'], 'done'],
    [['failed', 'failed'], 'failed'],
    [['failed', 'stopped'], 'failed'],
    [['stopped', 'cancelled'], 'stopped'],
  ])('%j → %s', (statuses, expected) => {
    expect(state(...statuses)).toBe(expected);
  });

  it('ignores other groups and discarded rows, and orders rows by label', () => {
    const got = variantGroupState(leader, [
      row('b', 'B', 'done'),
      task({ id: 'x', variantOf: 'other', variantLabel: 'A', status: 'running' }),
      row('c', 'C', 'running', { archivedAt: 5 }),
      row('a', 'A', 'failed'),
      task({ id: 'plain', status: 'running' }),
    ]);
    expect(got).toEqual({
      state: 'done',
      rows: [
        { id: 'a', label: 'A', status: 'failed' },
        { id: 'b', label: 'B', status: 'done' },
      ],
    });
  });

  it('never reads or reports the leader’s status', () => {
    const rows = [row('a', 'A', 'running'), row('b', 'B', 'done')];
    const statuses: TaskStatus[] = ['pending', 'in-review', 'done', 'blocked', 'running'];
    const results = statuses.map((status) => {
      const l: Task = { ...leader, status };
      return variantGroupState(l, rows);
    });
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.rows.some((r) => r.id === 'L')).toBe(false);
    expect(Object.keys(results[0]!)).toEqual(['state', 'rows']);
  });
});
