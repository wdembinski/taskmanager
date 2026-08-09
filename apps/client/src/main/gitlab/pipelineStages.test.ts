import { describe, expect, it } from 'vitest';
import { foldStageStatus, stagesFromJobs } from './pipelineStages';
import type { GitLabJob } from './gitlabClient';

const job = (over: Partial<GitLabJob> = {}): GitLabJob => ({
  id: 1,
  name: 'j',
  stage: 'test',
  status: 'success',
  allow_failure: false,
  ...over,
});

describe('foldStageStatus', () => {
  it('is green when every job passed', () => {
    expect(foldStageStatus([job(), job({ id: 2, name: 'j2' })])).toBe('success');
  });

  it('is red when a job failed', () => {
    expect(foldStageStatus([job(), job({ id: 2, status: 'failed' })])).toBe('failed');
  });

  // A stage still working has not finished failing: calling it failed invites someone to
  // look before there is anything conclusive to see.
  it('reports running ahead of a failure in the same stage', () => {
    expect(foldStageStatus([job({ status: 'failed' }), job({ id: 2, status: 'running' })])).toBe(
      'running',
    );
  });

  // GitLab does not fail the pipeline for an allow_failure job, so a red stage here would
  // contradict the overall status sitting right beside it.
  it('treats a failed allow_failure job as passing', () => {
    expect(foldStageStatus([job({ status: 'failed', allow_failure: true })])).toBe('success');
    expect(foldStageStatus([job({ status: 'failed', allow_failure: true }), job({ id: 2 })])).toBe(
      'success',
    );
  });

  it('is skipped only when the whole stage was', () => {
    expect(foldStageStatus([job({ status: 'skipped' }), job({ id: 2, status: 'skipped' })])).toBe(
      'skipped',
    );
    expect(foldStageStatus([job({ status: 'skipped' }), job({ id: 2, status: 'success' })])).toBe(
      'success',
    );
  });

  it('surfaces a manual gate once nothing is still moving', () => {
    expect(foldStageStatus([job({ status: 'success' }), job({ id: 2, status: 'manual' })])).toBe(
      'manual',
    );
  });

  it('is unknown for no jobs at all', () => {
    expect(foldStageStatus([])).toBe('unknown');
  });
});

describe('stagesFromJobs', () => {
  // `/jobs` is newest-id first, so the list has to be walked in reverse to recover the
  // order the pipeline runs its stages in. Sorting by name would put deploy before test.
  it('returns stages in pipeline order, not job order or alphabetical', () => {
    const jobs = [
      job({ id: 30, name: 'deploy', stage: 'deploy' }),
      job({ id: 20, name: 'unit', stage: 'test' }),
      job({ id: 10, name: 'compile', stage: 'build' }),
    ];
    expect(stagesFromJobs(jobs).map((s) => s.name)).toEqual(['build', 'test', 'deploy']);
  });

  it('folds each stage from its own jobs', () => {
    const jobs = [
      job({ id: 20, name: 'unit', stage: 'test', status: 'failed' }),
      job({ id: 10, name: 'compile', stage: 'build', status: 'success' }),
    ];
    expect(stagesFromJobs(jobs)).toEqual([
      { name: 'build', status: 'success' },
      { name: 'test', status: 'failed' },
    ]);
  });

  // A retried job appears more than once. Counting the old attempt would leave a stage red
  // after a successful retry had made it green.
  it('counts only the newest attempt of a retried job', () => {
    const jobs = [
      job({ id: 99, name: 'unit', stage: 'test', status: 'success' }), // the retry
      job({ id: 11, name: 'unit', stage: 'test', status: 'failed' }), // the original
    ];
    expect(stagesFromJobs(jobs)).toEqual([{ name: 'test', status: 'success' }]);
  });

  it('ignores jobs with no stage rather than bucketing them under a blank name', () => {
    expect(stagesFromJobs([job({ stage: undefined }), job({ id: 2, stage: '  ' })])).toEqual([]);
  });

  it('is empty for no jobs, so the UI can fall back to the overall status', () => {
    expect(stagesFromJobs([])).toEqual([]);
  });
});
