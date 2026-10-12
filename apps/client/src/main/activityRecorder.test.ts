import { describe, expect, it, vi } from 'vitest';
import type { ActivityRow } from '@shared/activity';
import { createActivityRecorder, releasedVersionFrom } from './activityRecorder';

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

describe('releasedVersionFrom', () => {
  it("reads the version out of the agent's closing reply", () => {
    expect(releasedVersionFrom('Released v1.4.0, tagged and published on GitHub.')).toBe('v1.4.0');
  });

  it('returns null when the reply names no version', () => {
    expect(releasedVersionFrom('Published the release, but forgot to say which one.')).toBeNull();
  });

  it('keeps a prerelease suffix', () => {
    expect(releasedVersionFrom('Released v2.0.0-beta.1 to the canary channel.')).toBe(
      'v2.0.0-beta.1',
    );
  });
});
