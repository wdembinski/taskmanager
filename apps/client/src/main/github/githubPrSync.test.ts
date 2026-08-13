import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import { mrAttentionReason, mrNeedsAttention } from '@shared/mergeRequest';
// Provider-neutral and shared, deliberately: it reads `state` and `taskId` off a stored row,
// which mean the same thing whichever forge filled them in.
import { landedTaskIds } from '../gitlab/gitlabSync';
import {
  needsDetailRefresh,
  pullRequestId,
  reconcilePullRequests,
  rematchPullRequests,
  type FetchedMergeRequest,
} from './githubPrSync';

const NOW = 1_000;

const fetched = (over: Partial<FetchedMergeRequest> = {}): FetchedMergeRequest => ({
  repoId: 42,
  number: 1,
  projectPath: 'acme/web',
  title: 'Fix the login redirect',
  description: 'Closes #123',
  webUrl: 'https://github.com/acme/web/pull/1',
  sourceBranch: 'wd/login',
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  pipelineStatus: 'success',
  pipelineStages: [],
  pipelineUrl: null,
  approvalsRequired: 2,
  approvalsGiven: 1,
  changesRequested: false,
  detailedMergeStatus: 'clean',
  hasConflicts: false,
  updatedAt: 900,
  ...over,
});

/** You, on the connected instance — the reason your own review is not news. */
const ME = { id: 7, login: 'wd', baseUrl: 'https://api.github.com' };

/** The board: one card mirroring GitHub issue `acme/web#123`, one mirroring a JIRA ticket. */
const opts = {
  knownKeys: ['acme/web#123', 'ENG-1'],
  taskIdByKey: new Map([
    ['acme/web#123', 'task-1'],
    ['ENG-1', 'task-9'],
  ]),
  identity: ME,
  now: NOW,
};

/** A note as `describePullRequest` hands it over — the neutral shape, from any of the three. */
const note = (at: string, authorId: number): { createdAt: string; author: { id: number } } => ({
  createdAt: at,
  author: { id: authorId },
});

describe('needsDetailRefresh', () => {
  const prior = (over: Partial<MergeRequest> = {}): MergeRequest =>
    ({ ...reconcilePullRequests([], [fetched()], opts).upserts[0], ...over }) as MergeRequest;

  it('always reads a pull request it has never seen', () => {
    expect(needsDetailRefresh(undefined, 900)).toBe(true);
  });

  it('reads one whose updated_at moved', () => {
    expect(needsDetailRefresh(prior({ updatedAt: 900 }), 901)).toBe(true);
  });

  // The same trap GitLab has: GitHub does not touch a pull request when its check suite
  // finishes, so `updated_at` alone leaves a PR first seen mid-run reading "running" for
  // good — Sync re-lists it, sees nothing has moved, and keeps the stale status.
  it.each(['created', 'pending', 'running'] as const)(
    're-reads an untouched PR whose checks are still %s',
    (pipelineStatus) => {
      expect(needsDetailRefresh(prior({ updatedAt: 900, pipelineStatus }), 900)).toBe(true);
    },
  );

  it.each(['success', 'failed', 'canceled', 'skipped', 'manual', 'unknown'] as const)(
    'leaves an untouched PR alone once its checks are %s',
    (pipelineStatus) => {
      expect(needsDetailRefresh(prior({ updatedAt: 900, pipelineStatus }), 900)).toBe(false);
    },
  );
});

describe('reconcilePullRequests', () => {
  it('files a new PR under the card whose issue it closes', () => {
    const { upserts } = reconcilePullRequests([], [fetched()], opts);
    expect(upserts[0]).toMatchObject({
      id: pullRequestId(42, 1),
      provider: 'github',
      taskId: 'task-1',
      issueKeys: ['acme/web#123'],
      syncedAt: NOW,
    });
  });

  it('files one under a tracker key when there is no closing reference', () => {
    const { upserts } = reconcilePullRequests(
      [],
      [fetched({ description: null, sourceBranch: 'feature/ENG-1' })],
      opts,
    );
    expect(upserts[0]).toMatchObject({ taskId: 'task-9', issueKeys: ['ENG-1'] });
  });

  it('lets the closing reference win when a PR names both', () => {
    const { upserts } = reconcilePullRequests(
      [],
      [fetched({ title: 'ENG-1: fix login', sourceBranch: 'feature/ENG-1' })],
      opts,
    );
    expect(upserts[0].taskId).toBe('task-1');
    expect(upserts[0].issueKeys).toEqual(['acme/web#123', 'ENG-1']);
  });

  it('leaves a PR unfiled when the board holds no such ticket', () => {
    const { upserts } = reconcilePullRequests([], [fetched()], {
      ...opts,
      knownKeys: [],
      taskIdByKey: new Map(),
    });
    expect(upserts[0]).toMatchObject({ taskId: null, issueKeys: [] });
  });

  it('changes nothing about an unchanged PR but the sync stamp', () => {
    const first = reconcilePullRequests([], [fetched()], opts).upserts;
    const again = reconcilePullRequests(first, [fetched()], { ...opts, now: 2_000 });
    expect(again.deleteIds).toEqual([]);
    expect(again.upserts[0]).toEqual({ ...first[0], syncedAt: 2_000 });
  });

  it('raises an event when the checks GO red, but not while they stay red', () => {
    const green = reconcilePullRequests([], [fetched()], opts).upserts;
    expect(green[0].lastEventAt).toBeNull();

    const red = reconcilePullRequests(green, [fetched({ pipelineStatus: 'failed' })], {
      ...opts,
      now: 2_000,
    }).upserts;
    expect(red[0].lastEventAt).toBe(2_000);

    // Acknowledge it, then poll again with the checks still red.
    const seen = [{ ...red[0], lastEventSeenAt: 2_000 }];
    const stillRed = reconcilePullRequests(seen, [fetched({ pipelineStatus: 'failed' })], {
      ...opts,
      now: 3_000,
    }).upserts;
    expect(stillRed[0].lastEventAt).toBe(2_000);
    expect(mrNeedsAttention(stillRed[0])).toBe(false);
  });

  it('raises an event when a PR BECOMES ready to merge, but not while it stays ready', () => {
    // One approval short: nothing to shout about yet. (`fetched()` is green, 1 of 2.)
    const waiting = reconcilePullRequests([], [fetched()], opts).upserts;
    expect(waiting[0].lastEventAt).toBeNull();

    const ready = reconcilePullRequests(waiting, [fetched({ approvalsGiven: 2 })], {
      ...opts,
      now: 2_000,
    }).upserts;
    expect(ready[0].lastEventAt).toBe(2_000);
    expect(mrAttentionReason(ready[0])).toContain('ready to merge');

    const seen = [{ ...ready[0], lastEventSeenAt: 2_000 }];
    const stillReady = reconcilePullRequests(seen, [fetched({ approvalsGiven: 2 })], {
      ...opts,
      now: 3_000,
    }).upserts;
    expect(stillReady[0].lastEventAt).toBe(2_000);
    expect(mrNeedsAttention(stillReady[0])).toBe(false);
  });

  it('raises an event when approvals drop, or when changes are requested', () => {
    const base = reconcilePullRequests([], [fetched({ approvalsGiven: 2 })], opts).upserts;
    const dropped = reconcilePullRequests(base, [fetched({ approvalsGiven: 1 })], {
      ...opts,
      now: 2_000,
    }).upserts;
    expect(dropped[0].lastEventAt).toBe(2_000);

    const requested = reconcilePullRequests(base, [fetched({ changesRequested: true })], {
      ...opts,
      now: 3_000,
    }).upserts;
    expect(requested[0].lastEventAt).toBe(3_000);
  });

  it('counts other people’s comments and ignores my own', () => {
    const mine = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 7)] })],
      opts,
    );
    expect(mine.upserts[0].latestNoteAt).toBeNull();

    const theirs = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 8)] })],
      opts,
    );
    expect(theirs.upserts[0].latestNoteAt).toBe(Date.parse('2026-08-01T10:00:00Z'));
  });

  /**
   * The unread ring is what a comment on a PR is FOR — and `mrNeedsAttention` is what the card
   * asks. A review left by somebody else raises it; the same review left by you does not.
   */
  it('raises the ring for a review comment that is not yours', () => {
    const [pr] = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 8)] })],
      opts,
    ).upserts;
    expect(mrNeedsAttention(pr)).toBe(true);
    expect(mrAttentionReason(pr)).toContain('new comments');

    const [mine] = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 7)] })],
      opts,
    ).upserts;
    expect(mrNeedsAttention(mine)).toBe(false);
  });

  // An identity we could not read counts nothing as yours: a PR that shouts when it needn't
  // is a nuisance, one that stays quiet while a reviewer waits is a missed review.
  it('treats every comment as foreign when it does not know who you are', () => {
    const { upserts } = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 7)] })],
      { ...opts, identity: null },
    );
    expect(upserts[0].latestNoteAt).toBe(Date.parse('2026-08-01T10:00:00Z'));
  });

  /**
   * The line this step replaced. Comments are only re-read for PRs that moved, so an absent
   * list must keep what we knew — the old `prior?.latestNoteAt ?? null` blanked it, which is
   * how a PR you had never read went quiet on the next poll.
   */
  it('keeps a known comment time when this sync did not re-read the discussion', () => {
    const prior = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 8)] })],
      opts,
    ).upserts;
    const again = reconcilePullRequests(prior, [fetched()], opts);
    expect(again.upserts[0].latestNoteAt).toBe(prior[0].latestNoteAt);
  });

  // Nothing but your own comments on a PR we DID re-read is not a reason to forget the one
  // somebody else left last week.
  it('keeps a known comment time when the only new comments are yours', () => {
    const prior = reconcilePullRequests(
      [],
      [fetched({ notes: [note('2026-08-01T10:00:00Z', 8)] })],
      opts,
    ).upserts;
    const again = reconcilePullRequests(
      prior,
      [fetched({ notes: [note('2026-08-02T10:00:00Z', 7)] })],
      opts,
    );
    expect(again.upserts[0].latestNoteAt).toBe(Date.parse('2026-08-01T10:00:00Z'));
  });

  it('preserves the user’s read markers and local rename across every sync', () => {
    const first = reconcilePullRequests([], [fetched()], opts).upserts;
    const read: MergeRequest[] = [
      { ...first[0], lastReadAt: 500, lastEventSeenAt: 600, displayName: 'the login fix' },
    ];
    const again = reconcilePullRequests(read, [fetched({ title: 'Retitled upstream' })], opts);
    expect(again.upserts[0]).toMatchObject({
      lastReadAt: 500,
      lastEventSeenAt: 600,
      displayName: 'the login fix',
      title: 'Retitled upstream',
    });
  });

  it('keeps GitHub’s merge verdict when this sync did not re-read the detail', () => {
    // A search row carries no `mergeable_state`, so a stale PR arrives with null — which must
    // not be read as one fewer reason not to merge.
    const first = reconcilePullRequests(
      [],
      [fetched({ detailedMergeStatus: 'dirty' })],
      opts,
    ).upserts;
    const again = reconcilePullRequests(first, [fetched({ detailedMergeStatus: null })], opts);
    expect(again.upserts[0].detailedMergeStatus).toBe('dirty');
  });

  it('deletes a PR that vanished while still open — it is no longer ours to track', () => {
    const stored = reconcilePullRequests([], [fetched()], opts).upserts;
    const { upserts, deleteIds } = reconcilePullRequests(stored, [], opts);
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual([pullRequestId(42, 1)]);
  });

  it('hands a placeholder row’s markers to the real id once the repository id arrives', () => {
    // A first sighting whose detail call failed has no repository id — a search row does not
    // carry one — so it is stored as `gh-0-1`. Recognising it by `owner/repo#number` is what
    // moves the read markers across instead of leaving a duplicate behind.
    const placeholder = reconcilePullRequests([], [fetched({ repoId: 0 })], opts).upserts;
    expect(placeholder[0].id).toBe(pullRequestId(0, 1));

    const marked = [{ ...placeholder[0], lastReadAt: 500 }];
    const { upserts, deleteIds } = reconcilePullRequests(marked, [fetched()], opts);
    expect(upserts[0].id).toBe(pullRequestId(42, 1));
    expect(upserts[0].lastReadAt).toBe(500);
    expect(deleteIds).toEqual([pullRequestId(0, 1)]);
  });

  describe('a settled PR is the card’s history, not a row to delete', () => {
    /** What the IPC layer hands back after reading a dropped-out PR by number. */
    const settled = (state: 'merged' | 'closed'): MergeRequest =>
      reconcilePullRequests([], [fetched({ state })], opts).upserts[0];

    it('keeps a merged PR on its card once GitHub stops listing it', () => {
      const { upserts, deleteIds } = reconcilePullRequests([settled('merged')], [], opts);
      expect(deleteIds).toEqual([]);
      expect(upserts).toEqual([]); // nothing changed about it — no needless write
    });

    it('keeps a closed one too: how it ended is part of the story', () => {
      expect(reconcilePullRequests([settled('closed')], [], opts).deleteIds).toEqual([]);
    });

    it('lets a settled PR go once its ticket has left the board', () => {
      const { deleteIds } = reconcilePullRequests([settled('merged')], [], {
        ...opts,
        knownKeys: [],
        taskIdByKey: new Map(),
      });
      expect(deleteIds).toEqual([pullRequestId(42, 1)]);
    });

    it('re-files a retained PR when its issue lands on a different card', () => {
      const { upserts, deleteIds } = reconcilePullRequests([settled('merged')], [], {
        ...opts,
        taskIdByKey: new Map([['acme/web#123', 'task-2']]),
      });
      expect(deleteIds).toEqual([]);
      expect(upserts[0].taskId).toBe('task-2');
    });

    it('never shouts: a merged PR cannot raise the card’s ring', () => {
      expect(
        mrNeedsAttention({ ...settled('merged'), latestNoteAt: 9_999, lastReadAt: null }),
      ).toBe(false);
    });

    /**
     * The chain of execution's other half, and the reason `after-merge` gates work on a
     * GitHub repository: nobody here ran the merge, so this is the only way the app learns
     * a card's work landed. `landedTaskIds` is provider-neutral and shared with GitLab.
     */
    it('reports the card behind a merged PR to the chain', () => {
      expect(landedTaskIds([settled('merged')])).toEqual(['task-1']);
      expect(landedTaskIds([settled('closed')])).toEqual([]);
      expect(landedTaskIds([{ ...settled('merged'), taskId: null }])).toEqual([]);
    });
  });

  it('handles several PRs on one card', () => {
    const { upserts } = reconcilePullRequests(
      [],
      [fetched({ number: 1 }), fetched({ number: 2 })],
      opts,
    );
    expect(upserts.map((m) => m.taskId)).toEqual(['task-1', 'task-1']);
    expect(new Set(upserts.map((m) => m.id)).size).toBe(2);
  });
});

describe('rematchPullRequests', () => {
  const stored = (over: Partial<MergeRequest> = {}): MergeRequest => ({
    ...reconcilePullRequests([], [fetched()], opts).upserts[0],
    ...over,
  });

  it('attaches an orphan once its issue appears on the board', () => {
    const orphan = { ...stored(), taskId: null };
    expect(rematchPullRequests([orphan], opts)).toEqual([{ ...orphan, taskId: 'task-1' }]);
  });

  it('lets go when the issue leaves the board, rather than pointing at nothing', () => {
    const changed = rematchPullRequests([stored()], { knownKeys: [], taskIdByKey: new Map() });
    expect(changed[0].taskId).toBeNull();
  });

  it('returns nothing when no PR changed hands', () => {
    expect(rematchPullRequests([stored()], opts)).toEqual([]);
  });

  /**
   * The GitHub-specific half: a closing reference almost always lives in the BODY, which is
   * not a field we store. Without remembering it, a re-match would re-discover only the
   * tracker key in the branch and quietly move the PR to a different card than the sync
   * chose — the two paths would disagree on every board change.
   */
  it('remembers a closing reference the description carried, over a re-readable tracker key', () => {
    const fromBody = stored({ title: 'ENG-1: fix login', sourceBranch: 'feature/ENG-1' });
    expect(fromBody.issueKeys).toContain('acme/web#123');
    expect(rematchPullRequests([fromBody], opts)).toEqual([]);
    expect(fromBody.taskId).toBe('task-1');
  });

  it('falls back to the tracker key once the closing reference’s card has gone', () => {
    const fromBody = stored({ title: 'ENG-1: fix login', sourceBranch: 'feature/ENG-1' });
    const changed = rematchPullRequests([fromBody], {
      knownKeys: ['ENG-1'],
      taskIdByKey: new Map([['ENG-1', 'task-9']]),
    });
    expect(changed[0].taskId).toBe('task-9');
  });
});
