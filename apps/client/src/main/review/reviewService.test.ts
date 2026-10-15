/**
 * `ReviewService` against a fake store and a fake `DiffService.filesFor` — the three rules
 * from the header of `reviewService.ts` (anchor-against-the-current-diff, a sent comment is
 * history, `outdated` is never stored), plus every write's own validation.
 */
import { describe, expect, it } from 'vitest';
import type { ChatSendResult, Task } from '@shared/model';
import { formatReviewMessage } from '@shared/review';
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffSummary,
  DiffSummaryResult,
  ReviewComment,
} from '@shared/review';
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

/** `review:add`/`update`/`delete`/`list` never call `diffs.summary` or `chat` — only `send` does. */
function unexercised(name: string): never {
  throw new Error(`${name} is not exercised by this test`);
}

function summaryFixture(overrides: Partial<DiffSummary> = {}): DiffSummary {
  return {
    diffId: 'diff-1',
    baseRef: 'main',
    baseSha: 'base1',
    headSha: 'head1',
    includesWorkingTree: false,
    files: [],
    truncated: false,
    ...overrides,
  };
}

/**
 * A fake `filesFor`/`summary` pair driven by a mutable fixture the test can swap mid-run.
 * `state.summary` starts unset — a `send` test must set it before calling, same as `chat`
 * below, so a test that forgets fails loudly instead of resolving against a guessed default.
 */
function fakeDiffs(initial: FilesForFixture | null) {
  const state: {
    current: FilesForFixture | null;
    failWith: Error | null;
    summary: DiffSummaryResult | null;
  } = {
    current: initial,
    failWith: null,
    summary: null,
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
  const summary = async (): Promise<DiffSummaryResult> =>
    state.summary ?? unexercised('diffs.summary');
  return { filesFor, summary, calls, state };
}

/** Records every call so a test can assert how many times `chat` ran, and with what. */
function fakeChat(result: ChatSendResult | ((taskId: string, message: string) => ChatSendResult)) {
  const calls: Array<{ taskId: string; message: string }> = [];
  const chat: ReviewServiceDeps['chat'] = (taskId, message) => {
    calls.push({ taskId, message });
    return typeof result === 'function' ? result(taskId, message) : result;
  };
  return { chat, calls };
}

function makeService(
  opts: {
    comments?: ReviewComment[];
    knownTasks?: Set<string>;
    diffs?: ReturnType<typeof fakeDiffs>;
    chat?: ReviewServiceDeps['chat'];
  } = {},
) {
  const store = fakeStore(opts.comments ?? [], opts.knownTasks);
  const diffs = opts.diffs ?? fakeDiffs(null);
  const chat = opts.chat ?? (() => unexercised('chat'));
  const svc = new ReviewService({
    store,
    diffs: { filesFor: diffs.filesFor, summary: diffs.summary },
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

describe('review:send', () => {
  /** A `filesFor` fixture whose file matches `seedComment()`'s anchor exactly — `outdated: false`. */
  function matchingDiffs() {
    return fakeDiffs({
      diffId: 'diff-1',
      files: new Map([
        [
          'src/a.ts',
          { file: file([hunk([line({ text: 'const x = 1;', oldLine: 5, newLine: 5 })])]) },
        ],
      ]),
    });
  }

  function okSummary(overrides: Partial<DiffSummary> = {}): DiffSummaryResult {
    return { status: 'ok', summary: summaryFixture(overrides) };
  }

  it('on a running card, sends the formatted batch, stamps every draft, and returns the chat result', async () => {
    const seed = seedComment();
    const diffs = matchingDiffs();
    diffs.state.summary = okSummary();
    const chatResult = fakeChat({ status: 'sent', taskId: 't1', runId: 'run-1' });
    const { svc, store } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

    const result = await svc.send('t1', 'overall note');

    expect(chatResult.calls).toHaveLength(1);
    expect(chatResult.calls[0]).toEqual({
      taskId: 't1',
      message: formatReviewMessage(
        [{ ...seed, outdated: false }],
        summaryFixture(),
        'overall note',
      ),
    });
    expect(result).toEqual({
      status: 'sent',
      taskId: 't1',
      runId: 'run-1',
      comments: [{ ...seed, sentAt: expect.any(Number) }],
    });
    expect(store.listReviewComments('t1')[0].sentAt).not.toBeNull();
  });

  it('on a settled card, stamps the drafts and answers resumed', async () => {
    const seed = seedComment();
    const diffs = matchingDiffs();
    diffs.state.summary = okSummary();
    const chatResult = fakeChat({ status: 'resumed', taskId: 't1', runId: 'run-2' });
    const { svc, store } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

    const result = await svc.send('t1');

    expect(result.status).toBe('resumed');
    if (result.status !== 'resumed') throw new Error(result.status);
    expect(result.runId).toBe('run-2');
    expect(result.comments).toHaveLength(1);
    expect(store.listReviewComments('t1')[0].sentAt).not.toBeNull();
  });

  it.each(['never-ran', 'limit'] as const)(
    'passes a %s chat refusal straight through, stamping nothing',
    async (reason) => {
      const seed = seedComment();
      const diffs = matchingDiffs();
      diffs.state.summary = okSummary();
      const chatResult = fakeChat({ status: 'refused', taskId: 't1', reason });
      const { svc, store } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

      const result = await svc.send('t1');

      expect(result).toEqual({ status: 'refused', taskId: 't1', reason });
      expect(store.listReviewComments('t1')[0].sentAt).toBeNull();
      const listed = await svc.list('t1');
      expect(listed.every((c) => c.sentAt === null)).toBe(true);
    },
  );

  it('calls chat exactly once for two concurrent sends, the other refusing nothing-to-send', async () => {
    const seed = seedComment();
    const diffs = matchingDiffs();
    diffs.state.summary = okSummary();
    const chatResult = fakeChat({ status: 'sent', taskId: 't1', runId: 'run-3' });
    const { svc, store } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

    const [first, second] = await Promise.all([svc.send('t1'), svc.send('t1')]);

    expect(chatResult.calls).toHaveLength(1);
    const results = [first, second];
    const sent = results.find((r) => r.status === 'sent');
    const refused = results.find((r) => r.status === 'refused');
    if (!sent || sent.status !== 'sent') throw new Error('expected one sent result');
    if (!refused || refused.status !== 'refused') throw new Error('expected one refused result');
    expect(refused.reason).toBe('nothing-to-send');
    expect(sent.comments).toHaveLength(1);
    expect(store.listReviewComments('t1')[0].sentAt).not.toBeNull();
  });

  it('calls chat exactly once for two concurrent sends that both carry a note', async () => {
    const seed = seedComment();
    const diffs = matchingDiffs();
    diffs.state.summary = okSummary();
    const chatResult = fakeChat({ status: 'sent', taskId: 't1', runId: 'run-4' });
    const { svc } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

    await Promise.all([svc.send('t1', 'shared note'), svc.send('t1', 'shared note')]);

    expect(chatResult.calls).toHaveLength(1);
    expect(chatResult.calls[0].message).toContain('shared note');
  });

  it('does not quote an already-sent comment again', async () => {
    const already = seedComment({ id: 'c1', sentAt: 100, body: 'first note' });
    const draft = seedComment({
      id: 'c2',
      line: 9,
      excerpt: 'const y = 2;',
      body: 'second note',
    });
    const diffs = fakeDiffs({
      diffId: 'diff-1',
      files: new Map([
        [
          'src/a.ts',
          {
            file: file([
              hunk([
                line({ text: 'const x = 1;', oldLine: 5, newLine: 5 }),
                line({ text: 'const y = 2;', oldLine: 9, newLine: 9 }),
              ]),
            ]),
          },
        ],
      ]),
    });
    diffs.state.summary = okSummary();
    const chatResult = fakeChat({ status: 'sent', taskId: 't1', runId: 'run-5' });
    const { svc } = makeService({ comments: [already, draft], diffs, chat: chatResult.chat });

    await svc.send('t1');

    expect(chatResult.calls[0].message).toEqual(
      formatReviewMessage([{ ...draft, outdated: false }], summaryFixture(), undefined),
    );
    expect(chatResult.calls[0].message).toContain('second note');
    expect(chatResult.calls[0].message).not.toContain('first note');
  });

  it('sends an outdated draft with the outdated suffix', async () => {
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
    diffs.state.summary = okSummary();
    const chatResult = fakeChat({ status: 'sent', taskId: 't1', runId: 'run-6' });
    const { svc } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

    await svc.send('t1');

    expect(chatResult.calls[0].message).toContain('outdated');
    expect(chatResult.calls[0].message).toEqual(
      formatReviewMessage([{ ...seed, outdated: true }], summaryFixture(), undefined),
    );
  });

  it('refuses landed without calling chat', async () => {
    const seed = seedComment();
    const diffs = matchingDiffs();
    diffs.state.summary = { status: 'landed', forgeUrl: null };
    const chatResult = fakeChat({ status: 'sent', taskId: 't1', runId: 'run-7' });
    const { svc, store } = makeService({ comments: [seed], diffs, chat: chatResult.chat });

    const result = await svc.send('t1');

    expect(result).toEqual({ status: 'refused', taskId: 't1', reason: 'landed' });
    expect(chatResult.calls).toHaveLength(0);
    expect(store.listReviewComments('t1')[0].sentAt).toBeNull();
  });

  it('refuses unknown-task without touching diffs or chat', async () => {
    const { svc } = makeService({ knownTasks: new Set() });

    const result = await svc.send('t1');

    expect(result).toEqual({ status: 'refused', taskId: 't1', reason: 'unknown-task' });
  });
});
