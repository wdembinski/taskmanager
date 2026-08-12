import { describe, expect, it } from 'vitest';
// The FOLD — which of several job outcomes a stage takes — moved to `../forge/stageFold`
// and is tested there. What is left here is GitLab's own half: reading a `/jobs` payload
// into stages, in the order the pipeline runs them.
import { stagesFromJobs } from './pipelineStages';
import type { GitLabJob } from './gitlabClient';

const job = (over: Partial<GitLabJob> = {}): GitLabJob => ({
  id: 1,
  name: 'j',
  stage: 'test',
  status: 'success',
  allow_failure: false,
  ...over,
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

  // The adaptation into the neutral fold shape, end to end: GitLab spells the two fields
  // `status` and `allow_failure`, and both have to arrive for a tolerated failure to read
  // as green here rather than as a red stage beside a green pipeline.
  it('carries status and allow_failure through to the neutral fold', () => {
    const jobs = [
      job({ id: 20, name: 'lint', stage: 'test', status: 'failed', allow_failure: true }),
      job({ id: 10, name: 'compile', stage: 'build', status: 'canceled' }),
    ];
    expect(stagesFromJobs(jobs)).toEqual([
      { name: 'build', status: 'canceled' },
      { name: 'test', status: 'success' },
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
