/**
 * What a GitHub sync is allowed to CHANGE about a pull request, and what it must leave
 * alone — the same distinction `gitlab/describeMergeRequest.test.ts` draws, because it is
 * the same rule: an answer from the forge replaces what we stored, silence keeps it.
 */
import { describe, expect, it, vi } from 'vitest';
import { describePullRequest, foldReviews, repoRefFromApiUrl } from './describePullRequest';
import { GitHubError } from './githubClient';
import type {
  GitHubCheckRun,
  GitHubClient,
  GitHubCombinedStatus,
  GitHubPullRequest,
  GitHubReview,
  GitHubSearchIssueItem,
} from './githubClient';
import type { MergeRequest } from '@shared/mergeRequest';

const listed = (over: Partial<GitHubSearchIssueItem> = {}): GitHubSearchIssueItem => ({
  id: 900,
  number: 7,
  title: 'Add the thing',
  body: 'closes ACME-12',
  state: 'open',
  html_url: 'https://github.com/acme/web/pull/7',
  repository_url: 'https://api.github.com/repos/acme/web',
  updated_at: '2026-08-11T10:00:00.000Z',
  pull_request: { url: 'https://api.github.com/repos/acme/web/pulls/7' },
  ...over,
});

const detail = (over: Partial<GitHubPullRequest> = {}): GitHubPullRequest => ({
  id: 900,
  number: 7,
  title: 'Add the thing',
  body: 'closes ACME-12',
  state: 'open',
  html_url: 'https://github.com/acme/web/pull/7',
  mergeable: true,
  mergeable_state: 'clean',
  head: { ref: 'feat/thing', sha: 'deadbeef', repo: { id: 42, full_name: 'acme/web' } },
  base: { ref: 'main', repo: { id: 42, full_name: 'acme/web' } },
  ...over,
});

/** A PR we already know about, whose checks went red and grew a stage row. */
const priorRed = (over: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    id: 'gh-42-7',
    repoId: 42,
    projectPath: 'acme/web',
    number: 7,
    sourceBranch: 'feat/thing',
    targetBranch: 'main',
    pipelineStatus: 'failed',
    pipelineStages: [
      { name: 'build', status: 'success' },
      { name: 'test', status: 'failed' },
    ],
    pipelineUrl: 'https://github.com/acme/web/pull/7/checks',
    approvalsRequired: 2,
    approvalsGiven: 1,
    changesRequested: false,
    hasConflicts: false,
    detailedMergeStatus: 'blocked',
    updatedAt: 0,
    ...over,
  }) as MergeRequest;

type Answer<T> = T | 'fail' | GitHubError;

interface ClientStub {
  pull?: Answer<GitHubPullRequest>;
  reviews?: Answer<GitHubReview[]>;
  protection?: Answer<{
    required_pull_request_reviews?: { required_approving_review_count?: number };
  }>;
  checkRuns?: Answer<GitHubCheckRun[]>;
  combined?: Answer<GitHubCombinedStatus>;
}

/** Every call answers independently — the point being that one failing costs only itself. */
function answer<T>(value: Answer<T> | undefined, what: string): Promise<T> {
  if (value === undefined || value === 'fail') return Promise.reject(new Error(`${what} boom`));
  if (value instanceof GitHubError) return Promise.reject(value);
  return Promise.resolve(value);
}

function client(stub: ClientStub = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(() => answer(stub.pull, 'pull')),
    listReviews: vi.fn(() => answer(stub.reviews, 'reviews')),
    getBranchProtection: vi.fn(() => answer(stub.protection, 'protection')),
    listCheckRuns: vi.fn(() => answer(stub.checkRuns, 'check-runs')),
    getCombinedStatus: vi.fn(() => answer(stub.combined, 'status')),
  } as unknown as GitHubClient;
}

const run = (name: string, status: string, conclusion: string | null = null): GitHubCheckRun => ({
  name,
  status,
  conclusion,
});

describe('repoRefFromApiUrl', () => {
  it('recovers the owner and repo a search row only gives as a URL', () => {
    expect(repoRefFromApiUrl('https://api.github.com/repos/acme/web')).toEqual({
      owner: 'acme',
      repo: 'web',
    });
    expect(repoRefFromApiUrl('https://github.acme.internal/api/v3/repos/team/tools/')).toEqual({
      owner: 'team',
      repo: 'tools',
    });
    expect(repoRefFromApiUrl(undefined)).toEqual({ owner: '', repo: '' });
  });
});

describe('foldReviews', () => {
  it('counts the latest verdict per reviewer, not every row in the history', () => {
    expect(
      foldReviews([
        { id: 1, state: 'APPROVED', user: { id: 1 } },
        { id: 2, state: 'CHANGES_REQUESTED', user: { id: 1 } },
        { id: 3, state: 'APPROVED', user: { id: 2 } },
      ]),
    ).toEqual({ approvalsGiven: 1, changesRequested: true });
  });

  /**
   * GitHub's own rule, and the one that would quietly un-approve half a board: leaving a
   * comment does not withdraw an approval, on the PR page or in the merge check.
   */
  it('does not let a COMMENTED review withdraw that reviewer’s approval', () => {
    expect(
      foldReviews([
        { id: 1, state: 'APPROVED', user: { id: 1 } },
        { id: 2, state: 'COMMENTED', user: { id: 1 } },
      ]),
    ).toEqual({ approvalsGiven: 1, changesRequested: false });
  });

  // DISMISSED is the act of taking a review back, so it does supersede — and counts as
  // neither an approval nor an objection.
  it('lets DISMISSED supersede, counting as neither', () => {
    expect(
      foldReviews([
        { id: 1, state: 'APPROVED', user: { id: 1 } },
        { id: 2, state: 'DISMISSED', user: { id: 1 } },
      ]),
    ).toEqual({ approvalsGiven: 0, changesRequested: false });
    expect(foldReviews([{ id: 1, state: 'PENDING', user: { id: 1 } }])).toEqual({
      approvalsGiven: 0,
      changesRequested: false,
    });
  });
});

describe('describePullRequest — a full read', () => {
  it('fills the row in from the detail, the reviews, the bar and the checks', async () => {
    const result = await describePullRequest(
      client({
        pull: detail(),
        reviews: [{ id: 1, state: 'APPROVED', user: { id: 5 } }],
        protection: { required_pull_request_reviews: { required_approving_review_count: 2 } },
        checkRuns: [run('build', 'completed', 'success'), run('test (20)', 'in_progress')],
      }),
      listed(),
      { stale: true },
    );

    expect(result).toMatchObject({
      repoId: 42,
      number: 7,
      projectPath: 'acme/web',
      sourceBranch: 'feat/thing',
      targetBranch: 'main',
      state: 'opened',
      pipelineStatus: 'running',
      pipelineStages: [
        { name: 'build', status: 'success' },
        { name: 'test', status: 'running' },
      ],
      pipelineUrl: 'https://github.com/acme/web/pull/7/checks',
      approvalsRequired: 2,
      approvalsGiven: 1,
      changesRequested: false,
      detailedMergeStatus: 'clean',
      hasConflicts: false,
      updatedAt: Date.parse('2026-08-11T10:00:00.000Z'),
    });
    // The discussion is a separate endpoint and a separate decision; undefined means the
    // reconciler keeps whatever it knew rather than reading "no comments".
    expect(result.notes).toBeUndefined();
  });

  it('reads a landed PR as merged rather than merely closed', async () => {
    const result = await describePullRequest(
      client({
        pull: detail({ state: 'closed', merged: true, merged_at: '2026-08-11T11:00:00Z' }),
      }),
      listed(),
      { stale: true, prior: priorRed() },
    );
    expect(result.state).toBe('merged');
  });
});

describe('describePullRequest — only re-read what moved', () => {
  it('spends no requests at all on a PR that has not moved', async () => {
    const stub = client();
    const result = await describePullRequest(stub, listed(), { stale: false, prior: priorRed() });

    expect(stub.getPullRequest).not.toHaveBeenCalled();
    expect(stub.listCheckRuns).not.toHaveBeenCalled();
    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
    expect(result.approvalsRequired).toBe(2);
    // Branches live only on the detail, so a row that was not re-read keeps the ones it had
    // — blanking `sourceBranch` would take the ticket key discovered from it with them.
    expect(result.sourceBranch).toBe('feat/thing');
  });

  it('keeps what it knew when the detail call itself failed', async () => {
    const result = await describePullRequest(client({ pull: 'fail', reviews: [] }), listed(), {
      stale: true,
      prior: priorRed(),
    });

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
    expect(result.hasConflicts).toBe(false);
    expect(result.sourceBranch).toBe('feat/thing');
    // Never read this time — the reconciler turns null into "keep what we knew", which is
    // not the same as "nothing is blocking it".
    expect(result.detailedMergeStatus).toBeNull();
  });
});

describe('describePullRequest — degrade rather than guess', () => {
  /**
   * The identical degradation to GitLab's tier-gated `/approvals`: `…/protection` is
   * admin-only, so a 403 is the ordinary case on any repo you merely contribute to. `0`
   * would render as "no approval required" over a repo that requires two.
   */
  it('leaves the approval bar unknown when branch protection refuses', async () => {
    const result = await describePullRequest(
      client({
        pull: detail(),
        reviews: [],
        protection: new GitHubError('GitHub 403 Forbidden', 403),
        checkRuns: [],
        combined: { statuses: [] },
      }),
      listed(),
      { stale: true },
    );

    expect(result.approvalsRequired).toBeNull();
  });

  // A 404 is a real answer: this branch has no protection rule, so it requires nothing.
  it('reads a 404 as an unprotected branch — zero required', async () => {
    const result = await describePullRequest(
      client({
        pull: detail(),
        reviews: [],
        protection: new GitHubError('GitHub 404 Not Found', 404),
        checkRuns: [],
        combined: { statuses: [] },
      }),
      listed(),
      { stale: true },
    );

    expect(result.approvalsRequired).toBe(0);
  });

  it('takes zero from a branch protected without a review requirement', async () => {
    const result = await describePullRequest(
      client({ pull: detail(), reviews: [], protection: {}, checkRuns: [], combined: {} }),
      listed(),
      { stale: true },
    );
    expect(result.approvalsRequired).toBe(0);
  });

  it('keeps the stages when the check-runs endpoint refuses', async () => {
    const result = await describePullRequest(
      client({ pull: detail(), reviews: [], checkRuns: 'fail' }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
  });

  /**
   * The GitHub spelling of the deleted-pipeline bug: remove the workflow file, push, and
   * the new head commit genuinely has no CI. Both systems answered and both were empty, so
   * the previous commit's red has to go.
   */
  it('clears the row when both CI systems answer with nothing', async () => {
    const result = await describePullRequest(
      client({ pull: detail(), reviews: [], checkRuns: [], combined: { statuses: [] } }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('unknown');
    expect(result.pipelineStages).toEqual([]);
    expect(result.pipelineUrl).toBeNull();
  });

  // ...but only when BOTH answered. A statuses call that threw is silence, not an answer.
  it('keeps the row when the check runs are empty and the statuses call throws', async () => {
    const result = await describePullRequest(
      client({ pull: detail(), reviews: [], checkRuns: [], combined: 'fail' }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
  });
});

describe('describePullRequest — the other CI system', () => {
  it('falls back to legacy commit statuses when a repo has no check runs', async () => {
    const result = await describePullRequest(
      client({
        pull: detail(),
        reviews: [],
        checkRuns: [],
        combined: {
          state: 'failure',
          total_count: 2,
          statuses: [
            { context: 'ci/jenkins', state: 'failure', target_url: 'https://jenkins/job/7' },
            { context: 'ci/coverage', state: 'success' },
          ],
        },
      }),
      listed(),
      { stale: true },
    );

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toEqual([
      { name: 'ci/jenkins', status: 'failed' },
      { name: 'ci/coverage', status: 'success' },
    ]);
    expect(result.pipelineUrl).toBe('https://jenkins/job/7');
  });
});

describe('describePullRequest — mergeability', () => {
  it('reads mergeable === false as a conflict', async () => {
    const result = await describePullRequest(
      client({ pull: detail({ mergeable: false, mergeable_state: 'dirty' }), reviews: [] }),
      listed(),
      { stale: true },
    );

    expect(result.hasConflicts).toBe(true);
    expect(result.detailedMergeStatus).toBe('dirty');
  });

  /**
   * `null` is GitHub still computing it — which arrives as `mergeable_state: 'unknown'` and
   * means *checking*, not clean. Calling it a conflict would put a red X on every PR
   * fetched within a second of being opened.
   */
  it('does not call a mergeability job that has not finished a conflict', async () => {
    const result = await describePullRequest(
      client({ pull: detail({ mergeable: null, mergeable_state: 'unknown' }), reviews: [] }),
      listed(),
      { stale: true },
    );

    expect(result.hasConflicts).toBe(false);
    expect(result.detailedMergeStatus).toBe('unknown');
  });
});
