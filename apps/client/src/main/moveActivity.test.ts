import { describe, expect, it, vi } from 'vitest';
import { toMoveActivity, transitionThenRecord } from './moveActivity';
import { PERSONAL_PROJECT_ID, type Task } from '@shared/model';

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: PERSONAL_PROJECT_ID,
    phase: '',
    title: 'Fix the export dialog',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'jira',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    agentProjectId: 'agent-1',
    ...overrides,
  } as Task;
}

describe('toMoveActivity', () => {
  it('builds a status-moved row from the task and its old/new status', () => {
    expect(toMoveActivity(card(), 'pending', 'in-review', 1000)).toEqual({
      at: 1000,
      projectId: PERSONAL_PROJECT_ID,
      taskId: 't1',
      runId: null,
      kind: 'status-moved',
      outcome: null,
      origin: 'human',
      title: 'Fix the export dialog',
      costUsd: null,
      detail: { from: 'pending', to: 'in-review' },
    });
  });

  it('defaults `at` to now', () => {
    const before = Date.now();
    const row = toMoveActivity(card(), 'pending', 'done');
    const after = Date.now();
    expect(row?.at).toBeGreaterThanOrEqual(before);
    expect(row?.at).toBeLessThanOrEqual(after);
  });

  it('is null when nothing moved', () => {
    expect(toMoveActivity(card(), 'in-review', 'in-review')).toBeNull();
  });
});

describe('transitionThenRecord', () => {
  it('records the transition’s result once it settles', async () => {
    const record = vi.fn();
    const log = vi.fn();
    const result = await transitionThenRecord(async () => 'the-task', record, log);
    expect(result).toBe('the-task');
    expect(record).toHaveBeenCalledWith('the-task');
    expect(log).not.toHaveBeenCalled();
  });

  it('propagates a transition failure and never records', async () => {
    const record = vi.fn();
    const log = vi.fn();
    await expect(
      transitionThenRecord(
        async () => {
          throw new Error('forge refused');
        },
        record,
        log,
      ),
    ).rejects.toThrow('forge refused');
    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs and swallows a recording failure, still returning the result', async () => {
    const log = vi.fn();
    const result = await transitionThenRecord(
      async () => 'the-task',
      () => {
        throw new Error('db is locked');
      },
      log,
    );
    expect(result).toBe('the-task');
    expect(log).toHaveBeenCalledWith(
      'Failed to record a card move to the activity log',
      expect.any(Error),
    );
  });
});
