/**
 * `ReviewService` against a fake store and a fake `DiffService.filesFor` — the three rules
 * from the header of `reviewService.ts` (anchor-against-the-current-diff, a sent comment is
 * history, `outdated` is never stored), plus every write's own validation.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/model';
import type { DiffFile, DiffHunk, DiffLine, ReviewComment } from '@shared/review';
import type { Store } from '../store';
import { ReviewService, type ReviewServiceDeps } from './reviewService';

function line(partial: Partial<DiffLine> & { text: string }): DiffLine {
  return { kind: 'context', ...partial };
}

function hunk(lines: DiffLine[], overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    oldStart: 1,
    oldLines: lines.length,
    newStart: 1,
    newLines: lines.length,
    header: '@@ -1 +1 @@',
    lines,
    ...overrides,
  };
}

function file(hunks: DiffHunk[], overrides: Partial<DiffFile> = {}): DiffFile {
  return { diffId: 'diff-1', path: 'src/a.ts', hunks, ...overrides };
}

function seedComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    taskId: 't1',
    diffId: 'diff-1',
    path: 'src/a.ts',
    side: 'new',
    line: 5,
    body: 'note',
    excerpt: 'const x = 1;',
    createdAt: 1,
    updatedAt: 1,
    sentAt: null,
    ...overrides,
  };
}

type UpdatePatch = Parameters<Store['updateReviewComment']>[1];

/** In-memory store that keeps the real guard: a write refuses once `sentAt` is set. */
function fakeStore(seed: ReviewComment[] = [], knownTasks: Set<string> = new Set(['t1'])) {
  const rows = [...seed];
  let nextId = rows.length + 1;
  return {
    getTask: (id: string) => (knownTasks.has(id) ? ({ id } as unknown as Task) : undefined),
    listReviewComments: (taskId: string) => rows.filter((r) => r.taskId === taskId),
    addReviewComment: (input: Omit<ReviewComment, 'id' | 'createdAt' | 'updatedAt' | 'sentAt'>) => {
      if (!knownTasks.has(input.taskId)) return undefined;
      const now = Date.now();
      const comment: ReviewComment = {
        ...input,
        id: `c${nextId++}`,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      };
      rows.push(comment);
      return comment;
    },
    updateReviewComment: (id: string, patch: UpdatePatch) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return undefined;
      const existing = rows[idx];
      if (existing.sentAt !== null) return undefined;
      const startSet = 'start' in patch;
      const next: ReviewComment = {
        ...existing,
        diffId: patch.diffId !== undefined ? patch.diffId : existing.diffId,
        side: patch.side !== undefined ? patch.side : existing.side,
        line: patch.line !== undefined ? patch.line : existing.line,
        start: startSet ? (patch.start ?? undefined) : existing.start,
        body: patch.body !== undefined ? patch.body : existing.body,
        excerpt: patch.excerpt !== undefined ? patch.excerpt : existing.excerpt,
        updatedAt: Date.now(),
      };
      rows[idx] = next;
      return next;
    },
    deleteReviewComment: (id: string) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1 || rows[idx].sentAt !== null) return false;
      rows.splice(idx, 1);
      return true;
    },
    markReviewSent: (taskId: string, ids: readonly string[], at: number) => {
      const stamped: ReviewComment[] = [];
      for (const id of ids) {
        const idx = rows.findIndex((r) => r.id === id && r.taskId === taskId);
        if (idx === -1 || rows[idx].sentAt !== null) continue;
        rows[idx] = { ...rows[idx], sentAt: at };
        stamped.push(rows[idx]);
      }
      return stamped;
    },
  };
}

type FilesForResult = Awaited<ReturnType<ReviewServiceDeps['diffs']['filesFor']>>;
type FilesForFixture = {
  diffId: string;
  files: Map<string, { file: DiffFile; oldPath?: string } | null>;
};

/** A fake `filesFor` driven by a mutable `{ diffId, files }` fixture the test can swap mid-run. */
function fakeDiffs(initial: FilesForFixture | null) {
  const state: { current: FilesForFixture | null; failWith: Error | null } = {
    current: initial,
    failWith: null,
  };
  const calls: Array<{ taskId: string; paths: readonly string[] }> = [];
  const filesFor = async (taskId: string, paths: readonly string[]): Promise<FilesForResult> => {
    calls.push({ taskId, paths });
    if (state.failWith) {
      const err = state.failWith;
      state.failWith = null;
      throw err;
    }
    if (state.current === null) return null;
    const files = new Map<string, { file: DiffFile; oldPath?: string } | null>();
    for (const path of paths) files.set(path, state.current.files.get(path) ?? null);
    return { diffId: state.current.diffId, files };
  };
  return { filesFor, calls, state };
}

type SummaryResult = Awaited<ReturnType<ReviewServiceDeps['diffs']['summary']>>;

/** `review:add`/`update`/`delete`/`list` never call `diffs.summary` or `chat` — only `send` does. */
function unexercised(name: string): never {
  throw new Error(`${name} is not exercised by this test`);
}

function makeService(
  opts: {
    comments?: ReviewComment[];
    knownTasks?: Set<string>;
    diffs?: ReturnType<typeof fakeDiffs>;
    summary?: () => Promise<SummaryResult> | SummaryResult;
    chat?: ReviewServiceDeps['chat'];
  } = {},
) {
  const store = fakeStore(opts.comments ?? [], opts.knownTasks);
  const diffs = opts.diffs ?? fakeDiffs(null);
  const summary = opts.summary ?? (() => unexercised('diffs.summary'));
  const chat = opts.chat ?? (() => unexercised('chat'));
  const svc = new ReviewService({
    store,
    diffs: { filesFor: diffs.filesFor, summary: async () => summary() },
    chat,
  });
  return { svc, store, diffs };
}

describe('review:add', () => {
  it('refuses a stale diffId and stores nothing', async () => {
    const diffs = fakeDiffs({
      diffId: 'diff-2',
      files: new Map([
        ['src/a.ts', { file: file([hunk([line({ text: 'x', oldLine: 1, newLine: 1 })])]) }],
      ]),
    });
    const { svc, store } = makeService({ diffs });

    const result = await svc.add({
      taskId: 't1',
      diffId: 'diff-1',
      path: 'src/a.ts',
      side: 'new',
      line: 1,
      body: 'note',
    });

    expect(result).toEqual({ status: 'stale', diffId: 'diff-1', currentDiffId: 'diff-2' });
    expect(store.listReviewComments('t1')).toEqual([]);
  });

  it('answers stale with an empty currentDiffId when the card has landed or conflicted', async () => {
    const { svc, store } = makeService({ diffs: fakeDiffs(null) });

    const result = await svc.add({
      taskId: 't1',
      diffId: 'diff-1',
      path: 'src/a.ts',
      side: 'new',
      line: 1,
      body: 'note',
    });

    expect(result).toEqual({ status: 'stale', diffId: 'diff-1', currentDiffId: '' });
    expect(store.listReviewComments('t1')).toEqual([]);
  });

  it('computes the excerpt and carries oldPath from the current diff', async () => {
    const theFile = file([hunk([line({ text: 'const z = 3;', oldLine: 9, newLine: 9 })])], {
      path: 'new/path.ts',
    });
    const diffs = fakeDiffs({
      diffId: 'diff-1',
      files: new Map([['new/path.ts', { file: theFile, oldPath: 'old/path.ts' }]]),
    });
    const { svc, store } = makeService({ diffs });

    const result = await svc.add({
      taskId: 't1',
      diffId: 'diff-1',
      path: 'new/path.ts',
      side: 'new',
      line: 9,
      body: 'note',
    });

    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.comment.excerpt).toBe('const z = 3;');
    expect(result.comment.oldPath).toBe('old/path.ts');
    expect(store.listReviewComments('t1')[0]).toMatchObject({
      excerpt: 'const z = 3;',
      oldPath: 'old/path.ts',
    });
  });

  it('throws when the anchor line is not part of the diff', async () => {
    const diffs = fakeDiffs({
      diffId: 'diff-1',
      files: new Map([
        ['src/a.ts', { file: file([hunk([line({ text: 'x', oldLine: 1, newLine: 1 })])]) }],
      ]),
    });
    const { svc } = makeService({ diffs });

    await expect(
      svc.add({
        taskId: 't1',
        diffId: 'diff-1',
        path: 'src/a.ts',
        side: 'new',
        line: 99,
        body: 'note',
      }),
    ).rejects.toThrow(/no longer part of/);
  });

  it('throws for a file too large to anchor a comment to', async () => {
    const diffs = fakeDiffs({
      diffId: 'diff-1',
      files: new Map([['src/a.ts', { file: file([], { tooLarge: { bytes: 999 } }) }]]),
    });
    const { svc } = makeService({ diffs });

    await expect(
      svc.add({
        taskId: 't1',
        diffId: 'diff-1',
        path: 'src/a.ts',
        side: 'new',
        line: 1,
        body: 'note',
      }),
    ).rejects.toThrow(/too large/);
  });

  it('refuses an empty body', async () => {
    const { svc } = makeService();

    await expect(
      svc.add({
        taskId: 't1',
        diffId: 'diff-1',
        path: 'src/a.ts',
        side: 'new',
        line: 1,
        body: '   ',
      }),
    ).rejects.toThrow(/needs a body/);
  });
});

describe('a sent comment is history', () => {
  function sentComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
    return seedComment({ sentAt: 500, body: 'original body', ...overrides });
  }

  it('refuses to edit the body once sent, leaving the store unchanged', async () => {
    const seed = sentComment();
    const { svc, store } = makeService({ comments: [seed] });

    const result = await svc.update('t1', seed.id, { body: 'edited' });

    expect(result).toEqual({ status: 'sent', sentAt: 500 });
    expect(store.listReviewComments('t1')[0].body).toBe('original body');
  });

  it('refuses to delete once sent', async () => {
    const seed = sentComment();
    const { svc, store } = makeService({ comments: [seed] });

    const result = await svc.delete('t1', seed.id);

    expect(result).toEqual({ status: 'sent', sentAt: 500 });
    expect(store.listReviewComments('t1')).toHaveLength(1);
  });

  it('refuses to re-anchor once sent, without even resolving the diff', async () => {
    const seed = sentComment();
    const diffs = fakeDiffs({
      diffId: 'diff-1',
      files: new Map([
        [
          'src/a.ts',
          { file: file([hunk([line({ text: 'const x = 1;', oldLine: 9, newLine: 9 })])]) },
        ],
      ]),
    });
    const { svc, store } = makeService({ comments: [seed], diffs });

    const result = await svc.update('t1', seed.id, {
      anchor: { diffId: 'diff-1', side: 'new', line: 9 },
    });

    expect(result).toEqual({ status: 'sent', sentAt: 500 });
    expect(diffs.calls).toEqual([]);
    expect(store.listReviewComments('t1')[0].line).toBe(seed.line);
  });
});

describe('review:update', () => {
  it('clears start when a re-anchor moves from a range to a single line', async () => {
    const seed = seedComment({ start: { side: 'new', line: 3 }, line: 5, excerpt: 'a\nb\nc' });
    const diffs = fakeDiffs({
      diffId: 'diff-2',
      files: new Map([
        [
          'src/a.ts',
          { file: file([hunk([line({ text: 'const x = 9;', oldLine: 7, newLine: 7 })])]) },
        ],
      ]),
    });
    const { svc, store } = makeService({ comments: [seed], diffs });

    const result = await svc.update('t1', seed.id, {
      anchor: { diffId: 'diff-2', side: 'new', line: 7 },
    });

    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.comment.start).toBeUndefined();
    expect(store.listReviewComments('t1')[0].start).toBeUndefined();
  });

  it('makes no filesFor call for a body-only edit', async () => {
    const seed = seedComment();
    const diffs = fakeDiffs(null);
    const { svc, store } = makeService({ comments: [seed], diffs });

    const result = await svc.update('t1', seed.id, { body: 'updated text' });

    expect(result).toMatchObject({ status: 'ok' });
    expect(store.listReviewComments('t1')[0].body).toBe('updated text');
    expect(diffs.calls).toEqual([]);
  });

  it('refuses an empty body', async () => {
    const seed = seedComment();
    const { svc } = makeService({ comments: [seed] });

    await expect(svc.update('t1', seed.id, { body: '   ' })).rejects.toThrow(/needs a body/);
  });

  it('rejects an update for a task that is not in the app', async () => {
    const { svc } = makeService();

    await expect(svc.update('nope', 'c1', { body: 'x' })).rejects.toThrow(/no longer/);
  });
});

describe('review:list', () => {
  it('makes no filesFor call when there are no comments to recompute', async () => {
    const diffs = fakeDiffs(null);
    const { svc } = makeService({ diffs });

    const result = await svc.list('t1');

    expect(result).toEqual([]);
    expect(diffs.calls).toEqual([]);
  });

  it('returns the stored comments with no outdated key when the diff cannot resolve', async () => {
    const seed = seedComment();
    const { svc } = makeService({ comments: [seed], diffs: fakeDiffs(null) });

    const result = await svc.list('t1');

    expect(result).toEqual([seed]);
    expect('outdated' in result[0]).toBe(false);
  });

  it('returns the stored comments unflagged when filesFor throws', async () => {
    const seed = seedComment();
    const diffs = fakeDiffs(null);
    diffs.state.failWith = new Error('git blew up');
    const { svc } = makeService({ comments: [seed], diffs });

    const result = await svc.list('t1');

    expect(result).toEqual([seed]);
    expect(result[0].outdated).toBeUndefined();
  });

  describe('the outdated recompute', () => {
    it('reads false for an untouched anchor', async () => {
      const seed = seedComment();
      const diffs = fakeDiffs({
        diffId: 'diff-1',
        files: new Map([
          [
            'src/a.ts',
            { file: file([hunk([line({ text: 'const x = 1;', oldLine: 5, newLine: 5 })])]) },
          ],
        ]),
      });
      const { svc } = makeService({ comments: [seed], diffs });

      const [result] = await svc.list('t1');

      expect(result.outdated).toBe(false);
    });

    it('reads true for an edited line', async () => {
      const seed = seedComment();
      const diffs = fakeDiffs({
        diffId: 'diff-1',
        files: new Map([
          [
            'src/a.ts',
            { file: file([hunk([line({ text: 'const x = 2;', oldLine: 5, newLine: 5 })])]) },
          ],
        ]),
      });
      const { svc } = makeService({ comments: [seed], diffs });

      const [result] = await svc.list('t1');

      expect(result.outdated).toBe(true);
    });

    it('reads true for a file whose changes dropped out (no hunks left)', async () => {
      const seed = seedComment();
      const diffs = fakeDiffs({
        diffId: 'diff-1',
        files: new Map([['src/a.ts', { file: file([]) }]]),
      });
      const { svc } = makeService({ comments: [seed], diffs });

      const [result] = await svc.list('t1');

      expect(result.outdated).toBe(true);
    });

    it('flips a previously outdated comment back to false once the anchor matches again', async () => {
      const seed = seedComment();
      const diffs = fakeDiffs({
        diffId: 'diff-1',
        files: new Map([
          [
            'src/a.ts',
            { file: file([hunk([line({ text: 'const x = 9;', oldLine: 5, newLine: 5 })])]) },
          ],
        ]),
      });
      const { svc } = makeService({ comments: [seed], diffs });

      const first = await svc.list('t1');
      expect(first[0].outdated).toBe(true);

      diffs.state.current = {
        diffId: 'diff-1',
        files: new Map([
          [
            'src/a.ts',
            { file: file([hunk([line({ text: 'const x = 1;', oldLine: 5, newLine: 5 })])]) },
          ],
        ]),
      };
      const second = await svc.list('t1');
      expect(second[0].outdated).toBe(false);
    });

    it('never mutates the stored rows with outdated', async () => {
      const seed = seedComment();
      const diffs = fakeDiffs({
        diffId: 'diff-1',
        files: new Map([
          [
            'src/a.ts',
            { file: file([hunk([line({ text: 'const x = 2;', oldLine: 5, newLine: 5 })])]) },
          ],
        ]),
      });
      const { svc, store } = makeService({ comments: [seed], diffs });

      const result = await svc.list('t1');
      expect(result[0].outdated).toBe(true);

      const stored = store.listReviewComments('t1')[0];
      expect('outdated' in stored).toBe(false);
    });
  });
});
