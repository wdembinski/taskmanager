/**
 * Turning one GitHub pull request into the shape the reconciler eats.
 *
 * The impure half, mirroring `gitlab/describeMergeRequest.ts` — and its two rules transfer
 * unchanged, because they are about what a sync is allowed to *claim*, not about GitLab:
 *
 *  - **Only re-read what moved.** Each PR costs up to five requests, so they are spent only
 *    on a PR the caller says is stale. As on GitLab, "moved" cannot just mean `updated_at`:
 *    GitHub does not touch a pull request when its checks finish, so a PR first seen
 *    mid-run would otherwise read as running forever. That decision is the caller's
 *    (`needsDetailRefresh`), and it already re-reads anything whose pipeline is in flight.
 *  - **Degrade rather than guess.** Every detail call is `.catch()`ed on its own — a 403 on
 *    branch protection must not cost us the check runs we did manage to read — and a call
 *    that did not land leaves the field alone rather than blanking it. The one place this
 *    bites hardest is the approval bar: `…/protection` **403s without admin** on most
 *    repositories, and the honest answer there is `null`, which the UI renders as
 *    "approvals unknown". A confident `0` would say "no approval required" about a repo
 *    that requires two.
 *
 * What this step deliberately does NOT fetch is the discussion: `notes` is left undefined,
 * which the reconciler reads as "not re-read this time" and keeps what it knew. A PR's
 * comments are a separate endpoint and a separate decision about whose comments count.
 */
import type { MergeRequest, PipelineStage, PipelineStatus } from '@shared/mergeRequest';
import {
  GitHubError,
  toPullRequestState,
  type GitHubClient,
  type GitHubPullRequest,
  type GitHubReview,
  type GitHubSearchIssueItem,
} from './githubClient';
import {
  overallCheckStatus,
  overallStatusContextStatus,
  stagesFromCheckRuns,
  stagesFromStatusContexts,
} from './checkRuns';
// The reconciler is `gitlab/gitlabSync.ts` and this is the shape it eats; step 1 already
// made the shape itself provider-neutral, so a GitHub PR fills in the same fields a GitLab
// MR does rather than getting a parallel type nothing downstream would understand.
import type { FetchedMergeRequest } from '../gitlab/gitlabSync';

/** `https://api.github.com/repos/{owner}/{repo}` → the two path parts every call needs. */
export function repoRefFromApiUrl(url: string | undefined): { owner: string; repo: string } {
  const match = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url ?? '');
  return { owner: match?.[1] ?? '', repo: match?.[2] ?? '' };
}

/**
 * A detail response, dressed as the search row it never came from.
 *
 * For the one call that does not start at the search endpoint: a pull request that dropped
 * out of the open list is re-read **by number**, so that its ending is a fact rather than
 * an inference from its absence. {@link describePullRequest} is still the single place that
 * decides what a fetched PR looks like, and it takes a listing — so the detail is shaped
 * into one rather than the field mapping being written out a second time in the IPC layer.
 *
 * `pull_request.merged_at` is the field that carries the whole point of the re-read:
 * GitHub reports a landed PR as `closed`, and only `merged_at` tells "this shipped" apart
 * from "this was thrown away". See `toPullRequestState`.
 */
export function listedFromDetail(
  detail: GitHubPullRequest,
  owner: string,
  repo: string,
): GitHubSearchIssueItem {
  return {
    id: detail.id,
    number: detail.number,
    title: detail.title,
    body: detail.body ?? null,
    state: detail.state,
    draft: detail.draft,
    html_url: detail.html_url,
    // Only ever read back through `repoRefFromApiUrl`, which wants the trailing
    // `/repos/{owner}/{repo}` and nothing else.
    repository_url: `/repos/${owner}/${repo}`,
    updated_at: detail.updated_at ?? '',
    pull_request: { merged_at: detail.merged_at ?? null },
  };
}

export interface DescribePullRequestOptions {
  /** Whether this PR changed since the last sync and is worth spending its calls on. */
  stale: boolean;
  /** What we already knew, reused when `stale` is false or a detail call fails. */
  prior?: MergeRequest;
}

/** What the reviews say, once the history has been folded down to a verdict per reviewer. */
interface ReviewVerdicts {
  approvalsGiven: number;
  changesRequested: boolean;
}

/**
 * The latest verdict from each reviewer, counted.
 *
 * `/reviews` returns the whole HISTORY — every review anybody ever submitted, oldest first
 * — so counting `APPROVED` rows would count one reviewer three times and would go on
 * counting an approval that has since been replaced by a request for changes.
 *
 * `COMMENTED` reviews are skipped rather than treated as the reviewer's latest word, and
 * that is GitHub's own rule rather than a convenience: leaving a comment does not withdraw
 * an approval, on GitHub's PR page or in its merge check. Taking the literal last row would
 * un-approve every reviewer who approved and then said "nice one" underneath.
 *
 * `DISMISSED` does supersede — it is exactly the act of taking a review back — and counts
 * as neither an approval nor an objection.
 */
export function foldReviews(reviews: readonly GitHubReview[]): ReviewVerdicts {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const state = review.state?.toUpperCase();
    // PENDING is a draft review only its author can see; it is not a verdict yet.
    if (!state || state === 'COMMENTED' || state === 'PENDING') continue;
    const who =
      review.user?.id != null ? `id:${review.user.id}` : `login:${review.user?.login ?? ''}`;
    if (who === 'login:') continue;
    latest.set(who, state);
  }
  let approvalsGiven = 0;
  let changesRequested = false;
  for (const state of latest.values()) {
    if (state === 'APPROVED') approvalsGiven += 1;
    else if (state === 'CHANGES_REQUESTED') changesRequested = true;
  }
  return { approvalsGiven, changesRequested };
}

/** What one CI read produced, or null when nothing answered. */
interface CiReading {
  status: PipelineStatus;
  stages: PipelineStage[];
  url: string | null;
}

/**
 * The head commit's CI, from whichever of GitHub's two systems this repository uses.
 *
 * Check runs first, commit statuses second, and the order matters: a repo on GitHub Actions
 * has check runs and no statuses, a repo on Jenkins or Buildkite has statuses and no check
 * runs, and a repo migrating between them has both — where the check runs are the ones
 * telling you about the CI anybody is still maintaining.
 *
 * Returns an empty reading (`unknown`, no stages, no url) only when BOTH answered and both
 * were empty. That is the GitHub spelling of `describeMergeRequest`'s `noPipeline`, and it
 * exists for the same reported bug: delete the workflow file, push, and the new head commit
 * genuinely has no CI — which must clear the row rather than leave the previous commit's
 * red sitting there forever.
 */
async function readCi(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  webUrl: string,
): Promise<CiReading | null> {
  const runs = await client.listCheckRuns(owner, repo, sha).catch(() => null);
  if (runs?.length) {
    return {
      status: overallCheckStatus(runs),
      stages: stagesFromCheckRuns(runs),
      // The PR's own Checks tab, not one run's page: it is the view that shows all of them,
      // and it survives a re-run that gives every check run a new id.
      url: webUrl ? `${webUrl}/checks` : null,
    };
  }

  const combined = await client.getCombinedStatus(owner, repo, sha).catch(() => null);
  const statuses = combined?.statuses ?? [];
  if (statuses.length) {
    return {
      status: overallStatusContextStatus(statuses),
      stages: stagesFromStatusContexts(statuses),
      url: statuses.find((s) => s.target_url)?.target_url ?? null,
    };
  }

  // An empty answer from both is an answer: this commit has no CI. Silence from either —
  // a call that threw — is not, and keeps whatever we already knew.
  if (runs && combined) return { status: 'unknown', stages: [], url: null };
  return null;
}

/**
 * How many approvals this PR's target branch requires, or null when we could not find out.
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *  - **The rule is readable** — take `required_approving_review_count`, or 0 when the branch
 *    is protected without requiring reviews.
 *  - **404: the branch is not protected at all**, which is a real answer and really is zero.
 *    (A repository can still require reviews through a *ruleset*, which this endpoint knows
 *    nothing about — but that case is caught by `mergeable_state`, which comes back
 *    `blocked` and blocks the merge anyway. See `mergeBlockers`.)
 *  - **Anything else — 403 above all** — is us not being allowed to look, and stays `null`.
 *    Reading admin-gating as "no approvals required" is the identical mistake to trusting
 *    GitLab's tier-gated `/approvals` 403, and it produces the identical lie: a green tick
 *    on a PR nobody has reviewed.
 */
async function readApprovalBar(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  prior: number | null,
): Promise<number | null> {
  try {
    const protection = await client.getBranchProtection(owner, repo, branch);
    const count = protection?.required_pull_request_reviews?.required_approving_review_count;
    return typeof count === 'number' ? count : 0;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return 0;
    return prior;
  }
}

export async function describePullRequest(
  client: GitHubClient,
  listed: GitHubSearchIssueItem,
  { stale, prior }: DescribePullRequestOptions,
): Promise<FetchedMergeRequest> {
  const { owner, repo } = repoRefFromApiUrl(listed.repository_url);
  const number = listed.number;
  const updatedAt = Date.parse(listed.updated_at) || 0;

  /**
   * The DETAIL response, or null when we did not read one. Kept as its own variable rather
   * than folded onto `listed` the way GitLab does, because the two payloads here are
   * genuinely different types — a search row has no branches, no head SHA and no
   * `mergeable_state` — and `detail !== null` is exactly the "did we actually look?"
   * question every field below has to ask.
   */
  let detail: GitHubPullRequest | null = null;
  let approvalsRequired = prior?.approvalsRequired ?? null;
  let approvalsGiven = prior?.approvalsGiven ?? 0;
  let changesRequested = prior?.changesRequested ?? false;
  let pipelineStatus: PipelineStatus = prior?.pipelineStatus ?? 'unknown';
  let pipelineStages: PipelineStage[] = prior?.pipelineStages ?? [];
  let pipelineUrl: string | null = prior?.pipelineUrl ?? null;

  if (stale && owner && repo) {
    detail = await client.getPullRequest(owner, repo, number).catch(() => null);

    const reviews = await client.listReviews(owner, repo, number).catch(() => null);
    if (reviews) {
      const verdicts = foldReviews(reviews);
      approvalsGiven = verdicts.approvalsGiven;
      changesRequested = verdicts.changesRequested;
    }

    // The bar belongs to the TARGET branch, so it is only askable once the detail told us
    // which one that is — or, failing that, from what we already stored.
    const targetBranch = detail?.base?.ref ?? prior?.targetBranch ?? '';
    if (targetBranch) {
      approvalsRequired = await readApprovalBar(
        client,
        owner,
        repo,
        targetBranch,
        prior?.approvalsRequired ?? null,
      );
    }

    // Check runs hang off the head SHA, which only the detail carries. No detail, no CI
    // read — and therefore no change to what we knew about it.
    const sha = detail?.head?.sha;
    if (sha) {
      const ci = await readCi(client, owner, repo, sha, detail?.html_url ?? listed.html_url ?? '');
      if (ci) {
        pipelineStatus = ci.status;
        pipelineStages = ci.stages;
        pipelineUrl = ci.url;
      }
    }
  }

  return {
    /**
     * GitHub's numeric repository id — **and it is only on the detail**. A search row
     * carries `repository_url` and nothing else, so a first sighting whose detail call
     * failed has no id to give and falls back to 0. `projectPath` below is the field that
     * is always known, and is what a GitHub row should be identified by.
     */
    repoId: detail?.base?.repo?.id ?? prior?.repoId ?? 0,
    number,
    // `owner/repo`, parsed from the one field a search row always carries.
    projectPath: owner && repo ? `${owner}/${repo}` : (prior?.projectPath ?? ''),
    title: detail?.title ?? listed.title ?? '',
    description: detail?.body ?? listed.body ?? null,
    webUrl: detail?.html_url ?? listed.html_url ?? '',
    /**
     * The branches, and the reason a stale PR keeps the old ones: search rows do not carry
     * them at all. Blanking `sourceBranch` would also blank the JIRA key discovered from
     * it, which is how a PR would quietly fall off the card it was filed under.
     */
    sourceBranch: detail?.head?.ref ?? prior?.sourceBranch ?? '',
    targetBranch: detail?.base?.ref ?? prior?.targetBranch ?? '',
    state: toPullRequestState(detail ?? listed),
    draft: detail?.draft ?? listed.draft ?? false,
    pipelineStatus,
    pipelineStages,
    pipelineUrl,
    approvalsRequired,
    approvalsGiven,
    changesRequested,
    /**
     * GitHub's own merge verdict, raw, and **only from the detail response** — search rows
     * omit it entirely. Null means "we did not look this time", which the reconciler turns
     * into "keep what we knew"; blanking it would read as one fewer reason not to merge, on
     * a field whose whole job is to know about the conflicts and stale branches nothing
     * else here can see.
     */
    detailedMergeStatus: detail ? (detail.mergeable_state ?? null) : null,
    /**
     * `mergeable === false` is a conflict. `null` is not: it is GitHub saying the
     * mergeability job has not finished, which arrives as `mergeable_state: 'unknown'` and
     * reads as *checking* rather than clean. And a PR we did not read the detail for says
     * nothing at all about its branch, so it keeps what the last real read found.
     */
    hasConflicts: detail ? detail.mergeable === false : (prior?.hasConflicts ?? false),
    updatedAt,
  };
}
