import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import { mrAttentionReason, mrNeedsAttention } from '@shared/mergeRequest';
import {
  landedTaskIds,
  mergeRequestId,
  reconcileMergeRequests,
  rematchMergeRequests,
  type FetchedMergeRequest,
} from './gitlabSync';

const ME = { id: 7, username: 'wd', baseUrl: 'https://gitlab.com' };
const NOW = 1_000;

const fetched = (over: Partial<FetchedMergeRequest> = {}): FetchedMergeRequest => ({
  repoId: 9,
  number: 1,
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
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
  updatedAt: 900,
  ...over,
});

const opts = {
  knownKeys: ['ENG-1'],
  taskIdByKey: new Map([['ENG-1', 'task-1']]),
  // The card behind the key, plus one that carries no key at all — the shape a merge request
  // opened by the button on a native ticket has to survive on.
  knownTaskIds: new Set(['task-1', 'task-keyless']),
  identity: ME,
  now: NOW,
};

// The neutral note shape (`forge/notes.ts`) the fetched MR now carries — `describeMergeRequest`
// maps GitLab's `created_at` onto it, so the reconciler asks one question of both forges.
const note = (at: string, authorId: number): { createdAt: string; author: { id: number } } => ({
  createdAt: at,
  author: { id: authorId },
});

// `needsDetailRefresh` and `PIPELINE_IN_FLIGHT` moved to `forge/refreshPolicy.test.ts` — the
// rule they test is forge-neutral, and re-exported here only for callers that already import
// this module.

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

  /**
   * The reported bug, and the shape it was reported in: press **Create PR** on a card, watch
   * the row appear, and watch the next sync — manual or automatic — take it off the card.
   *
   * The card here carries no tracker key, which is the ordinary case for a native ticket and
   * for a card somebody typed in. There is nothing in the merge request's own text to
   * re-derive from, so every sync wrote `taskId: null` over a link the button had known for
   * certain, and the row sat in the table belonging to nobody.
   */
  describe('a merge request this app opened itself', () => {
    /** The row `createPr.rowFor` writes: filed under the card, and remembering which. */
    const keyless = (): FetchedMergeRequest =>
      fetched({ title: 'fix the login redirect', sourceBranch: 'wd/login', description: null });
    const opened = (): MergeRequest => ({
      ...reconcileMergeRequests([], [keyless()], opts).upserts[0],
      taskId: 'task-keyless',
      openedForTaskId: 'task-keyless',
    });

    // The half that makes the rest of it a bug rather than a preference: nothing in this
    // merge request names a card, so matching by key has no answer to give.
    it('has nothing to match on, which is why remembering is the fix', () => {
      const { upserts } = reconcileMergeRequests([], [keyless()], opts);
      expect(upserts[0]).toMatchObject({ taskId: null, issueKeys: [] });
    });

    it('stays on its card across a sync that can re-derive nothing', () => {
      const { upserts } = reconcileMergeRequests([opened()], [keyless()], opts);
      expect(upserts[0].taskId).toBe('task-keyless');
      expect(upserts[0].openedForTaskId).toBe('task-keyless');
    });

    // Same board change, through the no-network path: `rematchStoredMergeRequests` runs after
    // every JIRA and GitHub sync, so a link this did not honour would be undone anyway.
    it('is not re-filed by a rematch either', () => {
      expect(rematchMergeRequests([opened()], opts)).toEqual([]);
    });

    it('beats a key the merge request happens to name', () => {
      // Its title says ENG-1 — task-1's ticket — but it was opened for another card, and
      // that is not a guess to be overruled by one.
      const mine = { ...opened(), title: 'ENG-1: fix login', sourceBranch: 'feature/ENG-1' };
      const { upserts } = reconcileMergeRequests([mine], [fetched()], opts);
      expect(upserts[0].taskId).toBe('task-keyless');
    });

    it('falls back to the key once the card it was opened for leaves the board', () => {
      const mine = { ...opened(), title: 'ENG-1: fix login', sourceBranch: 'feature/ENG-1' };
      const { upserts } = reconcileMergeRequests([mine], [fetched()], {
        ...opts,
        knownTaskIds: new Set(['task-1']),
      });
      expect(upserts[0].taskId).toBe('task-1');
      // Remembered all the same: the card may come back from the archive.
      expect(upserts[0].openedForTaskId).toBe('task-keyless');
    });

    it('keeps it once it merges, exactly as a key-matched one is kept', () => {
      const merged = { ...opened(), state: 'merged' as const };
      const { deleteIds } = reconcileMergeRequests([merged], [], opts);
      expect(deleteIds).toEqual([]);
    });
  });

  it('deletes an MR that vanished while still open — it is no longer ours to track', () => {
    const stored = reconcileMergeRequests([], [fetched()], opts).upserts;
    const { upserts, deleteIds } = reconcileMergeRequests(stored, [], opts);
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual([mergeRequestId(9, 1)]);
  });

  describe('a settled MR is the card’s history, not a row to delete', () => {
    /** What the IPC layer hands back after reading a dropped-out MR by number. */
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

    /**
     * The chain of execution's other half: for a project whose branches go through review,
     * this is the ONLY way the app learns that a card's work landed — nobody here ran the
     * merge (see `Task.landedAt`).
     */
    describe('landedTaskIds', () => {
      it('reports the card behind a merged MR', () => {
        expect(landedTaskIds([settled('merged')])).toEqual(['task-1']);
      });

      it('reports nothing for one that is open or closed', () => {
        expect(landedTaskIds([settled('closed')])).toEqual([]);
        expect(landedTaskIds(reconcileMergeRequests([], [fetched()], opts).upserts)).toEqual([]);
      });

      it('names a card once however many of its MRs merged', () => {
        const two = reconcileMergeRequests(
          [],
          [fetched({ number: 1, state: 'merged' }), fetched({ number: 2, state: 'merged' })],
          opts,
        ).upserts;
        expect(landedTaskIds(two)).toEqual(['task-1']);
      });

      it('skips an MR that matches no card on the board', () => {
        const orphan = { ...settled('merged'), taskId: null };
        expect(landedTaskIds([orphan])).toEqual([]);
      });
    });
  });

  it('handles several MRs on one ticket', () => {
    const { upserts } = reconcileMergeRequests(
      [],
      [fetched({ number: 1 }), fetched({ number: 2, sourceBranch: 'feature/ENG-1-part-2' })],
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
      knownTaskIds: new Set(['task-1']),
    });
    expect(changed).toEqual([{ ...orphan, taskId: 'task-1' }]);
  });

  it('lets go when the ticket leaves the board, rather than pointing at nothing', () => {
    const changed = rematchMergeRequests([stored()], {
      knownKeys: [],
      taskIdByKey: new Map(),
      knownTaskIds: new Set(),
    });
    expect(changed[0].taskId).toBeNull();
  });

  it('returns nothing when no MR changed hands', () => {
    expect(
      rematchMergeRequests([stored()], {
        knownKeys: ['ENG-1'],
        taskIdByKey: new Map([['ENG-1', 'task-1']]),
        knownTaskIds: new Set(['task-1']),
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
      knownTaskIds: new Set(['task-1']),
    });
    expect(changed[0].taskId).toBe('task-1');
  });
});
