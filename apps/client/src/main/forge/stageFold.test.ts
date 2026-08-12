import { describe, expect, it } from 'vitest';
import { foldStageStatus, type FoldableJob } from './stageFold';

const job = (over: Partial<FoldableJob> = {}): FoldableJob => ({
  status: 'success',
  allowFailure: false,
  ...over,
});

describe('foldStageStatus', () => {
  it('is green when every job passed', () => {
    expect(foldStageStatus([job(), job()])).toBe('success');
  });

  it('is red when a job failed', () => {
    expect(foldStageStatus([job(), job({ status: 'failed' })])).toBe('failed');
  });

  // A stage still working has not finished failing: calling it failed invites someone to
  // look before there is anything conclusive to see.
  it('reports running ahead of a failure in the same stage', () => {
    expect(foldStageStatus([job({ status: 'failed' }), job({ status: 'running' })])).toBe(
      'running',
    );
  });

  // Neither forge fails the overall run for a tolerated job, so a red stage here would
  // contradict the overall status sitting right beside it.
  it('treats a failed allow-failure job as passing', () => {
    expect(foldStageStatus([job({ status: 'failed', allowFailure: true })])).toBe('success');
    expect(foldStageStatus([job({ status: 'failed', allowFailure: true }), job()])).toBe('success');
  });

  it('is skipped only when the whole stage was', () => {
    expect(foldStageStatus([job({ status: 'skipped' }), job({ status: 'skipped' })])).toBe(
      'skipped',
    );
    expect(foldStageStatus([job({ status: 'skipped' }), job({ status: 'success' })])).toBe(
      'success',
    );
  });

  it('surfaces a manual gate once nothing is still moving', () => {
    expect(foldStageStatus([job({ status: 'success' }), job({ status: 'manual' })])).toBe('manual');
  });

  it('is unknown for no jobs at all', () => {
    expect(foldStageStatus([])).toBe('unknown');
  });

  // `allowFailure` is optional so a forge that has no such concept can leave it off; an
  // absent one must not read as "tolerated".
  it('does not tolerate a failure when nothing said it was tolerated', () => {
    expect(foldStageStatus([{ status: 'failed' }])).toBe('failed');
  });
});
