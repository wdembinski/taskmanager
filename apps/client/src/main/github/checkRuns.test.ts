/**
 * What a row of dots is allowed to say about a commit's CI.
 *
 * The two things worth pinning down: a check run's meaning comes from `status` and
 * `conclusion` TOGETHER, and a matrix is one job however many legs it ran on.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRunStatus,
  overallCheckStatus,
  stagesFromCheckRuns,
  stagesFromStatusContexts,
  statusContextStatus,
  stripMatrixSuffix,
} from './checkRuns';
import type { GitHubCheckRun } from './githubClient';

const run = (name: string, status: string, conclusion: string | null = null): GitHubCheckRun => ({
  name,
  status,
  conclusion,
});

describe('checkRunStatus', () => {
  it('reads the queue and the run from `status`, before any conclusion exists', () => {
    expect(checkRunStatus({ status: 'queued', conclusion: null })).toBe('pending');
    expect(checkRunStatus({ status: 'waiting', conclusion: null })).toBe('pending');
    expect(checkRunStatus({ status: 'in_progress', conclusion: null })).toBe('running');
  });

  it('reads a completed run from its conclusion', () => {
    const of = (conclusion: string) => checkRunStatus({ status: 'completed', conclusion });
    expect(of('success')).toBe('success');
    expect(of('failure')).toBe('failed');
    expect(of('timed_out')).toBe('failed');
    expect(of('cancelled')).toBe('canceled');
    expect(of('neutral')).toBe('skipped');
    expect(of('skipped')).toBe('skipped');
  });

  // The one that is easy to file under `manual`: it means the check stopped and wants a
  // human, and GitHub itself shows it red.
  it('treats action_required as a failure rather than an optional job', () => {
    expect(checkRunStatus({ status: 'completed', conclusion: 'action_required' })).toBe('failed');
  });

  // `stale` is a verdict on a push that has been superseded — not on this head.
  it('folds a stale run in as skipped, and an answerless one as unknown', () => {
    expect(checkRunStatus({ status: 'completed', conclusion: 'stale' })).toBe('skipped');
    expect(checkRunStatus({ status: 'completed', conclusion: null })).toBe('unknown');
  });
});

describe('statusContextStatus', () => {
  it('counts `error` as red — the reporter breaking is still a red X on the PR', () => {
    expect(statusContextStatus('error')).toBe('failed');
    expect(statusContextStatus('failure')).toBe('failed');
    expect(statusContextStatus('pending')).toBe('pending');
    expect(statusContextStatus('success')).toBe('success');
    expect(statusContextStatus(undefined)).toBe('unknown');
  });
});

describe('stripMatrixSuffix', () => {
  it('drops the matrix leg', () => {
    expect(stripMatrixSuffix('test (ubuntu-latest, 20)')).toBe('test');
    expect(stripMatrixSuffix('build (windows)')).toBe('build');
  });

  it('leaves a plain name alone, and never strips a name down to nothing', () => {
    expect(stripMatrixSuffix('lint')).toBe('lint');
    expect(stripMatrixSuffix('(pending)')).toBe('(pending)');
  });
});

describe('stagesFromCheckRuns', () => {
  /**
   * The reason the suffix is stripped at all: twelve legs of one matrix are one job, and
   * twelve dots that all mean "the build" is a row nobody can read.
   */
  it('draws a matrix as one dot, folded across its legs', () => {
    const stages = stagesFromCheckRuns([
      run('test (ubuntu-latest, 20)', 'completed', 'success'),
      run('test (ubuntu-latest, 22)', 'completed', 'failure'),
      run('test (windows-latest, 20)', 'completed', 'success'),
      run('lint', 'completed', 'success'),
    ]);

    expect(stages).toEqual([
      { name: 'test', status: 'failed' },
      { name: 'lint', status: 'success' },
    ]);
  });

  it('keeps the response order rather than inventing a sequence', () => {
    const stages = stagesFromCheckRuns([
      run('deploy', 'queued'),
      run('build', 'completed', 'success'),
    ]);
    expect(stages.map((s) => s.name)).toEqual(['deploy', 'build']);
  });

  // A running leg outranks a failed one — the group has not finished failing yet.
  it('lets a still-running leg outrank a failed sibling', () => {
    const stages = stagesFromCheckRuns([
      run('test (a)', 'completed', 'failure'),
      run('test (b)', 'in_progress'),
    ]);
    expect(stages).toEqual([{ name: 'test', status: 'running' }]);
  });

  it('ignores a nameless run rather than drawing a dot that says nothing', () => {
    expect(stagesFromCheckRuns([run('', 'completed', 'success')])).toEqual([]);
  });
});

describe('stagesFromStatusContexts', () => {
  it('groups legacy contexts the same way', () => {
    expect(
      stagesFromStatusContexts([
        { context: 'ci/jenkins', state: 'success' },
        { context: 'ci/coverage', state: 'pending' },
      ]),
    ).toEqual([
      { name: 'ci/jenkins', status: 'success' },
      { name: 'ci/coverage', status: 'pending' },
    ]);
  });
});

describe('overallCheckStatus', () => {
  it('agrees with the row beside it — one red leg is a red overall', () => {
    expect(
      overallCheckStatus([run('a', 'completed', 'success'), run('b', 'completed', 'failure')]),
    ).toBe('failed');
  });

  it('is unknown for nothing at all, which the caller has to interpret', () => {
    expect(overallCheckStatus([])).toBe('unknown');
  });
});
