/**
 * `DiffService` against a fake git: every result variant the three channels can answer, and
 * each cap. The real git bindings are covered by `git.review.test.ts`; what is tested here is
 * the resolution (worktree vs branch vs landed), the `diffId`, and where the caps bite.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@shared/model';
import type { MergeRequest } from '@shared/mergeRequest';
import {
  DIFF_FILE_MAX_BYTES,
  DIFF_IMAGE_MAX_BYTES,
  DIFF_SUMMARY_MAX_FILES,
  isCollapsedByDefault,
} from '@shared/review';
import type { NameStatusEntry } from '../git';
import {
  base64Length,
  computeDiffId,
  DiffService,
  imageMimeOf,
  type DiffGit,
  type DiffServiceDeps,
} from './diffService';

const WT = '/wt/card';
const REPO = '/repo';
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'h'.repeat(40);

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  '',
].join('\n');

interface FakeState {
  live: boolean;
  conflicted: string[];
  rebasing: boolean;
  fingerprint: string;
  branchExists: boolean;
  headSha: string;
  mergeBase: string;
  currentBranch: string;
  entries: NameStatusEntry[];
  patch: string | null;
  sizes: Record<string, number>;
  blobs: Record<string, Buffer>;
}

function fakeState(over: Partial<FakeState> = {}): FakeState {
  return {
    live: true,
    conflicted: [],
    rebasing: false,
    fingerprint: '',
    branchExists: true,
    headSha: HEAD_SHA,
    mergeBase: BASE_SHA,
    currentBranch: 'main',
    entries: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, binary: false }],
    patch: PATCH,
    sizes: { 'src/a.ts': 42 },
    blobs: {},
    ...over,
  };
}

/** A recording fake: `calls` says which side (work tree or a ref) each read went to. */
function fakeGit(s: FakeState): DiffGit & { calls: string[] } {
  const calls: string[] = [];
  const key = (ref: string | null, path: string) => `${ref ?? 'WORK'}:${path}`;
  return {
    calls,
    revParse: async () => s.headSha,
    branchExists: async () => s.branchExists,
    currentBranch: async () => s.currentBranch,
    mergeBase: async () => s.mergeBase,
    rebaseInProgress: async () => s.rebasing,
    conflictedFiles: async () => s.conflicted,
    workingTreeFingerprint: async () => s.fingerprint,
    nameStatus: async (dir, from, to) => {
      calls.push(`nameStatus ${dir} ${from}..${to}`);
      return s.entries;
    },
    workingTree: async (dir, from) => {
      calls.push(`workingTree ${dir} ${from}`);
      return s.entries;
    },
    filePatch: async (dir, req) => {
      calls.push(`filePatch ${dir} ${JSON.stringify(req)}`);
      return s.patch;
    },
    fileSizes: async (_dir, ref, paths) =>
      new Map(paths.map((p) => [p, s.sizes[key(ref, p)] ?? s.sizes[p] ?? 0])),
    fileSize: async (_dir, ref, path) => s.blobs[key(ref, path)]?.length ?? -1,
    readFile: async (_dir, ref, path) => {
      calls.push(`readFile ${key(ref, path)}`);
      return s.blobs[key(ref, path)] ?? null;
    },
  };
}

const project = {
  id: 'p1',
  path: REPO,
  useWorktrees: true,
  baseBranch: 'main',
  target: { kind: 'local' },
} as unknown as Project;

function card(over: Partial<Task> = {}): Task {
  return { id: 't1', projectId: 'p1', agentBranch: 'feat/x', ...over } as unknown as Task;
}

function service(
  s: FakeState,
  opts: { task?: Task; mrs?: MergeRequest[]; project?: Project } = {},
): { svc: DiffService; g: ReturnType<typeof fakeGit> } {
  const g = fakeGit(s);
  const task = opts.task ?? card();
  const deps: DiffServiceDeps = {
    getTask: (id) => (id === task.id ? task : undefined),
    getProject: (id) => (id === 'p1' ? (opts.project ?? project) : undefined),
    inspect: async () => (s.live ? { cwd: WT, branch: 'feat/x', base: 'main' } : null),
    gitFor: () => g,
    listMergeRequests: () => opts.mrs ?? [],
  };
  return { svc: new DiffService(deps), g };
}

async function okSummary(svc: DiffService) {
  const res = await svc.summary('t1');
  if (res.status !== 'ok') throw new Error(`expected ok, got ${res.status}`);
  return res.summary;
}

describe('task:diffSummary', () => {
  it('diffs the live worktree from the merge base, uncommitted work included', async () => {
    const s = fakeState({ fingerprint: 'dirty' });
    const { svc, g } = service(s);
    const summary = await okSummary(svc);
    expect(summary).toMatchObject({
      baseRef: 'main',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      includesWorkingTree: true,
      truncated: false,
      diffId: computeDiffId(BASE_SHA, HEAD_SHA, 'dirty'),
    });
    expect(summary.files).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        image: false,
        bytes: 42,
      },
    ]);
    expect(g.calls).toContain(`workingTree ${WT} ${BASE_SHA}`);
  });

  it('falls back to the branch in the project repo when the worktree is gone', async () => {
    const { svc, g } = service(fakeState({ live: false }));
    const summary = await okSummary(svc);
    expect(summary.includesWorkingTree).toBe(false);
    expect(summary.diffId).toBe(computeDiffId(BASE_SHA, HEAD_SHA, ''));
    expect(g.calls).toContain(`nameStatus ${REPO} ${BASE_SHA}..${HEAD_SHA}`);
  });

  it('reports the old side size for a deleted file and carries oldPath for a rename', async () => {
    const s = fakeState({
      entries: [
        { path: 'gone.ts', status: 'deleted', additions: 0, deletions: 3, binary: false },
        {
          path: 'new.ts',
          oldPath: 'old.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          binary: false,
        },
        { path: 'logo.png', status: 'added', additions: 0, deletions: 0, binary: true },
      ],
      sizes: { [`${BASE_SHA}:gone.ts`]: 7, 'WORK:new.ts': 9, 'WORK:logo.png': 100 },
    });
    const summary = await okSummary(service(s).svc);
    expect(summary.files.map((f) => [f.path, f.oldPath, f.bytes, f.image])).toEqual([
      ['gone.ts', undefined, 7, false],
      ['new.ts', 'old.ts', 9, false],
      ['logo.png', undefined, 100, true],
    ]);
  });

  it(`lists at most ${DIFF_SUMMARY_MAX_FILES} files and says it truncated`, async () => {
    const entries = Array.from({ length: DIFF_SUMMARY_MAX_FILES + 5 }, (_, i): NameStatusEntry => ({
      path: `f${i}.txt`,
      status: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const summary = await okSummary(service(fakeState({ entries })).svc);
    expect(summary.files).toHaveLength(DIFF_SUMMARY_MAX_FILES);
    expect(summary.truncated).toBe(true);
  });

  it('is not truncated at exactly the cap', async () => {
    const entries = Array.from({ length: DIFF_SUMMARY_MAX_FILES }, (_, i): NameStatusEntry => ({
      path: `f${i}.txt`,
      status: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const summary = await okSummary(service(fakeState({ entries })).svc);
    expect(summary.truncated).toBe(false);
  });

  it('answers conflicted with the unmerged paths, without diffing', async () => {
    const { svc, g } = service(fakeState({ conflicted: ['src/a.ts'] }));
    expect(await svc.summary('t1')).toEqual({ status: 'conflicted', files: ['src/a.ts'] });
    expect(g.calls).toEqual([]);
  });

  it('answers conflicted for a paused rebase even with no unmerged path', async () => {
    const { svc } = service(fakeState({ rebasing: true }));
    expect(await svc.summary('t1')).toEqual({ status: 'conflicted', files: [] });
  });

  it('answers landed, with the merged MR link, when the work merged and its worktree is gone', async () => {
    const mrs = [
      { taskId: 't1', state: 'closed', webUrl: 'https://x/1' },
      { taskId: 't1', state: 'merged', webUrl: 'https://x/2' },
      { taskId: 'other', state: 'merged', webUrl: 'https://x/3' },
    ] as MergeRequest[];
    const { svc } = service(fakeState({ live: false }), { task: card({ landedAt: 1 }), mrs });
    expect(await svc.summary('t1')).toEqual({ status: 'landed', forgeUrl: 'https://x/2' });
  });

  it('answers landed with no link when there is no forge', async () => {
    const { svc } = service(fakeState({ live: false }), { task: card({ landedAt: 1 }) });
    expect(await svc.summary('t1')).toEqual({ status: 'landed', forgeUrl: null });
  });

  it('answers no-branch when the card never produced one', async () => {
    const { svc } = service(fakeState({ live: false, branchExists: false }));
    expect(await svc.summary('t1')).toEqual({ status: 'no-branch' });
  });

  it('answers no-branch, not a git error, when the base cannot be read', async () => {
    const { svc } = service(fakeState({ mergeBase: '' }));
    expect(await svc.summary('t1')).toEqual({ status: 'no-branch' });
  });

  it('answers no-branch for a project with no repo', async () => {
    const { svc } = service(fakeState(), {
      project: { ...project, path: '' } as Project,
    });
    expect(await svc.summary('t1')).toEqual({ status: 'no-branch' });
  });

  it("reads a step's diff from its parent's worktree", async () => {
    const parent = card({ id: 'parent', agentBranch: 'feat/parent' });
    const step = card({ id: 't1', parentTaskId: 'parent', agentBranch: null });
    const g = fakeGit(fakeState());
    const asked: string[] = [];
    const svc = new DiffService({
      getTask: (id) => (id === 'parent' ? parent : id === 't1' ? step : undefined),
      getProject: () => project,
      inspect: async (_p, owner, branch) => {
        asked.push(`${owner} ${branch}`);
        return { cwd: WT, branch: 'feat/parent', base: 'main' };
      },
      gitFor: () => g,
      listMergeRequests: () => [],
    });
    await okSummary(svc);
    expect(asked).toEqual(['parent feat/parent']);
  });

  it('rejects a card that no longer exists', async () => {
    await expect(service(fakeState()).svc.summary('nope')).rejects.toThrow(/no longer/);
  });
});

describe('task:diffFile', () => {
  async function currentId(s: FakeState): Promise<string> {
    return (await okSummary(service(s).svc)).diffId;
  }

  it("parses the file's hunks for the diff the human loaded", async () => {
    const s = fakeState();
    const { svc, g } = service(s);
    const res = await svc.file('t1', await currentId(s), 'src/a.ts');
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.file.tooLarge).toBeUndefined();
    expect(res.file.hunks).toHaveLength(1);
    expect(res.file.hunks[0].lines.map((l) => l.kind)).toEqual(['context', 'del', 'add']);
    expect(g.calls.find((c) => c.startsWith('filePatch'))).toContain('"to":null');
  });

  it('passes a rename and an untracked file through to the patch read', async () => {
    const s = fakeState({
      entries: [
        {
          path: 'new.ts',
          oldPath: 'old.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          binary: false,
        },
        {
          path: 'scratch.ts',
          status: 'added',
          additions: 1,
          deletions: 0,
          binary: false,
          untracked: true,
        },
      ],
    });
    const { svc, g } = service(s);
    const id = await currentId(s);
    await svc.file('t1', id, 'new.ts');
    await svc.file('t1', id, 'scratch.ts');
    const reads = g.calls.filter((c) => c.startsWith('filePatch'));
    expect(reads[0]).toContain('"oldPath":"old.ts"');
    expect(reads[1]).toContain('"untracked":true');
  });

  it('answers stale when the worktree moved on since the summary', async () => {
    const s = fakeState({ fingerprint: 'before' });
    const id = await currentId(s);
    s.fingerprint = 'after';
    const { svc, g } = service(s);
    expect(await svc.file('t1', id, 'src/a.ts')).toEqual({
      status: 'stale',
      diffId: id,
      currentDiffId: computeDiffId(BASE_SHA, HEAD_SHA, 'after'),
    });
    expect(g.calls).toEqual([]);
  });

  it('answers stale with no current id once the card has landed', async () => {
    const s = fakeState();
    const id = await currentId(s);
    const { svc } = service(fakeState({ live: false }), { task: card({ landedAt: 1 }) });
    expect(await svc.file('t1', id, 'src/a.ts')).toEqual({
      status: 'stale',
      diffId: id,
      currentDiffId: '',
    });
  });

  it(`answers tooLarge with no hunks above ${DIFF_FILE_MAX_BYTES} bytes`, async () => {
    const big = `${PATCH}${'+x'.padEnd(DIFF_FILE_MAX_BYTES, 'x')}\n`;
    const s = fakeState({ patch: big });
    const res = await service(s).svc.file('t1', await currentId(s), 'src/a.ts');
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.file.hunks).toEqual([]);
    expect(res.file.tooLarge).toEqual({ bytes: Buffer.byteLength(big) });
  });

  it('keeps a patch of exactly the cap', async () => {
    const exact = PATCH.padEnd(DIFF_FILE_MAX_BYTES, '\n');
    const s = fakeState({ patch: exact });
    const res = await service(s).svc.file('t1', await currentId(s), 'src/a.ts');
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.file.tooLarge).toBeUndefined();
    expect(res.file.hunks).toHaveLength(1);
  });

  it('rejects a path that is not in the diff', async () => {
    const s = fakeState();
    await expect(service(s).svc.file('t1', await currentId(s), 'nope.ts')).rejects.toThrow(
      /not part of/,
    );
  });

  it('rejects when git cannot produce the patch', async () => {
    const s = fakeState({ patch: null });
    await expect(service(s).svc.file('t1', await currentId(s), 'src/a.ts')).rejects.toThrow(
      /Couldn't read/,
    );
  });
});

describe('task:diffImage', () => {
  const png = (n: number) => Buffer.alloc(n, 7);
  const imageEntry = (over: Partial<NameStatusEntry> = {}): NameStatusEntry => ({
    path: 'logo.png',
    status: 'modified',
    additions: 0,
    deletions: 0,
    binary: true,
    ...over,
  });

  async function image(s: FakeState) {
    const { svc, g } = service(s);
    const { diffId } = await okSummary(svc);
    const res = await svc.image('t1', diffId, s.entries[0].path);
    if (res.status !== 'ok') throw new Error(res.status);
    return { image: res.image, g };
  }

  it('returns both sides base64: the merge base, and the work tree', async () => {
    const { image: img } = await image(
      fakeState({
        entries: [imageEntry()],
        blobs: { [`${BASE_SHA}:logo.png`]: png(10), 'WORK:logo.png': png(20) },
      }),
    );
    expect(img.old).toEqual({ bytes: 10, mime: 'image/png', base64: png(10).toString('base64') });
    expect(img.new).toEqual({ bytes: 20, mime: 'image/png', base64: png(20).toString('base64') });
  });

  it('reads the new side from the branch tip when there is no worktree', async () => {
    const { image: img } = await image(
      fakeState({
        live: false,
        entries: [imageEntry({ status: 'added' })],
        blobs: { [`${HEAD_SHA}:logo.png`]: png(5) },
      }),
    );
    expect(img.old).toBeNull();
    expect(img.new).toMatchObject({ bytes: 5 });
  });

  it('reads a renamed image from its old path, and has no new side for a deletion', async () => {
    const renamed = await image(
      fakeState({
        entries: [imageEntry({ path: 'b.png', oldPath: 'a.png', status: 'renamed' })],
        blobs: { [`${BASE_SHA}:a.png`]: png(3), 'WORK:b.png': png(3) },
      }),
    );
    expect(renamed.image.old).toMatchObject({ bytes: 3 });
    const deleted = await image(
      fakeState({
        entries: [imageEntry({ status: 'deleted' })],
        blobs: { [`${BASE_SHA}:logo.png`]: png(3) },
      }),
    );
    expect(deleted.image.new).toBeNull();
  });

  it(`marks a side tooLarge above ${DIFF_IMAGE_MAX_BYTES} base64 bytes, without reading it`, async () => {
    // The largest raw size that still fits, and one byte more.
    const fits = (DIFF_IMAGE_MAX_BYTES / 4) * 3;
    expect(base64Length(fits)).toBe(DIFF_IMAGE_MAX_BYTES);
    const { image: img, g } = await image(
      fakeState({
        entries: [imageEntry()],
        blobs: { [`${BASE_SHA}:logo.png`]: png(fits), 'WORK:logo.png': png(fits + 1) },
      }),
    );
    expect(img.old).toMatchObject({ bytes: fits, mime: 'image/png' });
    expect(img.new).toEqual({ bytes: fits + 1, tooLarge: true });
    expect(g.calls).not.toContain('readFile WORK:logo.png');
  });

  it('answers stale like a file read', async () => {
    const s = fakeState({ entries: [imageEntry()] });
    const { svc } = service(s);
    expect(await svc.image('t1', 'old-id', 'logo.png')).toMatchObject({ status: 'stale' });
  });

  it('rejects a file that is not an image', async () => {
    const s = fakeState();
    const { svc } = service(s);
    const { diffId } = await okSummary(svc);
    await expect(svc.image('t1', diffId, 'src/a.ts')).rejects.toThrow(/not an image/);
  });
});

describe('helpers', () => {
  it('knows image types by extension, case-insensitively', () => {
    expect(imageMimeOf('a/B.PNG')).toBe('image/png');
    expect(imageMimeOf('x.jpeg')).toBe('image/jpeg');
    expect(imageMimeOf('x.ts')).toBeNull();
    expect(imageMimeOf('Makefile')).toBeNull();
  });

  it('gives a diffId that changes with each of its three inputs', () => {
    const id = computeDiffId('a', 'b', 'c');
    expect(id).toHaveLength(12);
    expect(computeDiffId('a', 'b', 'c')).toBe(id);
    expect(
      new Set([
        id,
        computeDiffId('x', 'b', 'c'),
        computeDiffId('a', 'x', 'c'),
        computeDiffId('a', 'b', 'x'),
      ]).size,
    ).toBe(4);
  });

  it('collapses a large lock or generated file, not a large source file', () => {
    expect(isCollapsedByDefault({ path: 'pnpm-lock.yaml', additions: 2001, deletions: 0 })).toBe(
      true,
    );
    expect(isCollapsedByDefault({ path: 'pnpm-lock.yaml', additions: 1000, deletions: 1000 })).toBe(
      false,
    );
    expect(isCollapsedByDefault({ path: 'web/dist/app.js', additions: 3000, deletions: 0 })).toBe(
      true,
    );
    expect(isCollapsedByDefault({ path: 'src/big.ts', additions: 5000, deletions: 0 })).toBe(false);
  });
});
