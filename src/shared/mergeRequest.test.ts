import { describe, expect, it } from 'vitest';
import {
  approvalSummary,
  mrAttentionReason,
  mrNeedsAttention,
  type MergeRequest,
} from './mergeRequest';

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  id: 'gl-9-1',
  taskId: 't1',
  provider: 'gitlab',
  gitlabProjectId: 9,
  projectPath: 'acme/web',
  iid: 1,
  title: 'ENG-1 fix the thing',
  webUrl: 'https://gitlab.com/acme/web/-/merge_requests/1',
  sourceBranch: 'feature/ENG-1',
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  pipelineStatus: 'success',
  pipelineStages: [],
  pipelineUrl: null,
  approvalsRequired: 2,
  approvalsGiven: 1,
  changesRequested: false,
  issueKeys: ['ENG-1'],
  latestNoteAt: null,
  lastReadAt: null,
  lastEventAt: null,
  lastEventSeenAt: null,
  updatedAt: 100,
  syncedAt: 100,
  ...over,
});

describe('mrNeedsAttention', () => {
  it('is quiet for a healthy, read MR', () => {
    expect(mrNeedsAttention(mr())).toBe(false);
  });

  it('shouts about an unread note, and stops once it is read', () => {
    expect(mrNeedsAttention(mr({ latestNoteAt: 200 }))).toBe(true);
    expect(mrNeedsAttention(mr({ latestNoteAt: 200, lastReadAt: 200 }))).toBe(false);
    expect(mrNeedsAttention(mr({ latestNoteAt: 200, lastReadAt: 300 }))).toBe(false);
  });

  it('shouts about a failed or cancelled pipeline until the event is seen', () => {
    for (const status of ['failed', 'canceled'] as const) {
      expect(mrNeedsAttention(mr({ pipelineStatus: status, lastEventAt: 200 }))).toBe(true);
      expect(
        mrNeedsAttention(mr({ pipelineStatus: status, lastEventAt: 200, lastEventSeenAt: 200 })),
      ).toBe(false);
    }
  });

  it('ignores a pipeline that is merely in flight', () => {
    for (const status of ['running', 'pending', 'manual', 'skipped'] as const) {
      expect(mrNeedsAttention(mr({ pipelineStatus: status, lastEventAt: 200 }))).toBe(false);
    }
  });

  it('shouts about changes requested', () => {
    expect(mrNeedsAttention(mr({ changesRequested: true, lastEventAt: 200 }))).toBe(true);
  });

  it('keeps the two markers independent — clearing one must not silence the other', () => {
    // Read the discussion, but the red pipeline has not been acknowledged.
    const seenNotes = mr({
      latestNoteAt: 200,
      lastReadAt: 200,
      pipelineStatus: 'failed',
      lastEventAt: 210,
    });
    expect(mrNeedsAttention(seenNotes)).toBe(true);

    // Acknowledged the pipeline, then someone commented.
    const seenEvent = mr({
      pipelineStatus: 'failed',
      lastEventAt: 200,
      lastEventSeenAt: 200,
      latestNoteAt: 210,
    });
    expect(mrNeedsAttention(seenEvent)).toBe(true);
  });

  it('never shouts about an MR that is no longer open', () => {
    for (const state of ['merged', 'closed', 'locked'] as const) {
      expect(
        mrNeedsAttention(mr({ state, latestNoteAt: 200, pipelineStatus: 'failed', lastEventAt: 200 })),
      ).toBe(false);
    }
  });
});

describe('mrAttentionReason', () => {
  it('is null when nothing is wrong', () => {
    expect(mrAttentionReason(mr())).toBeNull();
  });

  it('names every live reason at once', () => {
    const noisy = mr({
      latestNoteAt: 200,
      pipelineStatus: 'failed',
      changesRequested: true,
      lastEventAt: 200,
    });
    const reason = mrAttentionReason(noisy);
    expect(reason).toContain('!1');
    expect(reason).toContain('new comments');
    expect(reason).toContain('the pipeline failed');
    expect(reason).toContain('changes were requested');
  });
});

describe('approvalSummary', () => {
  it('counts approvals when the instance told us the requirement', () => {
    expect(approvalSummary(mr({ approvalsGiven: 2, approvalsRequired: 3 }))).toBe('2/3 approved');
  });

  it('says so rather than claiming a confident 0/0 when it did not', () => {
    // `/approvals` is tier-gated and 403s on some instances.
    expect(approvalSummary(mr({ approvalsRequired: null }))).toBe('approvals unknown');
  });
});
