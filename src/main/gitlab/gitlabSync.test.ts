import { describe, expect, it } from 'vitest';
import type { MergeRequest } from '@shared/mergeRequest';
import { mrNeedsAttention } from '@shared/mergeRequest';
import {
  mergeRequestId,
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

const note = (at: string, authorId: number): { id: number; body: string; created_at: string; author: { id: number } } => ({
  id: authorId,
  body: 'hi',
  created_at: at,
  author: { id: authorId },
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

  it('deletes an MR GitLab stopped listing — it merged or closed, which is not news', () => {
    const stored = reconcileMergeRequests([], [fetched()], opts).upserts;
    const { upserts, deleteIds } = reconcileMergeRequests(stored, [], opts);
    expect(upserts).toEqual([]);
    expect(deleteIds).toEqual([mergeRequestId(9, 1)]);
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
