/**
 * Turning one GitLab MR into the shape the reconciler eats.
 *
 * Separate from `gitlabSync.ts` because it is the impure half: the list endpoint alone
 * does not reliably carry `head_pipeline`, approvals or reviewers — which are exactly
 * the fields attention depends on — so each of those needs a call of its own.
 *
 * Two rules keep that honest:
 *
 *  - **Only re-read what moved.** An MR whose `updated_at` has not changed since the
 *    last sync reuses what we stored. Otherwise every poll would be four requests per
 *    open MR, forever.
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
  let approvalsRequired = prior?.approvalsRequired ?? null;
  let approvalsGiven = prior?.approvalsGiven ?? 0;
  let changesRequested = prior?.changesRequested ?? false;
  let notes: FetchedMergeRequest['notes'];

  if (stale) {
    // Each of these is allowed to fail on its own: a tier-gated 403 on approvals must
    // not cost us the pipeline status we did manage to read.
    detail = await client.getMergeRequest(projectId, iid).catch(() => listed);

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
    pipelineStatus: stale
      ? toPipelineStatus(pipeline?.status)
      : (prior?.pipelineStatus ?? toPipelineStatus(pipeline?.status)),
    pipelineUrl: pipeline?.web_url ?? prior?.pipelineUrl ?? null,
    approvalsRequired,
    approvalsGiven,
    changesRequested,
    updatedAt,
    notes,
  };
}
