/**
 * A merged GitHub PR lands its card — end to end over the PURE pipeline the sync runs:
 * discovery → `reconcilePullRequests` → `mergedRowsToLand` → `landThenMoveToDone` → the real
 * `ChainRunner`. Only GitHub, the store and the scheduler's `runTask` are faked.
 *
 * The shapes are the ones that left VPN cards In Progress with their successors waiting until
 * somebody wrote `landedAt` into the database by hand (`.vipper/attach/vpn-landing-diagnosis.md`):
 * a PR the agent opened itself with no key in its text, a PR the app never saw open, a
 * force-pushed branch, a repeat poll — plus the two shapes the diagnosis found that the plan's
 * three root causes did not name: a merged row nobody claimed being deleted on the next sync
 * (U2), and a project with "Move to Done when its PR lands" switched off (U1).
 *
 * `sync()` below mirrors `ipc.ts#syncGitHub`'s order exactly — open list, read-back of the
 * rows that dropped out, discovery, reconcile, land, re-match, land again — so a change to
 * either side that the other does not follow shows up here first.
 */
import { describe, expect, it, vi } from 'vitest';
import { restingStatus } from '@shared/board';
import { mrIsSettled, type MergeRequest } from '@shared/mergeRequest';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { TaskLink } from '@shared/taskChain';
import { humanStatusPatch } from '../cardStatusGuard';
import { ChainRunner } from '../chainRunner';
import { buildBoardIndex } from '../forge/boardIndex';
import { mergedRowsToLand, unlandedBranchCandidates } from '../forge/landings';
import { landThenMoveToDone, type LandThenMoveDeps } from '../landedDoneMove';
import { describePullRequest } from './describePullRequest';
import type { GitHubClient, GitHubPullRequest, GitHubSearchIssueItem } from './githubClient';
import { reconcilePullRequests, rematchPullRequests } from './githubPrSync';
import { discoverMergedPullRequests } from './mergedDiscovery';

const REPO = 'wdembinski/vpn';
const T0 = Date.parse('2026-10-24T12:00:00Z');
const MIN = 60_000;

/** One pull request as GitHub holds it. Mutated by a test between syncs. */
interface Pr {
  number: number;
  branch: string;
  title: string;
  body: string | null;
  headSha: string;
  /** Epoch ms, or null while open. */
  mergedAt: number | null;
  updatedAt: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function searchRow(pr: Pr): GitHubSearchIssueItem {
  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.mergedAt ? 'closed' : 'open',
    html_url: `https://github.com/${REPO}/pull/${pr.number}`,
    repository_url: `https://api.github.com/repos/${REPO}`,
    updated_at: iso(pr.updatedAt),
    pull_request: { merged_at: pr.mergedAt ? iso(pr.mergedAt) : null },
  };
}

function detail(pr: Pr): GitHubPullRequest {
  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.mergedAt ? 'closed' : 'open',
    merged: pr.mergedAt !== null,
    merged_at: pr.mergedAt ? iso(pr.mergedAt) : null,
    updated_at: iso(pr.updatedAt),
    html_url: `https://github.com/${REPO}/pull/${pr.number}`,
    mergeable: true,
    mergeable_state: 'clean',
    head: { ref: pr.branch, sha: pr.headSha, repo: { id: 7, full_name: REPO } },
    base: { ref: 'main', repo: { id: 7, full_name: REPO } },
  };
}

/** GitHub, as far as this sync uses it. */
function fakeGitHub(prs: Map<number, Pr>) {
  const fake = {
    searchMergedPullRequests: vi.fn(async (since: string) =>
      [...prs.values()]
        .filter((pr) => pr.mergedAt !== null && iso(pr.mergedAt).slice(0, 10) >= since)
        .map(searchRow),
    ),
    getPullRequest: vi.fn(async (_o: string, _r: string, n: number) => {
      const pr = prs.get(n);
      if (!pr) throw new Error('404');
      return detail(pr);
    }),
    listCheckRuns: vi.fn(async () => []),
    getCombinedStatus: vi.fn(async () => ({ state: 'success', total_count: 0, statuses: [] })),
    listReviews: vi.fn(async () => []),
    listIssueComments: vi.fn(async () => []),
    listReviewComments: vi.fn(async () => []),
    getBranchProtection: vi.fn(async () => null),
  };
  return { fake, client: fake as unknown as GitHubClient };
}

const card = (over: Partial<Task> & { id: string }): Task =>
  ({
    projectId: 'vpn-board',
    agentProjectId: 'vpn-repo',
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
    workedAt: T0 - 60 * MIN,
    ...over,
  }) as Task;

/** The VPN-4 shape: worked on its own branch, and VPN-13 chained to start after it merges. */
function world(opts: { autoDoneOnLand?: boolean; onBoard?: boolean } = {}) {
  const tasks = new Map<string, Task>();
  const add = (t: Task) => tasks.set(t.id, t);
  if (opts.onBoard !== false) add(card({ id: 'vpn-4', agentBranch: 'feat/audit-trail' }));
  add(card({ id: 'vpn-13', status: 'pending', workedAt: null }));
  const links: TaskLink[] = [
    { id: 'l', fromTaskId: 'vpn-4', toTaskId: 'vpn-13', gate: 'after-merge', createdAt: 0 },
  ];
  const activity = new Map<string, TaskActivityEntry[]>();
  const stored = new Map<string, MergeRequest>();
  const prs = new Map<number, Pr>();
  const started: string[] = [];
  const checked = new Set<string>();
  let now = T0;
  const project = { id: 'vpn-repo', autoDoneOnLand: opts.autoDoneOnLand ?? true } as Project;

  const chain = new ChainRunner({
    links: () => links,
    getTask: (id) => tasks.get(id),
    setLandedAt: (id, at) => Object.assign(tasks.get(id)!, { landedAt: at }),
    addComment: () => {},
    runTask: (id) => {
      started.push(id);
      return true;
    },
    markInProgress: (id) =>
      Object.assign(tasks.get(id)!, humanStatusPatch(tasks.get(id)!, 'in-progress')),
    limitActive: () => false,
    inFlight: (id) => started.includes(id),
    branchOf: (t) => t.agentBranch ?? `orch/${t.id}`,
    projectTasks: (projectId) => [...tasks.values()].filter((t) => t.projectId === projectId),
    laneCap: () => 0,
    openPrTaskIds: () => new Set(),
    now: () => now,
  });

  const deps: LandThenMoveDeps = {
    noteWorkLanded: (id, at) => chain.landed(id, at),
    logError: (message, e) => {
      throw new Error(`${message}: ${String(e)}`);
    },
    getTask: (id) => tasks.get(id),
    getProject: (id) => (id === 'vpn-repo' ? project : undefined),
    getSubtasks: (parentId) => [...tasks.values()].filter((t) => t.parentTaskId === parentId),
    openPrTaskIds: () =>
      new Set(
        [...stored.values()].filter((m) => m.state === 'opened' && m.taskId).map((m) => m.taskId!),
      ),
    activity: (id) => activity.get(id) ?? [],
    writeForgeMove: async () => ({}),
    updateTask: (id, patch) => Object.assign(tasks.get(id)!, patch),
    recordStatusChange: (_p, id, from, to) =>
      activity.set(id, [
        ...(activity.get(id) ?? []),
        { kind: 'status', id: 0, from, to, createdAt: now },
      ]),
    addComment: () => {},
    emit: () => {},
    warn: () => {},
    dismissAttention: () => {},
  };

  const { client, fake } = fakeGitHub(prs);

  async function land(upserts: readonly MergeRequest[]): Promise<void> {
    const landings = mergedRowsToLand(upserts, [...stored.values()], (id) => tasks.get(id));
    for (const { taskId, mr } of landings) await landThenMoveToDone(deps, taskId, mr);
  }

  /** One `syncGitHub` pass, in `ipc.ts`'s order. */
  async function sync(): Promise<void> {
    const before = [...stored.values()];
    const ref = (path: string, n: number) => `${path.toLowerCase()}#${n}`;
    const open = [...prs.values()].filter((pr) => pr.mergedAt === null);
    const listed = new Set(open.map((pr) => ref(REPO, pr.number)));
    const detailed = [];
    for (const pr of open) {
      detailed.push(
        await describePullRequest(client, searchRow(pr), { stale: false, detail: detail(pr) }),
      );
    }
    // The read-back of rows that dropped out of the open list.
    for (const prior of before) {
      if (listed.has(ref(prior.projectPath, prior.number)) || mrIsSettled(prior)) continue;
      const pr = prs.get(prior.number);
      if (pr) {
        detailed.push(
          await describePullRequest(client, searchRow(pr), {
            stale: false,
            prior,
            detail: detail(pr),
          }),
        );
      }
    }
    detailed.push(
      ...(await discoverMergedPullRequests({
        client,
        candidates: unlandedBranchCandidates([...tasks.values()], before, now),
        stored: before,
        checked,
      })),
    );
    const index = buildBoardIndex([...tasks.values()]);
    const { upserts, deleteIds } = reconcilePullRequests(before, detailed, {
      ...index,
      identity: null,
      now,
    });
    for (const mr of upserts) stored.set(mr.id, mr);
    for (const id of deleteIds) stored.delete(id);
    await land(upserts);
    rematch();
    await land([]);
  }

  /** `rematchStoredMergeRequests` — also run by other syncs (JIRA) when the board changes. */
  function rematch(): void {
    for (const mr of rematchPullRequests(
      [...stored.values()],
      buildBoardIndex([...tasks.values()]),
    ))
      stored.set(mr.id, mr);
  }

  return {
    tasks,
    stored,
    prs,
    started,
    fake,
    sync,
    rematch,
    add,
    tick: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

/** VPN-4's PR #3: opened by the agent with `gh pr create`, no key anywhere in its text. */
const handOpened = (over: Partial<Pr> = {}): Pr => ({
  number: 3,
  branch: 'feat/audit-trail',
  title: 'Audit trail: record events and expose GET /audit',
  body: 'Adds the audit table.',
  headSha: 'sha-1',
  mergedAt: null,
  updatedAt: T0,
  ...over,
});

describe('a merged GitHub PR lands its card', () => {
  it('(1) a hand-opened PR with no key, on the card’s branch, lands the card', async () => {
    const w = world();
    w.prs.set(3, handOpened());
    await w.sync();
    expect([...w.stored.values()][0]).toMatchObject({ taskId: 'vpn-4', openedForTaskId: null });

    w.tick(5 * MIN);
    const mergedAt = w.now - 2 * MIN;
    w.prs.set(3, handOpened({ mergedAt, updatedAt: mergedAt }));
    await w.sync();

    const vpn4 = w.tasks.get('vpn-4')!;
    expect(vpn4.landedAt).toBe(mergedAt);
    expect(restingStatus(vpn4)).toBe('done');
    expect(w.started).toEqual(['vpn-13']);
  });

  it('(2) a PR with no row lands on the first sync that sees it merged', async () => {
    const w = world();
    // Opened and merged while the app was closed: the open search never returned it.
    const mergedAt = T0 - 10 * MIN;
    w.prs.set(3, handOpened({ mergedAt, updatedAt: mergedAt }));

    await w.sync();

    expect(w.fake.searchMergedPullRequests).toHaveBeenCalledTimes(1);
    expect([...w.stored.values()][0]).toMatchObject({ taskId: 'vpn-4', state: 'merged' });
    expect(w.tasks.get('vpn-4')!.landedAt).toBe(mergedAt);
    expect(w.started).toEqual(['vpn-13']);
  });

  it('(3) a force-pushed branch still lands', async () => {
    const w = world();
    w.prs.set(3, handOpened());
    await w.sync();
    w.tick(MIN);
    w.prs.set(3, handOpened({ headSha: 'sha-force-pushed', updatedAt: w.now }));
    await w.sync();
    expect([...w.stored.values()][0]).toMatchObject({
      taskId: 'vpn-4',
      headSha: 'sha-force-pushed',
    });

    w.tick(MIN);
    w.prs.set(3, handOpened({ headSha: 'sha-force-pushed', mergedAt: w.now, updatedAt: w.now }));
    await w.sync();
    expect(w.tasks.get('vpn-4')!.landedAt).toBe(w.now);
    expect(w.started).toEqual(['vpn-13']);
  });

  it('(4) a repeat poll lands once and starts one release', async () => {
    const w = world();
    const mergedAt = T0 - MIN;
    w.prs.set(3, handOpened({ mergedAt, updatedAt: mergedAt }));
    await w.sync();
    w.tick(2 * MIN);
    await w.sync();
    w.tick(2 * MIN);
    await w.sync();

    expect(w.tasks.get('vpn-4')!.landedAt).toBe(mergedAt);
    expect(w.started).toEqual(['vpn-13']);
    // Once landed it is no longer a candidate, so the extra search stops.
    expect(w.fake.searchMergedPullRequests).toHaveBeenCalledTimes(1);
  });

  /**
   * Root cause 1 on its own: a merged row filed under its card by a re-match OUTSIDE the
   * GitHub sync (a JIRA sync, a board change). The next GitHub sync sees nothing change about
   * the row, so it is in no upsert — only the stored half of the landing set catches it.
   */
  it('lands a merged row a re-match filed between syncs', async () => {
    const w = world({ onBoard: false });
    w.prs.set(3, handOpened());
    await w.sync();
    w.tick(MIN);
    const mergedAt = w.now;
    w.prs.set(3, handOpened({ mergedAt, updatedAt: mergedAt }));
    await w.sync(); // read back merged, still nobody's: stored with taskId null
    expect([...w.stored.values()][0]).toMatchObject({ state: 'merged', taskId: null });

    w.add(card({ id: 'vpn-4', agentBranch: 'feat/audit-trail' }));
    w.rematch(); // the board changed — some other sync re-files it
    w.tick(MIN);
    await w.sync();

    expect(w.tasks.get('vpn-4')!.landedAt).toBe(mergedAt);
    expect(w.started).toEqual(['vpn-13']);
  });

  /**
   * Diagnosis U2: a merged row nobody claims is DELETED on the next sync, which is why the
   * VPN PRs left no row behind. Once the card shows up, discovery finds the PR again.
   */
  it('(U2) a merged row deleted while unclaimed is rediscovered and lands', async () => {
    const w = world({ onBoard: false });
    w.prs.set(3, handOpened());
    await w.sync();
    w.tick(MIN);
    const mergedAt = w.now;
    w.prs.set(3, handOpened({ mergedAt, updatedAt: mergedAt }));
    await w.sync();
    w.tick(MIN);
    await w.sync(); // settled and unclaimed: deleted
    expect(w.stored.size).toBe(0);

    w.add(card({ id: 'vpn-4', agentBranch: 'feat/audit-trail' }));
    w.tick(MIN);
    await w.sync();

    expect(w.tasks.get('vpn-4')!.landedAt).toBe(mergedAt);
    expect(w.started).toEqual(['vpn-13']);
  });

  /**
   * Diagnosis U1: the VPN project has "Move to Done when its PR lands" OFF. The landing and
   * the release must not depend on it — only the column move does.
   */
  it('(U1) lands and releases with auto-Done off, leaving the column alone', async () => {
    const w = world({ autoDoneOnLand: false });
    const mergedAt = T0 - MIN;
    w.prs.set(3, handOpened({ mergedAt, updatedAt: mergedAt }));
    await w.sync();

    const vpn4 = w.tasks.get('vpn-4')!;
    expect(vpn4.landedAt).toBe(mergedAt);
    expect(restingStatus(vpn4)).toBe('in-progress');
    expect(w.started).toEqual(['vpn-13']);
  });
});
