import { describe, expect, it } from 'vitest';
import {
  approvalSummary,
  detailedMergeBlocker,
  mrAbbrev,
  mergeBlockerLabel,
  mergeBlockers,
  mrApprovalState,
  mrAttentionReason,
  mrHeading,
  mrIsSettled,
  mrNeedsAttention,
  mrNoun,
  mrReadyToMerge,
  mrRef,
  mrVerdict,
  verdictSummary,
  type MergeRequest,
} from './mergeRequest';

const mr = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  id: 'gl-9-1',
  taskId: 't1',
  // Discovered by a sync, like every merge request these predicates are about — the card
  // it remembers only matters where the card is worked out, which is the reconcilers.
  openedForTaskId: null,
  provider: 'gitlab',
  repoId: 9,
  projectPath: 'acme/web',
  number: 1,
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
  // Mergeable by default, so every pre-existing case still describes the MR it always did:
  // the blockers these tests are about come from the fields they set explicitly.
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
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

  it.each(['running', 'failed', 'canceled', 'skipped', 'manual', 'pending', 'unknown', 'none'] as const)(
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

describe('mergeBlockers', () => {
  /** Everything green and approved, and GitLab agrees it can merge. */
  const clear = (over: Partial<MergeRequest> = {}): MergeRequest =>
    mr({ approvalsRequired: 1, approvalsGiven: 1, ...over });

  it('is empty for an MR with nothing left to do', () => {
    expect(mergeBlockers(clear())).toEqual([]);
    expect(mrReadyToMerge(clear())).toBe(true);
  });

  // The bug this exists for: GitLab reported "must not be a draft, fast-forward is not
  // possible, resolve the conflicts" while the app showed the row entirely green. Every one
  // of those is invisible in the MR's own inputs, so the old hand-written conjunction over
  // state/draft/pipeline/approvals could not see any of them.
  it('reports what only GitLab knows: conflicts, a needed rebase, another MR in the way', () => {
    expect(mergeBlockers(clear({ detailedMergeStatus: 'conflict' }))).toContain('conflict');
    expect(mergeBlockers(clear({ detailedMergeStatus: 'need_rebase' }))).toContain('need-rebase');
    expect(mergeBlockers(clear({ detailedMergeStatus: 'blocked_status' }))).toContain(
      'blocked-by-another',
    );
    expect(mergeBlockers(clear({ hasConflicts: true }))).toContain('conflict');
  });

  it('stops calling a blocked MR ready to merge', () => {
    for (const status of [
      'conflict',
      'need_rebase',
      'blocked_status',
      'discussions_not_resolved',
    ]) {
      expect(mrReadyToMerge(clear({ detailedMergeStatus: status }))).toBe(false);
    }
    expect(mrReadyToMerge(clear({ hasConflicts: true }))).toBe(false);
  });

  // Optimism is the failure mode worth engineering against — GitLab keeps adding statuses,
  // and one we have never heard of must not read as "go ahead and merge".
  it('treats an unrecognised GitLab status as blocked, not as mergeable', () => {
    expect(mergeBlockers(clear({ detailedMergeStatus: 'security_policy_violations' }))).toEqual([
      'other',
    ]);
    expect(mrReadyToMerge(clear({ detailedMergeStatus: 'security_policy_violations' }))).toBe(
      false,
    );
  });

  it('distinguishes "still checking" from a real blocker', () => {
    // Not an answer yet. It must still stop the "ready to merge" badge — we do not know that
    // it is ready — but it is not something the human has to go and fix.
    for (const status of ['checking', 'unchecked', 'preparing']) {
      expect(mergeBlockers(clear({ detailedMergeStatus: status }))).toEqual(['checking']);
    }
  });

  // GitLab only enforces CI and approvals when the PROJECT requires them, so a rule-less
  // project answers `mergeable` over a failed pipeline. "Nothing left to do but merge it" is
  // plainly untrue there, so our own two conditions stack on top of GitLab's verdict.
  it('keeps its own pipeline and approval conditions on top of a mergeable verdict', () => {
    expect(mergeBlockers(clear({ pipelineStatus: 'failed' }))).toEqual(['pipeline']);
    expect(mergeBlockers(mr({ approvalsRequired: 2, approvalsGiven: 0 }))).toEqual(['approvals']);
    expect(mergeBlockers(clear({ changesRequested: true }))).toEqual(['changes-requested']);
  });

  it('falls back to what it knows when GitLab would not say', () => {
    // An instance older than 15.6 carries no `detailed_merge_status` at all. The row must not
    // become MORE optimistic for it — draft and conflicts still stand on their own.
    expect(mergeBlockers(clear({ detailedMergeStatus: null, draft: true }))).toEqual(['draft']);
    expect(mergeBlockers(clear({ detailedMergeStatus: null }))).toEqual([]);
  });

  it('lists every reason at once, structural ones first', () => {
    const stuck = clear({
      detailedMergeStatus: 'need_rebase',
      hasConflicts: true,
      draft: true,
      pipelineStatus: 'failed',
    });
    expect(mergeBlockers(stuck)).toEqual(['conflict', 'need-rebase', 'draft', 'pipeline']);
  });

  it('says nothing about a merge request that is over', () => {
    // A merged MR is not "blocked", it is finished — and a closed one is not asking either.
    for (const state of ['merged', 'closed'] as const) {
      expect(mergeBlockers(clear({ state, hasConflicts: true }))).toEqual([]);
    }
  });

  it('sends a structurally blocked MR to the `blocked` verdict, over its approval', () => {
    // The green tick was true about the review and badly misleading about the merge.
    const approvedButStuck = clear({ hasConflicts: true });
    expect(mrApprovalState(approvedButStuck)).toBe('approved');
    expect(mrVerdict(approvedButStuck)).toBe('blocked');
    expect(verdictSummary(approvedButStuck)).toContain('merge conflicts');
  });

  it('leaves the verdict alone for blockers the row already shows another way', () => {
    // A red pipeline has its own dots and a draft its own chip; promoting either to the
    // verdict slot would be the same fact told twice.
    expect(mrVerdict(clear({ pipelineStatus: 'failed' }))).toBe('approved');
    expect(mrVerdict(clear({ draft: true }))).toBe('approved');
  });
});

/**
 * The two places a merge request stops being provider-agnostic — everything above this
 * point asks the same questions of a pull request as of a merge request.
 */
describe('two forges, one merge request', () => {
  /** The same MR, as GitHub would have filed it. */
  const pr = (over: Partial<MergeRequest> = {}): MergeRequest =>
    mr({ provider: 'github', id: 'gh-9-1', detailedMergeStatus: 'clean', ...over });

  it('writes the number the way its own forge writes it', () => {
    // `#12` for a GitLab MR is not a styling slip — over there it means an ISSUE.
    expect(mrRef(mr({ number: 12 }))).toBe('!12');
    expect(mrRef(pr({ number: 12 }))).toBe('#12');
  });

  it('calls the thing what its own forge calls it', () => {
    expect(mrNoun('gitlab')).toBe('merge request');
    expect(mrNoun('github')).toBe('pull request');
  });

  it('abbreviates it from the provider, not from the noun', () => {
    expect(mrAbbrev('gitlab')).toBe('MR');
    expect(mrAbbrev('github')).toBe('PR');
    // The initials are the noun's initials — the two must not drift apart, since a button
    // saying "Create PR" beside a tooltip saying "open a merge request" names two things.
    for (const provider of ['github', 'gitlab'] as const) {
      const initials = mrNoun(provider)
        .split(' ')
        .map((word) => word[0]?.toUpperCase())
        .join('');
      expect(mrAbbrev(provider)).toBe(initials);
    }
  });

  it('heads a list with the forge every row in it came from', () => {
    expect(mrHeading([mr()])).toBe('Merge request');
    expect(mrHeading([mr(), mr({ id: 'gl-9-2' })])).toBe('Merge requests');
    expect(mrHeading([pr()])).toBe('Pull request');
    expect(mrHeading([pr(), pr({ id: 'gh-9-2' })])).toBe('Pull requests');
  });

  it('keeps the model’s own name when the rows disagree about the forge', () => {
    // No word is true of both, so neither forge's is borrowed for the other's rows.
    expect(mrHeading([mr(), pr()])).toBe('Merge requests');
    // And an empty list is nobody's — the callers hide the section, but the answer is
    // still a heading rather than a crash on `mrs[0]`.
    expect(mrHeading([])).toBe('Merge requests');
  });

  it('names the forge that actually refused', () => {
    expect(mergeBlockerLabel('other', 'gitlab')).toBe('blocked by GitLab');
    expect(mergeBlockerLabel('other', 'github')).toBe('blocked by GitHub');
    expect(mergeBlockerLabel('checking', 'github')).toBe('GitHub is still checking');
    // The other eight are facts about the branch and read the same either way.
    expect(mergeBlockerLabel('conflict', 'github')).toBe(mergeBlockerLabel('conflict', 'gitlab'));
  });

  it('carries that name all the way to the sentence on screen', () => {
    const stuck = pr({ detailedMergeStatus: 'dirty', approvalsRequired: 1, approvalsGiven: 1 });
    expect(verdictSummary(stuck)).toContain('merge conflicts');
    expect(verdictSummary(pr({ detailedMergeStatus: 'security_advisory' }))).not.toContain(
      'GitLab',
    );
  });

  // GitHub's `mergeable_state` is a shorter, vaguer vocabulary than GitLab's, and none of
  // its values collide with one — which is why both live in one switch.
  it('reads GitHub mergeable_state as well as GitLab detailed_merge_status', () => {
    expect(detailedMergeBlocker('clean')).toBeNull();
    expect(detailedMergeBlocker('dirty')).toBe('conflict');
    expect(detailedMergeBlocker('behind')).toBe('need-rebase');
    expect(detailedMergeBlocker('unstable')).toBe('pipeline');
    expect(detailedMergeBlocker('draft')).toBe('draft');
    // `blocked` covers a missing review, a branch-protection rule and a required check
    // that never ran — too many things to name one, so the raw string tells the human.
    expect(detailedMergeBlocker('blocked')).toBe('other');
    // Not an answer yet: the mergeability job hasn't finished. Same as GitLab's `checking`.
    expect(detailedMergeBlocker('unknown')).toBe('checking');
  });

  it('still blocks by default on a status neither forge has taught us', () => {
    expect(mergeBlockers(pr({ detailedMergeStatus: 'merge_queue_pending' }))).toContain('other');
    expect(mrReadyToMerge(pr({ detailedMergeStatus: 'merge_queue_pending' }))).toBe(false);
  });

  it('is ready to merge on a clean, approved pull request', () => {
    expect(mrReadyToMerge(pr({ approvalsRequired: 1, approvalsGiven: 1 }))).toBe(true);
  });

  it('puts the pull request reference in the attention tooltip', () => {
    expect(mrAttentionReason(pr({ number: 7, latestNoteAt: 200 }))).toContain('#7');
  });
});
