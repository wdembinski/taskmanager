import { describe, expect, it } from 'vitest';
import {
  approvalSummary,
  mrApprovalState,
  mrAttentionReason,
  mrIsSettled,
  mrNeedsAttention,
  mrReadyToMerge,
  mrVerdict,
  verdictSummary,
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
        mrNeedsAttention(
          mr({ state, latestNoteAt: 200, pipelineStatus: 'failed', lastEventAt: 200 }),
        ),
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

  // "0/0 approved" reads as a satisfied bar; what it means is that there is no bar and
  // nobody has looked.
  it('does not report a rule-less, unreviewed MR as "0/0 approved"', () => {
    expect(approvalSummary(mr({ approvalsRequired: 0, approvalsGiven: 0 }))).toBe(
      'no approval required',
    );
    expect(approvalSummary(mr({ approvalsRequired: 0, approvalsGiven: 1 }))).toBe('1/0 approved');
  });
});

describe('mrApprovalState', () => {
  it('is approved only when a human actually approved AND the bar is met', () => {
    expect(mrApprovalState(mr({ approvalsRequired: 2, approvalsGiven: 2 }))).toBe('approved');
    expect(mrApprovalState(mr({ approvalsRequired: 0, approvalsGiven: 1 }))).toBe('approved');
  });

  /**
   * The bug this exists for: `approvalsGiven >= approvalsRequired` is `0 >= 0` on a project
   * with no approval rule, so every green MR wore a solid "approved" tick nobody had given.
   * Nothing is blocking the merge — that is a different fact, and gets a different glyph.
   */
  it('separates "nobody objected" from "somebody approved"', () => {
    expect(mrApprovalState(mr({ approvalsRequired: 0, approvalsGiven: 0 }))).toBe('unopposed');
  });

  it('is awaiting while the bar is unmet, or unknowable', () => {
    expect(mrApprovalState(mr({ approvalsRequired: 2, approvalsGiven: 1 }))).toBe('awaiting');
    expect(mrApprovalState(mr({ approvalsRequired: null, approvalsGiven: 3 }))).toBe('awaiting');
  });

  // An objection outranks a tick: an MR can satisfy its bar and still have a reviewer
  // asking for changes, and the green would bury it.
  it('lets a requested change outrank a met approval bar', () => {
    expect(
      mrApprovalState(mr({ approvalsRequired: 1, approvalsGiven: 1, changesRequested: true })),
    ).toBe('changes-requested');
  });

  it('agrees with mrReadyToMerge about what "approved" means', () => {
    const green = { pipelineStatus: 'success', state: 'opened', draft: false } as const;
    for (const [required, given] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [2, 1],
      [2, 2],
    ] as const) {
      const subject = mr({ ...green, approvalsRequired: required, approvalsGiven: given });
      expect(mrReadyToMerge(subject)).toBe(mrApprovalState(subject) === 'approved');
    }
  });
});

describe('mrVerdict / mrIsSettled / verdictSummary', () => {
  it('reports how an MR ENDED, in preference to how its review was going', () => {
    // "2/2 approved" on something that landed last Tuesday describes a queue nobody is
    // standing in any more — and it was the tick the card kept wearing right up until the
    // next sync deleted the row out from under it.
    const approved = { approvalsRequired: 2, approvalsGiven: 2 };
    expect(mrVerdict(mr({ ...approved, state: 'merged' }))).toBe('merged');
    expect(mrVerdict(mr({ ...approved, state: 'closed' }))).toBe('closed');
  });

  it('outranks even an objection once the MR has landed', () => {
    expect(mrVerdict(mr({ state: 'merged', changesRequested: true }))).toBe('merged');
  });

  it('falls through to the review state while the MR is open', () => {
    const open = mr({ approvalsRequired: 2, approvalsGiven: 2 });
    expect(mrVerdict(open)).toBe(mrApprovalState(open));
  });

  it('counts merged and closed as settled — and a locked MR as still open', () => {
    expect(mrIsSettled(mr({ state: 'merged' }))).toBe(true);
    expect(mrIsSettled(mr({ state: 'closed' }))).toBe(true);
    expect(mrIsSettled(mr({ state: 'opened' }))).toBe(false);
    // Locked is frozen, not finished: it still wants a human.
    expect(mrIsSettled(mr({ state: 'locked' }))).toBe(false);
  });

  it('says how it ended in words, so the glyph and its tooltip cannot disagree', () => {
    expect(verdictSummary(mr({ state: 'merged' }))).toBe('merged');
    expect(verdictSummary(mr({ state: 'closed' }))).toBe('closed without merging');
    expect(verdictSummary(mr({ changesRequested: true }))).toBe('changes requested');
    expect(verdictSummary(mr({ approvalsRequired: 2, approvalsGiven: 1 }))).toBe('1/2 approved');
  });
});
