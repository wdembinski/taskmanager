/**
 * Discovering merged pull requests that have no stored row — the VPN shape where a PR was
 * opened and merged between two polls (or while the app was closed), so the `is:open` search
 * never returned it and its card never landed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/model';
import { mergedRowsToLand, unlandedBranchCandidates } from '../forge/landings';
import type { GitHubClient, GitHubPullRequest, GitHubSearchIssueItem } from './githubClient';
import { reconcilePullRequests } from './githubPrSync';
import { discoverMergedPullRequests, MERGED_DETAIL_CAP } from './mergedDiscovery';

const NOW = Date.parse('2026-10-25T09:00:00Z');
const MERGED_AT = '2026-10-24T14:34:38Z';

const hit = (number: number): GitHubSearchIssueItem => ({
  id: number,
  number,
  title: `PR ${number}`,
  body: null,
  state: 'closed',
  html_url: `https://github.com/acme/vpn/pull/${number}`,
  repository_url: 'https://api.github.com/repos/acme/vpn',
  updated_at: MERGED_AT,
  pull_request: { merged_at: MERGED_AT },
});

const detailFor = (number: number, branch: string): GitHubPullRequest => ({
  id: number,
  number,
  title: `PR ${number}`,
  body: null,
  state: 'closed',
  merged: true,
  merged_at: MERGED_AT,
  html_url: `https://github.com/acme/vpn/pull/${number}`,
  head: { ref: branch, sha: `sha-${number}`, repo: { id: 77, full_name: 'acme/vpn' } },
  base: { ref: 'main', repo: { id: 77, full_name: 'acme/vpn' } },
});

/** A fake GitHub: `branches` maps a PR number to its head branch. */
function fakeClient(hits: GitHubSearchIssueItem[], branches: Record<number, string>) {
  const fake = {
    searchMergedPullRequests: vi.fn(async (_since: string, _pages?: number) => hits),
    getPullRequest: vi.fn(async (_o: string, _r: string, n: number) => detailFor(n, branches[n])),
    listCheckRuns: vi.fn(async () => []),
    getCombinedStatus: vi.fn(async () => ({ state: 'success', total_count: 0, statuses: [] })),
  };
  return { fake, client: fake as unknown as GitHubClient };
}

const card = (over: Partial<Task> & { id: string }): Task =>
  ({
    projectId: 'vpn',
    phase: '',
    title: over.id,
    status: 'in-progress',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    parentTaskId: null,
    landedAt: null,
    workedAt: NOW - 86_400_000,
    ...over,
  }) as Task;

const VPN7 = card({ id: 'vpn-7', agentBranch: 'feat/vpn-device-names' });

describe('discoverMergedPullRequests', () => {
  it('brings back a merged PR on a candidate’s branch, which then lands its card', async () => {
    const { client } = fakeClient([hit(9)], { 9: VPN7.agentBranch! });
    const candidates = unlandedBranchCandidates([VPN7], [], NOW);

    const found = await discoverMergedPullRequests({
      client,
      candidates,
      stored: [],
      checked: new Set(),
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ number: 9, state: 'merged', sourceBranch: VPN7.agentBranch });
    // Through the normal reconcile — filed by branch — and the landing set, on this first sync.
    const { upserts } = reconcilePullRequests([], found, {
      knownKeys: [],
      taskIdByKey: new Map(),
      knownTaskIds: new Set([VPN7.id]),
      taskIdByBranch: new Map([[VPN7.agentBranch!, VPN7.id]]),
      identity: null,
      now: NOW,
    });
    const landings = mergedRowsToLand(upserts, upserts, () => VPN7);
    expect(landings.map((l) => [l.taskId, l.mr.mergedAt])).toEqual([
      [VPN7.id, Date.parse(MERGED_AT)],
    ]);
  });

  it('detail-reads a hit on nobody’s branch once, and never again this run', async () => {
    const { fake, client } = fakeClient([hit(5)], { 5: 'fix/loopback-close-releases-port' });
    const candidates = unlandedBranchCandidates([VPN7], [], NOW);
    const checked = new Set<string>();

    expect(await discoverMergedPullRequests({ client, candidates, stored: [], checked })).toEqual(
      [],
    );
    expect(await discoverMergedPullRequests({ client, candidates, stored: [], checked })).toEqual(
      [],
    );
    expect(fake.getPullRequest).toHaveBeenCalledTimes(1);
    expect(checked).toEqual(new Set(['acme/vpn#5']));
  });

  it('makes no search at all when there is no candidate', async () => {
    const { fake, client } = fakeClient([hit(9)], { 9: VPN7.agentBranch! });
    const candidates = unlandedBranchCandidates([{ ...VPN7, landedAt: 1 }], [], NOW);

    expect(
      await discoverMergedPullRequests({ client, candidates, stored: [], checked: new Set() }),
    ).toEqual([]);
    expect(fake.searchMergedPullRequests).not.toHaveBeenCalled();
  });

  it('searches from the candidate’s date, one page', async () => {
    const { fake, client } = fakeClient([], {});
    const candidates = unlandedBranchCandidates([VPN7], [], NOW);
    await discoverMergedPullRequests({ client, candidates, stored: [], checked: new Set() });
    expect(fake.searchMergedPullRequests).toHaveBeenCalledWith('2026-10-24', 1);
  });

  it('leaves the sync’s other output untouched when the search fails', async () => {
    const { fake, client } = fakeClient([], {});
    fake.searchMergedPullRequests.mockRejectedValueOnce(new Error('403 rate limited'));
    const errors: unknown[] = [];
    const detailed = [{ number: 1 }];

    detailed.push(
      ...(await discoverMergedPullRequests({
        client,
        candidates: unlandedBranchCandidates([VPN7], [], NOW),
        stored: [],
        checked: new Set(),
        onError: (e) => errors.push(e),
      })),
    );

    expect(detailed).toEqual([{ number: 1 }]);
    expect(errors).toHaveLength(1);
  });

  it('skips a hit we already store, and spends at most the cap on details', async () => {
    const hits = Array.from({ length: MERGED_DETAIL_CAP + 5 }, (_, i) => hit(i + 1));
    const { fake, client } = fakeClient(hits, {});
    await discoverMergedPullRequests({
      client,
      candidates: unlandedBranchCandidates([VPN7], [], NOW),
      stored: [{ projectPath: 'Acme/VPN', number: 1 }],
      checked: new Set(),
    });
    expect(fake.getPullRequest).toHaveBeenCalledTimes(MERGED_DETAIL_CAP);
    expect(fake.getPullRequest).not.toHaveBeenCalledWith('acme', 'vpn', 1);
  });
});
