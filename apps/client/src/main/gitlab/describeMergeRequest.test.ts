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

describe('describeMergeRequest — a settled MR read back after it merged', () => {
  /**
   * The reported bug: the MR merged while its pipeline was still running, and the "read
   * back a settled MR" pass in `ipc.ts` calls this with `stale: false` — nothing about
   * approvals or notes can move once an MR has landed. But the overall status already
   * updates off `head_pipeline` regardless of `stale`, and the stage row has to keep up
   * with it or the last stage the runners were on stays lit "running" forever.
   */
  it('refreshes the stages when the pipeline finished, even though stale is false', async () => {
    // `stale: false` means `describeMergeRequest` never calls `getMergeRequest` itself — the
    // caller (`ipc.ts`'s "read back a settled MR" pass) already fetched the detail and hands
    // it straight in as `listed`, exactly the way it does for real.
    const result = await describeMergeRequest(
      client({ jobs: [job('deploy', 'success'), job('test', 'success'), job('build', 'success')] }),
      listed({ head_pipeline: { id: 222, status: 'success' } }),
      { stale: false, prior: priorRed({ pipelineStatus: 'running' }) },
    );

    expect(result.pipelineStatus).toBe('success');
    expect(result.pipelineStages).toEqual([
      { name: 'build', status: 'success' },
      { name: 'test', status: 'success' },
      { name: 'deploy', status: 'success' },
    ]);
  });

  /**
   * The other half of the same fix: a pipeline that runs AFTER the merge — GitLab's own
   * "merge pipeline" — arrives as a new `head_pipeline` id. The stage row must pick up ITS
   * stages, not keep showing the ones from the pipeline that ran before the merge.
   */
  it('picks up a new pipeline that started after the merge, replacing the old stages', async () => {
    const result = await describeMergeRequest(
      client({ jobs: [job('deploy', 'running'), job('build', 'success')] }),
      listed({ head_pipeline: { id: 333, status: 'running' } }),
      {
        stale: false,
        prior: priorRed({
          pipelineStatus: 'success',
          pipelineStages: [
            { name: 'build', status: 'success' },
            { name: 'test', status: 'success' },
          ],
        }),
      },
    );

    expect(result.pipelineStatus).toBe('running');
    expect(result.pipelineStages).toEqual([
      { name: 'build', status: 'success' },
      { name: 'deploy', status: 'running' },
    ]);
  });

  // A settled MR whose pipeline was already terminal, and stayed that way, needs no
  // further calls — this is the case the `stale: false` skip still has to hold for.
  it('does not refetch the jobs when nothing about the pipeline moved', async () => {
    let jobCalls = 0;
    const stub: GitLabClient = {
      getMergeRequest: async () => listed({ head_pipeline: { id: 111, status: 'success' } }),
      getApprovals: async () => {
        throw new Error('tier-gated');
      },
      getReviewers: async () => [],
      listNotes: async () => [],
      listPipelineJobs: async () => {
        jobCalls += 1;
        return [];
      },
    } as unknown as GitLabClient;

    const result = await describeMergeRequest(
      stub,
      listed({ head_pipeline: { id: 111, status: 'success' } }),
      {
        stale: false,
        prior: priorRed({
          pipelineStatus: 'success',
          pipelineStages: [{ name: 'build', status: 'success' }],
        }),
      },
    );

    expect(jobCalls).toBe(0);
    expect(result.pipelineStages).toEqual([{ name: 'build', status: 'success' }]);
  });
});
