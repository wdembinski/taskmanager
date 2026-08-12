/**
 * Folding a commit's check runs into the stage row a card shows — pure, so it is
 * unit-tested rather than guessed at against a live repository.
 *
 * The GitHub half of what `gitlab/pipelineStages.ts` does, and the differences are all in
 * the payload rather than the idea:
 *
 *  - **Two fields, not one.** A GitLab job has a single `status`; a check run has a
 *    `status` (`queued` / `in_progress` / `completed`) and, only once completed, a
 *    `conclusion`. Both are needed to say what one dot means — a `completed` run tells you
 *    nothing on its own.
 *  - **There are no stages.** GitHub has no equivalent of GitLab's `stage` field: a
 *    workflow's jobs are a graph, not a sequence, and the only name a check run carries is
 *    its own. So the group *is* the job name — which is why the matrix suffix has to go
 *    (see {@link stripMatrixSuffix}), or a twelve-way matrix would draw twelve dots that
 *    all say the same thing.
 *  - **Retries are the server's problem.** `filter=latest` means a re-run replaces its
 *    predecessor before we ever see it, so there is no hand-written "newest attempt wins"
 *    pass here. GitLab needs one.
 *
 * The fold itself — which of several outcomes a group takes — is not GitHub's and lives in
 * `../forge/stageFold`, shared with GitLab so a mixed board cannot draw the same situation
 * two different ways.
 */
import type { PipelineStage, PipelineStatus } from '@shared/mergeRequest';
import { foldStageStatus, type FoldableJob } from '../forge/stageFold';
import type { GitHubCheckRun, GitHubStatusContext } from './githubClient';

/**
 * What one check run says, from its `status` and `conclusion` together.
 *
 * The two GitHub conclusions with no obvious home:
 *
 *  - `action_required` is a **failure**, not a pause. It is what a check emits when it has
 *    stopped and wants a human — an unapproved deployment, a required manual step — and
 *    GitHub itself shows it red. Reading it as `manual` would file it beside the optional
 *    jobs nobody has to run.
 *  - `stale` means the run belongs to a push that has been superseded. It is not a verdict
 *    on the current head at all, so it folds in as `skipped` rather than colouring the
 *    group with an answer to a question nobody asked.
 *
 * A `completed` run with no conclusion at all is `unknown` — GitHub answered, but not with
 * anything we can draw, and {@link foldStageStatus} ignores it unless it is all there is.
 */
export function checkRunStatus(run: Pick<GitHubCheckRun, 'status' | 'conclusion'>): PipelineStatus {
  switch (run.status) {
    case 'queued':
    case 'waiting':
    case 'requested':
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
  }
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    case 'neutral':
    case 'skipped':
    case 'stale':
      return 'skipped';
    default:
      return 'unknown';
  }
}

/**
 * What one legacy commit status says. Four values, and `error` is the one that catches
 * people out: it means the reporting service itself broke, which is still a red X on the
 * PR and must not read as "no answer".
 */
export function statusContextStatus(state: string | null | undefined): PipelineStatus {
  switch (state) {
    case 'success':
      return 'success';
    case 'pending':
      return 'pending';
    case 'failure':
    case 'error':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * A check run's name with its matrix leg removed: `test (ubuntu-latest, 20)` → `test`.
 *
 * A GitHub Actions matrix names every leg after the job plus its parameters in brackets, so
 * a build across three OSes and four Node versions arrives as twelve check runs with twelve
 * distinct names. Grouped by name, that is twelve dots in a row that all mean "the build" —
 * a row nobody can read, and one that says nothing the folded version doesn't. Stripping
 * the suffix is the same job GitLab's `stage` field does for free.
 *
 * Only a trailing group is stripped, and only when something survives it: a check named
 * `(pending)` — or one whose entire name is bracketed — keeps it, since an empty group name
 * is a dot that says nothing at all.
 */
export function stripMatrixSuffix(name: string): string {
  const stripped = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return stripped || name.trim();
}

/** Group already-named items in first-seen order, then fold each group. */
function foldGroups(items: ReadonlyArray<{ name: string; job: FoldableJob }>): PipelineStage[] {
  const byName = new Map<string, FoldableJob[]>();
  for (const { name, job } of items) {
    if (!name) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push(job);
    else byName.set(name, [job]);
  }
  return [...byName.entries()].map(([name, jobs]) => ({ name, status: foldStageStatus(jobs) }));
}

/**
 * The stage row for a commit's check runs, one entry per job name.
 *
 * Response order is kept as it comes. GitHub documents no order for this endpoint, so
 * there is nothing to recover — unlike GitLab's `/jobs`, which is documented newest-first
 * and therefore has to be reversed to read as a pipeline. Inventing an order here (sorting
 * by name, by start time) would claim a sequence that a job graph does not have.
 */
export function stagesFromCheckRuns(runs: readonly GitHubCheckRun[]): PipelineStage[] {
  return foldGroups(
    runs.map((run) => ({
      name: stripMatrixSuffix(run.name ?? ''),
      job: { status: checkRunStatus(run) },
    })),
  );
}

/** The same row, for a repository still reporting CI through commit statuses. */
export function stagesFromStatusContexts(
  statuses: readonly GitHubStatusContext[],
): PipelineStage[] {
  return foldGroups(
    statuses.map((status) => ({
      name: stripMatrixSuffix(status.context ?? ''),
      job: { status: statusContextStatus(status.state) },
    })),
  );
}

/**
 * The single overall status, folded over every run rather than over the stage row.
 *
 * Over the runs, because folding twice would let a group's own fold hide a detail from the
 * overall answer — and because the two must agree: a row of dots with one red in it beside
 * an overall "success" is the kind of disagreement that makes a human stop trusting both.
 *
 * Empty means `unknown`, and the caller must decide whether that is "no CI here" or "we did
 * not look" — a distinction `describePullRequest.ts` makes very deliberately.
 */
export function overallCheckStatus(runs: readonly GitHubCheckRun[]): PipelineStatus {
  return foldStageStatus(runs.map((run) => ({ status: checkRunStatus(run) })));
}

/** The overall status for legacy commit statuses, folded the same way over the contexts. */
export function overallStatusContextStatus(
  statuses: readonly GitHubStatusContext[],
): PipelineStatus {
  return foldStageStatus(statuses.map((s) => ({ status: statusContextStatus(s.state) })));
}
