/**
 * Whether a stored merge request or pull request is worth spending detail calls on — rules
 * that happen to be forge-neutral, which is why they live here rather than in either forge's
 * sync module. Both GitLab and GitHub share the same underlying fact: **the list endpoint
 * does not reliably move when the thing attention actually depends on does** — a pipeline
 * finishing, a check suite completing — so `updated_at` alone cannot decide what to re-read.
 */
import { mrIsSettled, type MergeRequest, type PipelineStatus } from '@shared/mergeRequest';

/**
 * Pipeline states a runner will move on **its own**, with nobody touching the MR.
 *
 * `manual` and `unknown` are deliberately absent: both can sit unchanged indefinitely, so
 * treating them as in-flight would re-read those MRs on every single poll forever.
 *
 * Exported for the "read back a settled MR" pass in `ipc.ts` (both forges): an MR whose
 * pipeline was still running the moment it merged must keep being read back — otherwise its
 * last known stage keeps whatever it was mid-run, forever. See `describeMergeRequest.ts`.
 */
export const PIPELINE_IN_FLIGHT: ReadonlySet<PipelineStatus> = new Set([
  'created',
  'pending',
  'running',
]);

/**
 * Whether this MR is worth spending its detail calls on.
 *
 * `updated_at` alone is not enough, and that is not a small oversight: **neither forge
 * touches an MR when its pipeline finishes.** A run going from `running` to `success` moves
 * nothing the list endpoint reports, so an MR first seen mid-pipeline stayed "running" in
 * the app for good — pressing Sync re-listed it, decided nothing had moved, and kept the
 * status it already had. Approvals behave the same way.
 *
 * So a pipeline the runners are still working is itself a reason to look again. That is
 * bounded: it stops the moment the pipeline reaches a terminal state.
 */
export function needsDetailRefresh(prior: MergeRequest | undefined, updatedAt: number): boolean {
  if (!prior) return true;
  if (updatedAt > prior.updatedAt) return true;
  return PIPELINE_IN_FLIGHT.has(prior.pipelineStatus);
}

/**
 * How long a freshly-observed `none` pipeline is given to turn into something real before it
 * is believed. GitHub creates check suites asynchronously after a push, so a PR read the
 * instant it opens can honestly find nothing yet — and 10 minutes is comfortably longer than
 * that creation ever takes.
 */
export const CI_SETTLE_GRACE_MS = 10 * 60_000;

/**
 * Whether GitHub's CI answer for this PR is worth asking again — the fix for the bug
 * `needsDetailRefresh` cannot see on its own: a PR whose pipeline reads `unknown` never
 * becomes stale by `updated_at`, because GitHub does not touch a PR when its checks start,
 * so it would stay `unknown` forever.
 *
 * `unknown` is always worth another look — it costs 2-3 requests and stops the moment either
 * of GitHub's CI systems answers. `none` is different: a repo with genuinely no CI would be
 * asked forever if that reading were trusted no more than `unknown` is, so it is instead
 * believed once the PR has gone quiet for {@link CI_SETTLE_GRACE_MS} — long enough for
 * GitHub's asynchronous check-suite creation to have happened, had there been anything to
 * create. Settled PRs are excluded: the "read back a settled MR" pass in `ipc.ts` already
 * hands their detail through unconditionally.
 */
export function needsCiRefresh(prior: MergeRequest | undefined, now: number): boolean {
  if (!prior || mrIsSettled(prior)) return false;
  if (prior.pipelineStatus === 'unknown') return true;
  if (prior.pipelineStatus === 'none') return now - prior.updatedAt < CI_SETTLE_GRACE_MS;
  return false;
}

/**
 * Whether this PR's mergeability is worth asking about again, independent of CI and of
 * `updated_at` entirely.
 *
 * Moving the BASE branch changes what `mergeable_state` answers without touching the PR
 * itself — a PR that read `clean` against `main` can read `dirty` the moment something else
 * merges into `main`, and neither forge bumps the PR's `updated_at` for a change that
 * happened on a different branch. GitHub's `unknown` answer — the mergeability job still
 * computing — has the identical shape: nothing moves `updated_at` when that job finishes,
 * so a PR caught mid-check would otherwise be believed `unknown` forever.
 *
 * `locked` counts as open here, same as `mrIsSettled` treats it: a locked PR is still open,
 * just frozen, and its mergeability can still move. The list this predicate feeds is open
 * PRs only — a sync never asks about a settled one — so this costs at most one extra call
 * per open PR per sync.
 */
export function needsMergeabilityRefresh(prior: MergeRequest | undefined): boolean {
  return !!prior && !mrIsSettled(prior);
}
