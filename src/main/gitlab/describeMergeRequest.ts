/**
 * Turning one GitLab MR into the shape the reconciler eats.
 *
 * Separate from `gitlabSync.ts` because it is the impure half: the list endpoint alone
 * does not reliably carry `head_pipeline`, approvals or reviewers — which are exactly
 * the fields attention depends on — so each of those needs a call of its own.
 *
 * Two rules keep that honest:
 *
 *  - **Only re-read what moved** — but "moved" is not just `updated_at`. GitLab does not
 *    touch an MR when its pipeline finishes, so `needsDetailRefresh` also re-reads an MR
 *    whose pipeline is still in flight; see it for why a green pipeline used to read as
 *    running forever. Otherwise every poll would be four requests per open MR, forever.
 *  - **Degrade rather than guess.** `/approvals` is tier-gated and 403s on plenty of
 *    instances, and reviewer states need GitLab ≥16. A failure there leaves
 *    `approvalsRequired: null`, which the UI renders as "approvals unknown" — a
 *    confident and wrong `0/0` would be worse than admitting we don't know.
 */
import type { MergeRequest } from '@shared/mergeRequest';
import {
  toMergeRequestState,
  toPipelineStatus,
  type GitLabClient,
  type GitLabMergeRequest,
} from './gitlabClient';
import { stagesFromJobs } from './pipelineStages';
import type { FetchedMergeRequest } from './gitlabSync';

/** `references.full` is `group/repo!12`; the path is everything before the `!`. */
function projectPathOf(mr: GitLabMergeRequest): string {
  const full = mr.references?.full;
  if (full && full.includes('!')) return full.slice(0, full.indexOf('!'));
  // Fall back to the web URL: `https://host/group/repo/-/merge_requests/12`.
  const match = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(mr.web_url ?? '');
  return match?.[1] ?? '';
}

export interface DescribeOptions {
  /** Whether this MR changed since the last sync and is worth re-reading in full. */
  stale: boolean;
  /** What we already knew, reused when `stale` is false or a detail call fails. */
  prior?: MergeRequest;
}

export async function describeMergeRequest(
  client: GitLabClient,
  listed: GitLabMergeRequest,
  { stale, prior }: DescribeOptions,
): Promise<FetchedMergeRequest> {
  const projectId = listed.project_id;
  const iid = listed.iid;
  const updatedAt = Date.parse(listed.updated_at) || 0;

  let detail = listed;
  // Whether `detail` is the DETAIL response or still just the list entry. It decides
  // whether a missing pipeline is a fact about the MR or a gap in what we asked for.
  let detailRead = false;
  let approvalsRequired = prior?.approvalsRequired ?? null;
  let approvalsGiven = prior?.approvalsGiven ?? 0;
  let changesRequested = prior?.changesRequested ?? false;
  let notes: FetchedMergeRequest['notes'];

  if (stale) {
    // Each of these is allowed to fail on its own: a tier-gated 403 on approvals must
    // not cost us the pipeline status we did manage to read.
    const fetched = await client.getMergeRequest(projectId, iid).catch(() => null);
    if (fetched) {
      detail = fetched;
      detailRead = true;
    }

    const approvals = await client.getApprovals(projectId, iid).catch(() => null);
    if (approvals) {
      const required = approvals.approvals_required;
      approvalsRequired = typeof required === 'number' ? required : null;
      approvalsGiven = Array.isArray(approvals.approved_by)
        ? approvals.approved_by.length
        : Math.max(0, (approvalsRequired ?? 0) - (approvals.approvals_left ?? 0));
    }

    const reviewers = await client.getReviewers(projectId, iid).catch(() => []);
    // `requested_changes` needs GitLab >= 16 and is absent on older paths; when it is,
    // `false` here is not a claim that nobody objected — the reconciler's
    // "approvals dropped since last sync" signal stands in for it.
    changesRequested = reviewers.some((r) => r.state === 'requested_changes');

    notes = await client.listNotes(projectId, iid).catch(() => []);
  }

  const pipeline = detail.head_pipeline ?? detail.pipeline ?? null;

  /**
   * **There is genuinely no pipeline** — as opposed to us not having looked.
   *
   * These are two different facts that arrive looking identical, and conflating them is
   * what left a deleted pipeline on screen forever: delete `.gitlab-ci.yml`, push, and the
   * new head commit has no pipeline at all, so the detail endpoint answers
   * `head_pipeline: null`. That read `unknown`, `unknown` was treated as "no reading", and
   * the last thing we knew — a FAILED pipeline that no longer exists — was kept on every
   * subsequent sync.
   *
   * `in` rather than `== null`, because ABSENT and PRESENT-BUT-NULL are the whole
   * distinction: the list endpoint omits `head_pipeline` entirely, and letting that erase a
   * status we already knew is the original lie this guard was written to prevent. Only the
   * detail response gets a vote, and only when it actually answered.
   */
  const noPipeline =
    detailRead && 'head_pipeline' in detail && detail.head_pipeline == null && !detail.pipeline;

  // Whatever THIS sync carried wins over what we stored — a pipeline finishes without the
  // MR being touched, so a status read now can be newer than the MR claims to be.
  const readStatus = toPipelineStatus(pipeline?.status);
  const pipelineStatus =
    readStatus !== 'unknown'
      ? readStatus
      : noPipeline
        ? 'unknown'
        : (prior?.pipelineStatus ?? 'unknown');

  /**
   * The stages, under the same rule: an ANSWER replaces what we had, silence keeps it.
   *
   * A failed `listPipelineJobs` keeps the old stages — the endpoint is permission-gated,
   * and blanking the row on a 403 would look like a pipeline that lost its stages. But a
   * call that SUCCEEDS and returns nothing is an answer, and it must be allowed to empty
   * the row: a fresh pipeline whose jobs do not exist yet was otherwise shown wearing the
   * previous pipeline's stages, which is the same staleness in a smaller window.
   */
  let pipelineStages = prior?.pipelineStages ?? [];
  if (noPipeline) {
    pipelineStages = [];
  } else if (stale && typeof pipeline?.id === 'number') {
    const jobs = await client.listPipelineJobs(projectId, pipeline.id).catch(() => null);
    if (jobs) pipelineStages = stagesFromJobs(jobs);
  }

  return {
    gitlabProjectId: projectId,
    iid,
    projectPath: projectPathOf(detail) || projectPathOf(listed),
    title: detail.title ?? listed.title ?? '',
    description: detail.description ?? null,
    webUrl: detail.web_url ?? listed.web_url ?? '',
    sourceBranch: detail.source_branch ?? listed.source_branch ?? '',
    targetBranch: detail.target_branch ?? listed.target_branch ?? '',
    state: toMergeRequestState(detail.state ?? listed.state),
    draft: detail.draft ?? detail.work_in_progress ?? false,
    pipelineStatus,
    pipelineStages,
    // Cleared with the rest of it: a link to the pipeline of a commit that no longer has
    // one is the same stale claim, just clickable.
    pipelineUrl: pipeline?.web_url ?? (noPipeline ? null : (prior?.pipelineUrl ?? null)),
    approvalsRequired,
    approvalsGiven,
    changesRequested,
    updatedAt,
    notes,
  };
}
