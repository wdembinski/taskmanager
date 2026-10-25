/**
 * Finding the merged pull requests the open search never saw.
 *
 * `syncGitHubPullRequests` asks for `is:open`, so a PR opened and merged between two polls —
 * or while the app was closed — has no row, and its card never lands. This runs ONE extra
 * search while some card is waiting on a branch nothing explains (see
 * `forge/landings.ts#unlandedBranchCandidates`), and turns the hits on a candidate's branch
 * into fetched rows for the normal reconcile, which files them by branch and lands them.
 *
 * It is careful about cost because it runs every sync: no candidate, no search; a hit already
 * stored or already checked costs nothing; at most {@link MERGED_DETAIL_CAP} detail reads a
 * sync; and a hit that turned out to be some other branch is remembered for the app run so
 * it is never read again.
 */
import type { MergeRequest } from '@shared/mergeRequest';
import type { BranchCandidates } from '../forge/landings';
import type { FetchedMergeRequest } from '../gitlab/gitlabSync';
import { describePullRequest, repoRefFromApiUrl } from './describePullRequest';
import type { GitHubClient } from './githubClient';

/** Detail reads one sync may spend on merged-search hits. */
export const MERGED_DETAIL_CAP = 10;

/** `owner/repo#number`, lower-cased — how a hit and a stored row are recognised as one. */
export function prRefOf(projectPath: string, number: number): string {
  return `${projectPath.toLowerCase()}#${number}`;
}

export interface MergedDiscoveryInput {
  client: GitHubClient;
  candidates: BranchCandidates;
  /** Every stored GitHub row, so a hit we already hold is not read again. */
  stored: readonly Pick<MergeRequest, 'projectPath' | 'number'>[];
  /** Refs already detail-read and found to be nobody's — kept by the caller per app run. */
  checked: Set<string>;
  /** Told about a failed search; the sync carries on without discovery. */
  onError?: (e: unknown) => void;
}

export async function discoverMergedPullRequests(
  input: MergedDiscoveryInput,
): Promise<FetchedMergeRequest[]> {
  const { client, candidates, checked } = input;
  if (!candidates.since || candidates.byBranch.size === 0) return [];

  let hits;
  try {
    hits = await client.searchMergedPullRequests(candidates.since, 1);
  } catch (e) {
    input.onError?.(e);
    return [];
  }

  const storedRefs = new Set(input.stored.map((mr) => prRefOf(mr.projectPath, mr.number)));
  const found: FetchedMergeRequest[] = [];
  let details = 0;
  for (const item of hits) {
    const { owner, repo } = repoRefFromApiUrl(item.repository_url);
    if (!owner || !repo) continue;
    const ref = prRefOf(`${owner}/${repo}`, item.number);
    if (storedRefs.has(ref) || checked.has(ref)) continue;
    if (details >= MERGED_DETAIL_CAP) break;
    details += 1;
    // The search row has no branch; only the detail says whose work this is.
    const detail = await client.getPullRequest(owner, repo, item.number).catch(() => null);
    if (!detail) continue; // unreadable this time — asked again next sync
    const branch = detail.head?.ref ?? '';
    if (!candidates.byBranch.has(branch)) {
      checked.add(ref);
      continue;
    }
    found.push(await describePullRequest(client, item, { stale: false, detail }));
  }
  return found;
}
