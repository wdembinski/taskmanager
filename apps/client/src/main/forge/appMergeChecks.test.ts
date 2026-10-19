import { describe, expect, it } from 'vitest';
import { checksFromGitHub, checksFromGitLab } from './appMergeChecks';

describe('checksFromGitHub', () => {
  it('reads check runs by name, completed only once status is completed', () => {
    expect(
      checksFromGitHub(
        [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'in_progress', conclusion: null },
          { name: 'e2e', status: 'queued' },
        ],
        null,
      ),
    ).toEqual([
      { name: 'build', completed: true, conclusion: 'success' },
      { name: 'lint', completed: false, conclusion: 'unknown' },
      { name: 'e2e', completed: false, conclusion: 'unknown' },
    ]);
  });

  it('keeps neutral apart from skipped, unlike the dot folding', () => {
    expect(
      checksFromGitHub(
        [
          { name: 'a', status: 'completed', conclusion: 'neutral' },
          { name: 'b', status: 'completed', conclusion: 'skipped' },
          { name: 'c', status: 'completed', conclusion: 'timed_out' },
        ],
        undefined,
      ).map((c) => c.conclusion),
    ).toEqual(['neutral', 'skipped', 'timed_out']);
  });

  it('holds a completed run whose conclusion it does not recognise', () => {
    expect(
      checksFromGitHub([{ name: 'x', status: 'completed', conclusion: 'startup_failure' }], null),
    ).toEqual([{ name: 'x', completed: false, conclusion: 'unknown' }]);
  });

  it('appends commit statuses by context: pending, success, failure and error', () => {
    expect(
      checksFromGitHub([], {
        state: 'failure',
        statuses: [
          { context: 'ci/a', state: 'pending' },
          { context: 'ci/b', state: 'success' },
          { context: 'ci/c', state: 'failure' },
          { context: 'ci/d', state: 'error' },
        ],
      }),
    ).toEqual([
      { name: 'ci/a', completed: false, conclusion: 'unknown' },
      { name: 'ci/b', completed: true, conclusion: 'success' },
      { name: 'ci/c', completed: true, conclusion: 'failure' },
      { name: 'ci/d', completed: true, conclusion: 'failure' },
    ]);
  });

  it('keeps a check with no name rather than dropping it', () => {
    expect(checksFromGitHub([{ status: 'completed', conclusion: 'failure' }], null)).toEqual([
      { name: 'unnamed check', completed: true, conclusion: 'failure' },
    ]);
  });
});

describe('checksFromGitLab', () => {
  it('reads every unfinished status as not completed', () => {
    const statuses = [
      'created',
      'pending',
      'running',
      'manual',
      'scheduled',
      'waiting_for_resource',
    ];
    expect(
      checksFromGitLab(statuses.map((status) => ({ name: status, status }))).every(
        (c) => !c.completed && c.conclusion === 'unknown',
      ),
    ).toBe(true);
  });

  it('maps success, failed, canceled and skipped', () => {
    expect(
      checksFromGitLab([
        { name: 'build', status: 'success' },
        { name: 'test', status: 'failed' },
        { name: 'deploy', status: 'canceled' },
        { name: 'docs', status: 'skipped' },
      ]),
    ).toEqual([
      { name: 'build', completed: true, conclusion: 'success' },
      { name: 'test', completed: true, conclusion: 'failure' },
      { name: 'deploy', completed: true, conclusion: 'cancelled' },
      { name: 'docs', completed: true, conclusion: 'skipped' },
    ]);
  });

  it('reads a failed job that is allowed to fail as neutral', () => {
    expect(checksFromGitLab([{ name: 'audit', status: 'failed', allow_failure: true }])).toEqual([
      { name: 'audit', completed: true, conclusion: 'neutral' },
    ]);
  });

  it('holds a status it does not recognise', () => {
    expect(checksFromGitLab([{ name: 'x', status: 'preparing' }])).toEqual([
      { name: 'x', completed: false, conclusion: 'unknown' },
    ]);
  });
});
