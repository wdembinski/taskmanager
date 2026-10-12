import { describe, expect, it, vi } from 'vitest';
import type { ActivityRow } from '@shared/activity';
import { createActivityRecorder } from './activityRecorder';

const BASE_REF = { projectId: 'p1', taskId: 't1', runId: 'r1', title: 'Card title' };

describe('createActivityRecorder', () => {
  it('swallows a throwing append and logs instead of throwing', () => {
    const log = vi.fn();
    const recorder = createActivityRecorder({
      append: () => {
        throw new Error('disk full');
      },
      log,
    });

    expect(() => recorder.runStarted({ ...BASE_REF, origin: 'human' })).not.toThrow();
    expect(log).toHaveBeenCalledWith('activity: could not record run-started', expect.any(Error));
  });

  it('skips onAppended when append reports a duplicate (null)', () => {
    const onAppended = vi.fn();
    const recorder = createActivityRecorder({
      append: () => null,
      onAppended,
    });

    recorder.runFinished({ ...BASE_REF, origin: 'human', outcome: 'done', costUsd: 1.23 });

    expect(onAppended).not.toHaveBeenCalled();
  });

  it('fires onAppended with the stored row when append succeeds', () => {
    const onAppended = vi.fn();
    const row: ActivityRow = {
      id: 7,
      at: 1000,
      projectId: 'p1',
      taskId: 't1',
      runId: 'r1',
      kind: 'run-started',
      outcome: null,
      origin: 'human',
      title: 'Card title',
      costUsd: null,
      detail: null,
    };
    const recorder = createActivityRecorder({
      append: () => row,
      onAppended,
    });

    recorder.runStarted({ ...BASE_REF, origin: 'human' });

    expect(onAppended).toHaveBeenCalledWith(row);
  });
});
