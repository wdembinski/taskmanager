/**
 * What a sync is allowed to CHANGE about an MR, and what it must leave alone.
 *
 * The distinction under test throughout: an answer from GitLab replaces what we stored,
 * silence keeps it. Getting those two confused is what left a deleted pipeline on a card
 * forever — see `noPipeline` in `describeMergeRequest.ts`.
 */
import { describe, expect, it } from 'vitest';
import { describeMergeRequest } from './describeMergeRequest';
import type { GitLabClient, GitLabJob, GitLabMergeRequest } from './gitlabClient';
import type { MergeRequest } from '@shared/mergeRequest';

const listed = (over: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest =>
  ({
    id: 1,
    iid: 7,
    project_id: 9,
    title: 'Add the thing',
    web_url: 'https://gl/acme/web/-/merge_requests/7',
    source_branch: 'feat/thing',
    target_branch: 'main',
    state: 'opened',
    updated_at: '2026-07-30T10:00:00.000Z',
    references: { full: 'acme/web!7' },
    ...over,
  }) as GitLabMergeRequest;

/** An MR we already know about, whose pipeline went red and grew stages. */
const priorRed = (over: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    id: 'gl-9-7',
    pipelineStatus: 'failed',
    pipelineStages: [
      { name: 'build', status: 'success' },
      { name: 'test', status: 'failed' },
    ],
    pipelineUrl: 'https://gl/acme/web/-/pipelines/111',
    approvalsRequired: 1,
    approvalsGiven: 0,
    changesRequested: false,
    updatedAt: 0,
    ...over,
  }) as MergeRequest;

interface ClientStub {
  detail?: GitLabMergeRequest | 'fail';
  jobs?: GitLabJob[] | 'fail';
}

function client({ detail, jobs }: ClientStub = {}): GitLabClient {
  return {
    getMergeRequest: async () => {
      if (detail === 'fail' || detail === undefined) throw new Error('boom');
      return detail;
    },
    getApprovals: async () => {
      throw new Error('tier-gated');
    },
    getReviewers: async () => [],
    listNotes: async () => [],
    listPipelineJobs: async () => {
      if (jobs === 'fail' || jobs === undefined) throw new Error('403');
      return jobs;
    },
  } as unknown as GitLabClient;
}

// GitLab has no stage endpoint, so `stagesFromJobs` recovers run order by REVERSING the
// job list, which `/jobs` returns newest-first. These fixtures are therefore written in
// the order the real endpoint would return them: last stage first.
const job = (stage: string, status: string): GitLabJob =>
  ({ id: 1, name: `${stage}-job`, stage, status }) as unknown as GitLabJob;

describe('describeMergeRequest — a pipeline that no longer exists', () => {
  /**
   * The reported bug: `.gitlab-ci.yml` was deleted and pushed, so the new head commit has
   * no pipeline and the detail endpoint answers `head_pipeline: null`. The card went on
   * showing the failed pipeline of the commit before it.
   */
  it('clears status, stages and url when the detail endpoint says there is no pipeline', async () => {
    const result = await describeMergeRequest(
      client({ detail: listed({ head_pipeline: null }) }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('unknown');
    expect(result.pipelineStages).toEqual([]);
    expect(result.pipelineUrl).toBeNull();
  });

  /**
   * The lie the original guard existed to prevent, and which must stay prevented: the LIST
   * endpoint omits `head_pipeline` entirely, and that silence is not a claim that the
   * pipeline is gone.
   */
  it('keeps what it knew when the field is merely absent rather than null', async () => {
    const bare = listed();
    delete (bare as unknown as Record<string, unknown>).head_pipeline;

    const result = await describeMergeRequest(client({ detail: bare }), bare, {
      stale: true,
      prior: priorRed(),
    });

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
    expect(result.pipelineUrl).toBe('https://gl/acme/web/-/pipelines/111');
  });

  // A detail call that never landed cannot be evidence of anything.
  it('keeps what it knew when the detail call itself failed', async () => {
    const result = await describeMergeRequest(client({ detail: 'fail' }), listed(), {
      stale: true,
      prior: priorRed(),
    });

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
  });

  // `stale: false` means we deliberately did not look. Nothing read, nothing changed.
  it('keeps what it knew when the MR was not worth re-reading', async () => {
    const result = await describeMergeRequest(client(), listed(), {
      stale: false,
      prior: priorRed(),
    });

    expect(result.pipelineStatus).toBe('failed');
    expect(result.pipelineStages).toHaveLength(2);
  });
});

describe('describeMergeRequest — stages of a pipeline that moved on', () => {
  it('replaces the stages of the previous pipeline with the new one', async () => {
    const result = await describeMergeRequest(
      client({
        detail: listed({ head_pipeline: { id: 222, status: 'running' } }),
        jobs: [job('deploy', 'running'), job('lint', 'success')],
      }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('running');
    expect(result.pipelineStages).toEqual([
      { name: 'lint', status: 'success' },
      { name: 'deploy', status: 'running' },
    ]);
  });

  /**
   * A fresh pipeline whose jobs do not exist yet answers with an empty list. That is an
   * answer — showing the PREVIOUS pipeline's stages against it is the same staleness as
   * the deleted-pipeline bug, in a smaller window.
   */
  it('empties the stages when the jobs call succeeds with nothing', async () => {
    const result = await describeMergeRequest(
      client({ detail: listed({ head_pipeline: { id: 222, status: 'created' } }), jobs: [] }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('created');
    expect(result.pipelineStages).toEqual([]);
  });

  // ...but a 403 is silence, not an answer: the jobs endpoint is permission-gated, and
  // blanking the row would look like a pipeline that lost its stages.
  it('keeps the stages when the jobs endpoint refuses', async () => {
    const result = await describeMergeRequest(
      client({ detail: listed({ head_pipeline: { id: 222, status: 'running' } }), jobs: 'fail' }),
      listed(),
      { stale: true, prior: priorRed() },
    );

    expect(result.pipelineStatus).toBe('running');
    expect(result.pipelineStages).toHaveLength(2);
  });
});
