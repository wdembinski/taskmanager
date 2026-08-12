/**
 * Folding a set of CI jobs into ONE outcome — the rule, with no forge in it.
 *
 * GitLab reports jobs with a `status` and an `allow_failure`; GitHub reports check runs
 * with a conclusion and a `continue-on-error` equivalent. The question both answer is the
 * same — "several things ran, what does the group say?" — and the interesting part is the
 * precedence, which is the same either way. So the fold lives here over the two fields it
 * actually reads, and each forge's adapter narrows its own payload down to that shape
 * (`gitlab/pipelineStages.ts` for GitLab's jobs).
 */
import type { PipelineStatus } from '@shared/mergeRequest';

/** A CI job, reduced to the two things the fold needs. */
export interface FoldableJob {
  status: PipelineStatus;
  /** Whether a failure here is tolerated — a failed one folds in as a success. */
  allowFailure?: boolean;
}

/**
 * Which job outcome decides its group, most-decisive first.
 *
 * `running` outranks `failed` on purpose: a group with one broken job and another still
 * going has not finished failing yet, and calling it failed invites someone to look before
 * there is anything to see. `skipped` is last because a group that is entirely skipped is
 * the only case where it should win.
 */
const PRECEDENCE: readonly PipelineStatus[] = [
  'running',
  'failed',
  'pending',
  'created',
  'manual',
  'canceled',
  'success',
  'skipped',
];

/**
 * Fold one group's job statuses into a single outcome.
 *
 * `allowFailure` jobs are counted as `success` when they fail: neither forge fails the
 * overall run for them, so showing the group red would contradict the overall status
 * sitting right next to it.
 */
export function foldStageStatus(jobs: readonly FoldableJob[]): PipelineStatus {
  const statuses = new Set(
    jobs.map((job) =>
      job.status === 'failed' && job.allowFailure === true ? 'success' : job.status,
    ),
  );
  for (const candidate of PRECEDENCE) {
    if (statuses.has(candidate)) return candidate;
  }
  return 'unknown';
}
