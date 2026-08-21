/**
 * What a GitHub sync is allowed to CHANGE about a pull request, and what it must leave
 * alone — the same distinction `gitlab/describeMergeRequest.test.ts` draws, because it is
 * the same rule: an answer from the forge replaces what we stored, silence keeps it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describePullRequest,
  foldNotes,
  foldReviews,
  repoRefFromApiUrl,
} from './describePullRequest';
import { GitHubError } from './githubClient';
import type {
  GitHubCheckRun,
  GitHubClient,
  GitHubCombinedStatus,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubReview,
  GitHubReviewComment,
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
  issueComments?: Answer<GitHubIssueComment[]>;
  reviewComments?: Answer<GitHubReviewComment[]>;
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
    listIssueComments: vi.fn(() => answer(stub.issueComments, 'issue comments')),
    listReviewComments: vi.fn(() => answer(stub.reviewComments, 'review comments')),
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

describe('foldNotes', () => {
  const comment = (at: string, id: number): GitHubIssueComment => ({
    id,
    body: 'have a look at this',
    created_at: at,
    user: { id, login: `dev${id}` },
  });

  /**
   * The point of the whole step: GitHub scatters a discussion across three endpoints, and the
   * one whose name says "comments" is the one a reviewed PR uses least.
   */
  it('folds the conversation, the diff remarks and the review bodies into one list', () => {
    expect(
      foldNotes(
        [comment('2026-08-01T10:00:00Z', 1)],
        [{ ...comment('2026-08-02T10:00:00Z', 2), path: 'src/app.ts', line: 12 }],
        [
          {
            id: 5,
            state: 'CHANGES_REQUESTED',
            body: 'two nits',
            submitted_at: '2026-08-03T10:00:00Z',
            user: { id: 3, login: 'dev3' },
          },
        ],
      ),
    ).toEqual([
      { createdAt: '2026-08-01T10:00:00Z', author: { id: 1, login: 'dev1' } },
      { createdAt: '2026-08-02T10:00:00Z', author: { id: 2, login: 'dev2' } },
      { createdAt: '2026-08-03T10:00:00Z', author: { id: 3, login: 'dev3' } },
    ]);
  });

  /**
   * A bare approval is a verdict, not a remark — and the reconciler already raises it as
   * `becameReady`. Counting it twice would ring a PR that was approved in silence, and
   * "Mark seen" would only clear one of the two signals.
   */
  it('does not treat a review with nothing written in it as something said', () => {
    expect(
      foldNotes(
        [],
        [],
        [
          { id: 1, state: 'APPROVED', body: '', submitted_at: '2026-08-03T10:00:00Z' },
          { id: 2, state: 'APPROVED', body: '   ', submitted_at: '2026-08-04T10:00:00Z' },
          { id: 3, state: 'APPROVED', submitted_at: '2026-08-05T10:00:00Z' },
        ],
      ),
    ).toEqual([]);
  });

  // PENDING: a draft review only its author can see, and it has no `submitted_at` at all.
  it('leaves an unsubmitted draft review out', () => {
    expect(
      foldNotes([], [], [{ id: 1, state: 'PENDING', body: 'wip', submitted_at: null }]),
    ).toEqual([]);
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
    // Both comment endpoints were left unstubbed here, so both threw and the one review has
    // no body: an EMPTY list, which the reconciler reads as "nothing newer" — never as a
    // reason to forget a comment it already recorded.
    expect(result.notes).toEqual([]);
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

describe('describePullRequest — the discussion', () => {
  it('reads all three sources and hands them over as notes', async () => {
    const stub = client({
      pull: detail(),
      reviews: [
        {
          id: 5,
          state: 'APPROVED',
          body: 'ship it',
          submitted_at: '2026-08-03T10:00:00Z',
          user: { id: 3 },
        },
      ],
      issueComments: [{ id: 1, created_at: '2026-08-01T10:00:00Z', user: { id: 1 } }],
      reviewComments: [{ id: 2, created_at: '2026-08-02T10:00:00Z', user: { id: 2 } }],
      protection: {},
      checkRuns: [],
      combined: {},
    });
    const result = await describePullRequest(stub, listed(), { stale: true });

    expect(stub.listIssueComments).toHaveBeenCalledWith('acme', 'web', 7);
    expect(stub.listReviewComments).toHaveBeenCalledWith('acme', 'web', 7);
    expect(result.notes?.map((n) => n.createdAt)).toEqual([
      '2026-08-01T10:00:00Z',
      '2026-08-02T10:00:00Z',
      '2026-08-03T10:00:00Z',
    ]);
    // The reviews are the ones already fetched for the approval count — the body and the
    // verdict come off the same rows, so the discussion costs no extra call.
    expect(stub.listReviews).toHaveBeenCalledTimes(1);
  });

  /**
   * One failing endpoint costs only itself, as everywhere else in this file — and the worst
   * case is an empty list, which the reconciler reads as "nothing newer" rather than as a
   * reason to forget a comment it already knew about.
   */
  it('keeps the comments it did manage to read when one endpoint refuses', async () => {
    const result = await describePullRequest(
      client({
        pull: detail(),
        reviews: [],
        issueComments: 'fail',
        reviewComments: [{ id: 2, created_at: '2026-08-02T10:00:00Z', user: { id: 2 } }],
      }),
      listed(),
      { stale: true },
    );

    expect(result.notes).toEqual([{ createdAt: '2026-08-02T10:00:00Z', author: { id: 2 } }]);
  });
});

describe('describePullRequest — only re-read what moved', () => {
  it('spends no requests at all on a PR that has not moved', async () => {
    const stub = client();
    const result = await describePullRequest(stub, listed(), { stale: false, prior: priorRed() });

    expect(stub.getPullRequest).not.toHaveBeenCalled();
    expect(stub.listCheckRuns).not.toHaveBeenCalled();
    // Undefined, not empty: a PR nobody touched has a discussion we did not look at, and the
    // reconciler must keep the note time it already holds.
    expect(stub.listIssueComments).not.toHaveBeenCalled();
    expect(result.notes).toBeUndefined();
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

    expect(result.pipelineStatus).toBe('none');
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

  it('reports a check-runs throw through onCiRefusal', async () => {
    const onCiRefusal = vi.fn();
    const boom = new GitHubError('GitHub 403 Forbidden', 403);
    await describePullRequest(
      client({ pull: detail(), reviews: [], checkRuns: boom, combined: { statuses: [] } }),
      listed(),
      { stale: true, prior: priorRed(), onCiRefusal },
    );

    expect(onCiRefusal).toHaveBeenCalledWith('check-runs', boom);
    expect(onCiRefusal).toHaveBeenCalledTimes(1);
  });

  it('reports a commit-status throw through onCiRefusal', async () => {
    const onCiRefusal = vi.fn();
    const boom = new GitHubError('GitHub 403 Forbidden', 403);
    await describePullRequest(
      client({ pull: detail(), reviews: [], checkRuns: [], combined: boom }),
      listed(),
      { stale: true, prior: priorRed(), onCiRefusal },
    );

    expect(onCiRefusal).toHaveBeenCalledWith('commit-status', boom);
    expect(onCiRefusal).toHaveBeenCalledTimes(1);
  });

  it('does not call onCiRefusal when both CI systems answer', async () => {
    const onCiRefusal = vi.fn();
    await describePullRequest(
      client({ pull: detail(), reviews: [], checkRuns: [], combined: { statuses: [] } }),
      listed(),
      { stale: true, prior: priorRed(), onCiRefusal },
    );
    await describePullRequest(
      client({
        pull: detail(),
        reviews: [],
        checkRuns: [run('build', 'completed', 'success')],
        combined: { statuses: [] },
      }),
      listed(),
      { stale: true, prior: priorRed(), onCiRefusal },
    );

    expect(onCiRefusal).not.toHaveBeenCalled();
  });
});

describe('describePullRequest — a settled PR read back after it merged', () => {
  /**
   * The reported bug, GitHub's half: the PR merged while a check was still `in_progress`,
   * and the "read back a settled PR" pass in `ipc.ts` calls this with `stale: false` —
   * nothing about approvals or notes can move once it has landed. But it hands `detail`
   * straight through, and the checks must still be read off it or the stage row freezes on
   * whatever the last poll caught mid-run — the same bug GitLab's half never had, since its
   * overall status already reads off `head_pipeline` unconditionally.
   */
  it('reads the checks when detail is handed in, even though stale is false', async () => {
    const stub = client({
      checkRuns: [run('build', 'completed', 'success'), run('test', 'completed', 'success')],
    });
    const result = await describePullRequest(stub, listed(), {
      stale: false,
      prior: priorRed({ pipelineStatus: 'running' }),
      detail: detail({ state: 'closed', merged: true, merged_at: '2026-08-11T11:00:00Z' }),
    });

    // Nothing about approvals or notes can move on a landed PR, so those calls are still
    // skipped — only the checks read decouples from `stale`.
    expect(stub.getPullRequest).not.toHaveBeenCalled();
    expect(stub.listReviews).not.toHaveBeenCalled();
    expect(result.pipelineStatus).toBe('success');
    expect(result.pipelineStages).toEqual([
      { name: 'build', status: 'success' },
      { name: 'test', status: 'success' },
    ]);
  });

  // Without a `detail` to read a head SHA off, there is nothing to check CI against — the
  // ordinary "not worth re-reading" case keeps costing nothing at all.
  it('reads no checks when the caller has no detail to hand in', async () => {
    const stub = client();
    const result = await describePullRequest(stub, listed(), {
      stale: false,
      prior: priorRed(),
    });

    expect(stub.listCheckRuns).not.toHaveBeenCalled();
    expect(result.pipelineStatus).toBe('failed');
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
