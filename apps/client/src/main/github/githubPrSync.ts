/**
 * Pure reconciliation of fetched GitHub pull requests into stored merge requests.
 *
 * `gitlab/gitlabSync.ts`, one forge over: no DB, no Electron — the IPC layer applies the
 * returned upserts and deletes. Its four disciplines are kept unchanged, because none of
 * them is about GitLab:
 *
 *  - **A stable id.** `gh-{repoId}-{number}`, so a PR keeps its identity — and therefore
 *    the user's read markers — across syncs.
 *  - **Only re-read what moved**, via {@link needsDetailRefresh}, which is re-exported from
 *    the GitLab module rather than copied because the rule and its reason are identical:
 *    **GitHub does not touch a pull request when its checks finish.** A check suite going
 *    from queued to green moves nothing the search endpoint reports, so a PR first seen
 *    mid-run would read as running forever. A pipeline the runners are still working is
 *    itself a reason to look again.
 *  - **`lastEventAt` fires on TRANSITIONS only** — checks going red, approvals dropping,
 *    becoming ready to merge. Bumping it while a PR is steadily red would re-raise the alarm
 *    on every poll, so "Mark seen" would never stick.
 *  - **`latestNoteAt` counts only comments that are not yours**, for the reason `identity.ts`
 *    gives: a PR is full of your own review, and counting it would leave every one you have
 *    ever spoken on permanently ringed. The three endpoints a GitHub discussion is scattered
 *    across are folded into one list upstream, in `describePullRequest.ts`.
 *  - **A settled PR is retained** on its card rather than deleted. The search asks for
 *    `is:open`, so a merged PR simply stops coming back; deleting on that absence is what
 *    made a merged MR vanish off its card at the very moment it had something worth saying.
 *
 * What differs is only *which card a PR belongs to* — see `prMatch.ts`, where GitHub's two
 * ways of naming an issue live.
 */
import {
  mrIsSettled,
  mrReadyToMerge,
  type MergeRequest,
  type PipelineStatus,
} from '@shared/mergeRequest';
import { pickTaskKey } from '../forge/issueKeys';
import { latestForeignNoteAt } from '../forge/notes';
import { githubAuthorIsMe, type GitHubIdentityCache } from './identity';
import { discoverPullRequestKeys, isRepoScopedKey } from './prMatch';
// The fetched shape and the staleness rule are the GitLab module's, and deliberately shared:
// step 1 made `MergeRequest` provider-neutral, so a GitHub PR fills in the same fields rather
// than getting a parallel type nothing downstream would understand.
import type { FetchedMergeRequest } from '../gitlab/gitlabSync';

export { needsDetailRefresh } from '../gitlab/gitlabSync';
export type { FetchedMergeRequest } from '../gitlab/gitlabSync';

export interface GitHubSyncOptions {
  /** Every `externalKey` on the board, so a key nothing carries is not a key. */
  knownKeys: readonly string[];
  /** Board key → task id, for filing a matched pull request. */
  taskIdByKey: ReadonlyMap<string, string>;
  /**
   * Every card id on the board, so a remembered link can be checked against it. See the
   * same field on `GitLabSyncOptions`, and {@link MergeRequest.openedForTaskId}.
   */
  knownTaskIds: ReadonlySet<string>;
  /**
   * Who you are on this GitHub instance, so your own comments are not news. Required rather
   * than optional — the same shape `GitLabSyncOptions` uses — because forgetting it has a
   * symptom nobody would report as a bug: every PR you have ever reviewed wearing an unread
   * ring forever. Null is a real value and means "we could not find out", which counts
   * nothing as yours; see `identity.ts` for why that is the safe direction.
   */
  identity: GitHubIdentityCache | null;
  now: number;
}

export interface GitHubSyncResult {
  upserts: MergeRequest[];
  /** Ids of stored pull requests that are no longer ours to track. */
  deleteIds: string[];
}

/** Check outcomes that mean "something broke", as opposed to "still running". */
const BAD_PIPELINES: ReadonlySet<PipelineStatus> = new Set(['failed', 'canceled']);

/** `gh-`, not `gl-`: one table holds both forges and their ids must not collide. */
export function pullRequestId(repoId: number, number: number): string {
  return `gh-${repoId}-${number}`;
}

/**
 * The other way to recognise a stored PR: `owner/repo#number`.
 *
 * Needed because GitHub's numeric repository id is **only on the detail response** — a
 * search row carries `repository_url` and nothing else — so a PR first seen through a failed
 * detail call is stored under `gh-0-{number}`. Matching on the repo path as well lets that
 * placeholder row hand its read markers to the real id once we learn it, instead of being
 * deleted alongside a fresh duplicate.
 */
function pathRef(pr: Pick<MergeRequest, 'projectPath' | 'number'>): string | null {
  // A row with no path at all cannot be recognised this way: `#5` would match every
  // repository's fifth pull request, which is exactly the aliasing the scoped key exists
  // to prevent.
  return pr.projectPath ? `${pr.projectPath.toLowerCase()}#${pr.number}` : null;
}

/**
 * Which board task a STORED pull request belongs to, given the board as it is now.
 *
 * Re-matching only sees the fields we store, and the description is not one of them. That
 * matters more here than on GitLab: a closing reference usually lives in the *body*, so it
 * is a key the app can only remember — hence remembered repo-scoped keys are tried first,
 * ahead of anything re-discoverable from the title or branch. Without that, a PR saying
 * "Closes #123" in its body on a branch mentioning a JIRA ticket would be filed under the
 * issue by the sync and under the ticket by the next re-match.
 *
 * A card this app opened the pull request FOR beats every one of those, because it is not a
 * re-derivation at all — see {@link MergeRequest.openedForTaskId}. It matters more here than
 * on GitLab, too: `prBody` writes a GitHub card's key as `Closes owner/repo#12` in the BODY,
 * and the body is the one field re-matching never gets to read.
 */
function matchTaskId(
  pr: Pick<
    MergeRequest,
    'title' | 'sourceBranch' | 'projectPath' | 'issueKeys' | 'openedForTaskId'
  >,
  opts: Pick<GitHubSyncOptions, 'knownKeys' | 'taskIdByKey' | 'knownTaskIds'>,
): string | null {
  if (pr.openedForTaskId && opts.knownTaskIds.has(pr.openedForTaskId)) return pr.openedForTaskId;
  const remembered = pr.issueKeys.filter((k) => opts.knownKeys.includes(k));
  const found = discoverPullRequestKeys(
    { title: pr.title, sourceBranch: pr.sourceBranch, projectPath: pr.projectPath },
    opts.knownKeys,
  );
  const key = pickTaskKey([...remembered.filter(isRepoScopedKey), ...found, ...remembered]);
  return key ? (opts.taskIdByKey.get(key) ?? null) : null;
}

/**
 * Reconcile the fetched pull requests against what is stored.
 *
 * `existing` is **this forge's rows only** — the caller filters by provider, because one
 * table holds both and a GitLab MR is not something a GitHub sync is entitled to delete.
 *
 * The retention rule is GitLab's, for the same reported bug: a SETTLED PR is kept as long as
 * it still names a card on the board — no ring (see `mrNeedsAttention`), no further network
 * calls (its state is terminal), and a merged/closed verdict where the approval tick used to
 * be. A settled PR whose ticket has since left the board is what stops the table growing
 * without bound. One that is still OPEN but unmatched keeps `taskId: null` and is re-matched
 * every sync, so a board change does not throw away its read markers.
 */
export function reconcilePullRequests(
  existing: readonly MergeRequest[],
  fetched: readonly FetchedMergeRequest[],
  opts: GitHubSyncOptions,
): GitHubSyncResult {
  const byId = new Map(existing.map((pr) => [pr.id, pr]));
  const byPath = new Map<string, MergeRequest>();
  for (const pr of existing) {
    const ref = pathRef(pr);
    if (ref) byPath.set(ref, pr);
  }
  const upserts: MergeRequest[] = [];
  const seen = new Set<string>();

  for (const pr of fetched) {
    const id = pullRequestId(pr.repoId, pr.number);
    seen.add(id);
    const ref = pathRef(pr);
    const prior = byId.get(id) ?? (ref ? byPath.get(ref) : undefined);

    const issueKeys = discoverPullRequestKeys(
      {
        title: pr.title,
        description: pr.description,
        sourceBranch: pr.sourceBranch,
        projectPath: pr.projectPath,
      },
      opts.knownKeys,
    );
    const key = pickTaskKey(issueKeys);
    // The card that opened it wins over the card its text names — see {@link matchTaskId}.
    // `prior` here may have been found by PATH rather than by id, which is exactly the case
    // that needs it: a pull request the button filed under `gh-0-{number}` hands its
    // remembered card over along with its read markers when the real repo id is learned.
    const openedForTaskId = prior?.openedForTaskId ?? null;
    const taskId =
      openedForTaskId && opts.knownTaskIds.has(openedForTaskId)
        ? openedForTaskId
        : key
          ? (opts.taskIdByKey.get(key) ?? null)
          : null;

    // The discussion is only re-read for PRs that changed, so an absent list means "keep what
    // we knew" rather than "there are none" — the same ternary `gitlabSync` uses, and the same
    // reason: a sync that did not look must not be able to un-mark a comment as unread.
    const latestNoteAt = pr.notes
      ? (latestForeignNoteAt(pr.notes, (n) => githubAuthorIsMe(n.author, opts.identity)) ??
        prior?.latestNoteAt ??
        null)
      : (prior?.latestNoteAt ?? null);

    // An event fires on the TRANSITION, never on a steady state — otherwise "Mark seen"
    // would be undone by the very next poll.
    const wentRed =
      BAD_PIPELINES.has(pr.pipelineStatus) &&
      !BAD_PIPELINES.has(prior?.pipelineStatus ?? 'unknown');
    const approvalsDropped = prior !== undefined && pr.approvalsGiven < prior.approvalsGiven;
    const nowRequested = pr.changesRequested && !prior?.changesRequested;
    // Becoming ready to merge is an event too — the good one, and under the same transition
    // discipline: a PR that is steadily green and approved would otherwise re-raise itself on
    // every poll and the ring would follow it until somebody merged it.
    const becameReady = mrReadyToMerge(pr) && !(prior !== undefined && mrReadyToMerge(prior));
    const lastEventAt =
      wentRed || approvalsDropped || nowRequested || becameReady
        ? opts.now
        : (prior?.lastEventAt ?? null);

    upserts.push({
      id,
      taskId,
      // Carried, never re-derived — GitHub has never heard of it, so the same rule the read
      // markers and the local rename follow applies.
      openedForTaskId,
      provider: 'github',
      repoId: pr.repoId,
      projectPath: pr.projectPath,
      number: pr.number,
      title: pr.title,
      webUrl: pr.webUrl,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      state: pr.state,
      draft: pr.draft,
      pipelineStatus: pr.pipelineStatus,
      pipelineStages: pr.pipelineStages,
      pipelineUrl: pr.pipelineUrl,
      approvalsRequired: pr.approvalsRequired,
      approvalsGiven: pr.approvalsGiven,
      changesRequested: pr.changesRequested,
      // Same fall-back rule as the checks and the branches: a sync that did not re-read the
      // detail keeps what we knew, rather than blanking GitHub's `mergeable_state` into
      // "unknown" — which `mergeBlockers` would then read as one fewer reason not to merge.
      detailedMergeStatus: pr.detailedMergeStatus ?? prior?.detailedMergeStatus ?? null,
      hasConflicts: pr.hasConflicts,
      issueKeys,
      latestNoteAt,
      // The user's own markers survive every sync — they are the one thing GitHub knows
      // nothing about, and a local rename is the same kind of field.
      displayName: prior?.displayName ?? null,
      lastReadAt: prior?.lastReadAt ?? null,
      lastEventAt,
      lastEventSeenAt: prior?.lastEventSeenAt ?? null,
      updatedAt: pr.updatedAt,
      syncedAt: opts.now,
    });
  }

  const deleteIds: string[] = [];
  for (const pr of existing) {
    if (seen.has(pr.id)) continue;
    // Settled and still filed under a card: keep it, re-matched against the board as it is
    // now — a card whose ticket has left takes its merged PRs with it on the next pass.
    if (mrIsSettled(pr)) {
      const taskId = matchTaskId(pr, opts);
      if (taskId !== null) {
        if (taskId !== pr.taskId) upserts.push({ ...pr, taskId });
        continue;
      }
    }
    deleteIds.push(pr.id);
  }

  return { upserts, deleteIds };
}

/**
 * Re-file stored pull requests against the board as it is now, without touching GitHub.
 *
 * Called when the board changes (a sync, a JQL edit): a PR whose issue has just appeared
 * should attach itself, and one whose issue has left should let go rather than point at a
 * card that no longer exists.
 */
export function rematchPullRequests(
  existing: readonly MergeRequest[],
  opts: Pick<GitHubSyncOptions, 'knownKeys' | 'taskIdByKey' | 'knownTaskIds'>,
): MergeRequest[] {
  const changed: MergeRequest[] = [];
  for (const pr of existing) {
    const taskId = matchTaskId(pr, opts);
    if (taskId !== pr.taskId) changed.push({ ...pr, taskId });
  }
  return changed;
}
