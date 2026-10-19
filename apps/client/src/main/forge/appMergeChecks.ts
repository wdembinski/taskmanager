/**
 * The forge's CI, reduced to the {@link AppMergeCheck} shape `appMergeDecision` reads — one
 * normaliser per forge, so the decision itself never sees a GitHub conclusion or a GitLab job
 * status.
 *
 * Deliberately NOT built on `github/checkRuns.ts`'s `checkRunStatus`: that one draws dots, and
 * folds `neutral` into `skipped` because the two look the same. The merge decision has to tell
 * them apart, so this reads `status`/`conclusion` directly.
 *
 * Anything this does not recognise reads as NOT completed — a check the app cannot classify
 * holds the merge rather than waving it through.
 */
import type { AppMergeCheck } from '@shared/appMerge';
import type { GitHubCheckRun, GitHubCombinedStatus } from '../github/githubClient';
import type { GitLabJob } from '../gitlab/gitlabClient';

/** The name a check with none is listed under — kept, never dropped, since a failing check
 *  with no name must still refuse the merge. */
const UNNAMED = 'unnamed check';

const GITHUB_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
  'neutral',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
]);

function pending(name: string): AppMergeCheck {
  return { name, completed: false, conclusion: 'unknown' };
}

function done(name: string, conclusion: AppMergeCheck['conclusion']): AppMergeCheck {
  return { name, completed: true, conclusion };
}

/**
 * GitHub's two kinds of CI for one commit: check runs (named by `name`, completed only once
 * `status` is `completed`) and legacy commit statuses (named by `context`; `pending` is still
 * running, `success` passed, `failure`/`error` failed).
 */
export function checksFromGitHub(
  runs: readonly GitHubCheckRun[],
  combined: GitHubCombinedStatus | null | undefined,
): AppMergeCheck[] {
  const checks: AppMergeCheck[] = runs.map((run) => {
    const name = run.name || UNNAMED;
    if (run.status !== 'completed') return pending(name);
    const conclusion = run.conclusion ?? '';
    return GITHUB_CONCLUSIONS.has(conclusion)
      ? done(name, conclusion as AppMergeCheck['conclusion'])
      : pending(name);
  });
  for (const status of combined?.statuses ?? []) {
    const name = status.context || UNNAMED;
    switch (status.state) {
      case 'success':
        checks.push(done(name, 'success'));
        break;
      case 'failure':
      case 'error':
        checks.push(done(name, 'failure'));
        break;
      default:
        checks.push(pending(name));
    }
  }
  return checks;
}

/** GitLab job statuses that mean the job has not finished (or not started) yet. */
const GITLAB_UNFINISHED: ReadonlySet<string> = new Set([
  'created',
  'pending',
  'running',
  'manual',
  'scheduled',
  'waiting_for_resource',
]);

/**
 * One GitLab pipeline's jobs. A `failed` job marked `allow_failure` did not fail the pipeline,
 * so it reads as `neutral` — present, finished, and not a reason to refuse.
 */
export function checksFromGitLab(jobs: readonly GitLabJob[]): AppMergeCheck[] {
  return jobs.map((job) => {
    const name = job.name || UNNAMED;
    const status = job.status ?? '';
    if (GITLAB_UNFINISHED.has(status)) return pending(name);
    switch (status) {
      case 'success':
        return done(name, 'success');
      case 'failed':
        return done(name, job.allow_failure ? 'neutral' : 'failure');
      case 'canceled':
        return done(name, 'cancelled');
      case 'skipped':
        return done(name, 'skipped');
      default:
        return pending(name);
    }
  });
}
