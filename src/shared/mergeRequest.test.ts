import { describe, expect, it } from 'vitest';
import {
  approvalSummary,
  mrAttentionReason,
  mrNeedsAttention,
  mrReadyToMerge,
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
  displayName: null,
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

describe('mrReadyToMerge', () => {
  /** Green and fully approved — the state where the MR is waiting on you specifically. */
  const ready = (over: Partial<MergeRequest> = {}): MergeRequest =>
    mr({ pipelineStatus: 'success', approvalsRequired: 1, approvalsGiven: 1, ...over });

  it('is true for a green, approved, open, non-draft MR', () => {
    expect(mrReadyToMerge(ready())).toBe(true);
  });

  it('is false while the approvals bar is unmet', () => {
    expect(mrReadyToMerge(ready({ approvalsRequired: 2, approvalsGiven: 1 }))).toBe(false);
  });

  // The instance would not say what the bar is (/approvals is tier-gated). Someone
  // approving against an unknown bar is not evidence the bar is met.
  it('refuses to guess when the approvals requirement is unknown', () => {
    expect(mrReadyToMerge(ready({ approvalsRequired: null, approvalsGiven: 3 }))).toBe(false);
  });

  // Otherwise every green MR on a repo with no approval rule would claim to be approved.
  it('does not treat "zero approvals required" as approved when nobody approved', () => {
    expect(mrReadyToMerge(ready({ approvalsRequired: 0, approvalsGiven: 0 }))).toBe(false);
    expect(mrReadyToMerge(ready({ approvalsRequired: 0, approvalsGiven: 1 }))).toBe(true);
  });

  it.each(['running', 'failed', 'canceled', 'skipped', 'manual', 'pending', 'unknown'] as const)(
    'is false when the pipeline is %s rather than passed',
    (pipelineStatus) => {
      expect(mrReadyToMerge(ready({ pipelineStatus }))).toBe(false);
    },
  );

  it('is false for a draft, a closed MR, or one with changes requested', () => {
    expect(mrReadyToMerge(ready({ draft: true }))).toBe(false);
    expect(mrReadyToMerge(ready({ state: 'merged' }))).toBe(false);
    expect(mrReadyToMerge(ready({ changesRequested: true }))).toBe(false);
  });
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

  it('shouts when an MR becomes ready to merge, and stops once acknowledged', () => {
    const readyMr = mr({ approvalsGiven: 2, approvalsRequired: 2, lastEventAt: 200 });
    expect(mrNeedsAttention(readyMr)).toBe(true);
    expect(mrAttentionReason(readyMr)).toContain('ready to merge');
    expect(mrNeedsAttention({ ...readyMr, lastEventSeenAt: 200 })).toBe(false);
  });

  // Good news is still news, but only once. Without an unseen event a steadily green and
  // approved MR would wear the ring until somebody merged it.
  it('stays quiet about an MR that has been ready all along', () => {
    expect(mrNeedsAttention(mr({ approvalsGiven: 2, approvalsRequired: 2 }))).toBe(false);
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
