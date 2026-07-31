import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import { mrAttentionReason, mrNeedsAttention } from '@shared/mergeRequest';
import {
  mergeRequestId,
  needsDetailRefresh,
  reconcileMergeRequests,
  rematchMergeRequests,
  type FetchedMergeRequest,
} from './gitlabSync';

const ME = { id: 7, username: 'wd', baseUrl: 'https://gitlab.com' };
const NOW = 1_000;

const fetched = (over: Partial<FetchedMergeRequest> = {}): FetchedMergeRequest => ({
  gitlabProjectId: 9,
  iid: 1,
  projectPath: 'acme/web',
  title: 'ENG-1: fix login',
  description: null,
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
  updatedAt: 900,
  ...over,
});

const opts = {
  knownKeys: ['ENG-1'],
  taskIdByKey: new Map([['ENG-1', 'task-1']]),
  identity: ME,
  now: NOW,
};

const note = (
  at: string,
  authorId: number,
): { id: number; body: string; created_at: string; author: { id: number } } => ({
  id: authorId,
  body: 'hi',
  created_at: at,
  author: { id: authorId },
});

describe('needsDetailRefresh', () => {
  const prior = (over: Partial<MergeRequest> = {}): MergeRequest =>
    ({ ...reconcileMergeRequests([], [fetched()], opts).upserts[0], ...over }) as MergeRequest;

  it('always reads an MR it has never seen', () => {
    expect(needsDetailRefresh(undefined, 900)).toBe(true);
  });

  it('reads one whose updated_at moved', () => {
    expect(needsDetailRefresh(prior({ updatedAt: 900 }), 901)).toBe(true);
  });

  // The bug: GitLab does not touch the MR when its pipeline finishes, so `updated_at`
  // alone left an MR first seen mid-pipeline reading "running" for good — Sync re-listed
  // it, saw nothing had moved, and kept the stale status.
  it.each(['created', 'pending', 'running'] as const)(
    're-reads an untouched MR whose pipeline is still %s',
    (pipelineStatus) => {
      expect(needsDetailRefresh(prior({ updatedAt: 900, pipelineStatus }), 900)).toBe(true);
    },
  );

  // Bounded on purpose: the re-reading stops the moment the pipeline settles, and `manual`
  // / `unknown` can sit unchanged forever so they must not keep it going.
  it.each(['success', 'failed', 'canceled', 'skipped', 'manual', 'unknown'] as const)(
    'leaves an untouched MR alone once its pipeline is %s',
    (pipelineStatus) => {
      expect(needsDetailRefresh(prior({ updatedAt: 900, pipelineStatus }), 900)).toBe(false);
    },
  );
});

describe('reconcileMergeRequests', () => {
  it('files a new MR under the task whose key it names', () => {
    const { upserts } = reconcileMergeRequests([], [fetched()], opts);
    expect(upserts[0]).toMatchObject({
      id: mergeRequestId(9, 1),
      taskId: 'task-1',
      issueKeys: ['ENG-1'],
      syncedAt: NOW,
    });
  });

  it('leaves an MR unfiled when the board holds no such ticket', () => {
    const { upserts } = reconcileMergeRequests([], [fetched()], {
      ...opts,
      knownKeys: [],
      taskIdByKey: new Map(),
    });
    expect(upserts[0]).toMatchObject({ taskId: null, issueKeys: [] });
  });

  it('counts other people’s notes and ignores my own', () => {
    const mine = reconcileMergeRequests(
      [],
      [fetched({ notes: [note('2026-07-01T10:00:00Z', 7)] })],
      opts,
    );
    expect(mine.upserts[0].latestNoteAt).toBeNull();

    const theirs = reconcileMergeRequests(
      [],
      [fetched({ notes: [note('2026-07-01T10:00:00Z', 8)] })],
      opts,
    );
    expect(theirs.upserts[0].latestNoteAt).toBe(Date.parse('2026-07-01T10:00:00Z'));
  });

  it('keeps a known note time when this sync did not re-read the discussion', () => {
    const prior = reconcileMergeRequests(
      [],
      [fetched({ notes: [note('2026-07-01T10:00:00Z', 8)] })],
      opts,
    ).upserts;
    const again = reconcileMergeRequests(prior, [fetched()], opts);
    expect(again.upserts[0].latestNoteAt).toBe(prior[0].latestNoteAt);
  });

  it('raises an event when the pipeline GOES red, but not while it stays red', () => {
    const green = reconcileMergeRequests([], [fetched()], opts).upserts;
    expect(green[0].lastEventAt).toBeNull();

    const red = reconcileMergeRequests(green, [fetched({ pipelineStatus: 'failed' })], {
      ...opts,
      now: 2_000,
    }).upserts;
    expect(red[0].lastEventAt).toBe(2_000);

    // Acknowledge it, then poll again with the pipeline still red.
    const seen = [{ ...red[0], lastEventSeenAt: 2_000 }];
    const stillRed = reconcileMergeRequests(seen, [fetched({ pipelineStatus: 'failed' })], {
      ...opts,
      now: 3_000,
    }).upserts;
    expect(stillRed[0].lastEventAt).toBe(2_000);
    expect(mrNeedsAttention(stillRed[0])).toBe(false);
  });

  it('raises an event when an MR BECOMES ready to merge, but not while it stays ready', () => {
    // One approval short: nothing to shout about yet. (`fetched()` is green, 1 of 2.)
    const waiting = reconcileMergeRequests([], [fetched()], opts).upserts;
    expect(waiting[0].lastEventAt).toBeNull();
    expect(mrNeedsAttention(waiting[0])).toBe(false);

    // The second approval lands — now it is yours to merge.
    const ready = reconcileMergeRequests(waiting, [fetched({ approvalsGiven: 2 })], {
      ...opts,
      now: 2_000,
    }).upserts;
    expect(ready[0].lastEventAt).toBe(2_000);
    expect(mrNeedsAttention(ready[0])).toBe(true);
    expect(mrAttentionReason(ready[0])).toContain('ready to merge');

    // Acknowledge it, then poll again while it is still green and still approved. Good news
    // re-raised on every poll would mean "Acknowledge pipeline" never sticks.
    const seen = [{ ...ready[0], lastEventSeenAt: 2_000 }];
    const stillReady = reconcileMergeRequests(seen, [fetched({ approvalsGiven: 2 })], {
      ...opts,
      now: 3_000,
    }).upserts;
    expect(stillReady[0].lastEventAt).toBe(2_000);
    expect(mrNeedsAttention(stillReady[0])).toBe(false);
  });

  // The pipeline finishing is the other half of the same transition.
  it('raises an event when an already-approved MR turns green', () => {
    const approvedButRunning = reconcileMergeRequests(
      [],
      [fetched({ approvalsGiven: 2, pipelineStatus: 'running' })],
      opts,
    ).upserts;
    expect(approvedButRunning[0].lastEventAt).toBeNull();

    const green = reconcileMergeRequests(
      approvedButRunning,
      [fetched({ approvalsGiven: 2, pipelineStatus: 'success' })],
      { ...opts, now: 2_000 },
    ).upserts;
    expect(green[0].lastEventAt).toBe(2_000);
    expect(mrNeedsAttention(green[0])).toBe(true);
  });

  it('raises an event when approvals drop, or when changes are requested', () => {
    const base = reconcileMergeRequests([], [fetched({ approvalsGiven: 2 })], opts).upserts;
    const dropped = reconcileMergeRequests(base, [fetched({ approvalsGiven: 1 })], {
      ...opts,
      now: 2_000,
    }).upserts;
    expect(dropped[0].lastEventAt).toBe(2_000);

    const requested = reconcileMergeRequests(base, [fetched({ changesRequested: true })], {
      ...opts,
      now: 3_000,
    }).upserts;
    expect(requested[0].lastEventAt).toBe(3_000);
  });

  it('preserves the user’s read markers across every sync', () => {
    const first = reconcileMergeRequests([], [fetched()], opts).upserts;
    const read: MergeRequest[] = [{ ...first[0], lastReadAt: 500, lastEventSeenAt: 600 }];
    const again = reconcileMergeRequests(read, [fetched({ title: 'ENG-1: retitled' })], opts);
    expect(again.upserts[0]).toMatchObject({ lastReadAt: 500, lastEventSeenAt: 600 });
    expect(again.upserts[0].title).toBe('ENG-1: retitled');
  });

  it('deletes an MR that vanished while still open — it is no longer ours to track', () => {
    const stored = reconcileMergeRequests([], [fetched()], opts).upserts;
    const { upserts, deleteIds } = reconcileMergeRequests(stored, [], opts);
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual([mergeRequestId(9, 1)]);
  });

  describe('a settled MR is the card’s history, not a row to delete', () => {
    /** What the IPC layer hands back after reading a dropped-out MR by iid. */
    const settled = (state: 'merged' | 'closed'): MergeRequest =>
      reconcileMergeRequests([], [fetched({ state })], opts).upserts[0];

    it('keeps a merged MR on its card once GitLab stops listing it', () => {
      // The complaint this fixes: merge the MR and the row disappeared off the card at the
      // very moment it had something worth saying.
      const { upserts, deleteIds } = reconcileMergeRequests([settled('merged')], [], opts);
      expect(deleteIds).toEqual([]);
      expect(upserts).toEqual([]); // nothing changed about it — no needless write
    });

    it('keeps a closed one too: how it ended is part of the story', () => {
      const { deleteIds } = reconcileMergeRequests([settled('closed')], [], opts);
      expect(deleteIds).toEqual([]);
    });

    it('lets a settled MR go once its ticket has left the board', () => {
      // What bounds the table: nothing on screen points at it any more.
      const { deleteIds } = reconcileMergeRequests([settled('merged')], [], {
        ...opts,
        knownKeys: [],
        taskIdByKey: new Map(),
      });
      expect(deleteIds).toEqual([mergeRequestId(9, 1)]);
    });

    it('re-files a retained MR when its ticket lands on a different card', () => {
      const { upserts, deleteIds } = reconcileMergeRequests([settled('merged')], [], {
        ...opts,
        taskIdByKey: new Map([['ENG-1', 'task-2']]),
      });
      expect(deleteIds).toEqual([]);
      expect(upserts[0].taskId).toBe('task-2');
    });

    it('never shouts: a merged MR cannot raise the card’s ring', () => {
      const merged = { ...settled('merged'), latestNoteAt: 9_999, lastReadAt: null };
      expect(mrNeedsAttention(merged)).toBe(false);
    });
  });

  it('handles several MRs on one ticket', () => {
    const { upserts } = reconcileMergeRequests(
      [],
      [fetched({ iid: 1 }), fetched({ iid: 2, sourceBranch: 'feature/ENG-1-part-2' })],
      opts,
    );
    expect(upserts.map((m) => m.taskId)).toEqual(['task-1', 'task-1']);
    expect(new Set(upserts.map((m) => m.id)).size).toBe(2);
  });
});

describe('rematchMergeRequests', () => {
  const stored = (over: Partial<MergeRequest> = {}): MergeRequest =>
    reconcileMergeRequests([], [fetched()], opts).upserts.map((m) => ({ ...m, ...over }))[0];

  it('attaches an orphan once its ticket appears on the board', () => {
    const orphan = { ...stored(), taskId: null };
    const changed = rematchMergeRequests([orphan], {
      knownKeys: ['ENG-1'],
      taskIdByKey: new Map([['ENG-1', 'task-1']]),
    });
    expect(changed).toEqual([{ ...orphan, taskId: 'task-1' }]);
  });

  it('lets go when the ticket leaves the board, rather than pointing at nothing', () => {
    const changed = rematchMergeRequests([stored()], {
      knownKeys: [],
      taskIdByKey: new Map(),
    });
    expect(changed[0].taskId).toBeNull();
  });

  it('returns nothing when no MR changed hands', () => {
    expect(
      rematchMergeRequests([stored()], {
        knownKeys: ['ENG-1'],
        taskIdByKey: new Map([['ENG-1', 'task-1']]),
      }),
    ).toEqual([]);
  });

  it('remembers a key only the description carried, which re-matching cannot re-read', () => {
    const fromDescription = {
      ...stored(),
      taskId: null,
      title: 'fix login',
      sourceBranch: 'wd/login',
      issueKeys: ['ENG-1'],
    };
    const changed = rematchMergeRequests([fromDescription], {
      knownKeys: ['ENG-1'],
      taskIdByKey: new Map([['ENG-1', 'task-1']]),
    });
    expect(changed[0].taskId).toBe('task-1');
  });
});
