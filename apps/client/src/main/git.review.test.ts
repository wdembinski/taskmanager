/**
 * Integration tests for the F6 patch-reading git helpers, run against a REAL temporary
 * repository — the same approach git.test.ts uses, since git is a system binary with no
 * Electron ABI split.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Every case here shells out to git several times in a temporary repository — the same
// slow-subprocess cost git.test.ts and worktreeManager.test.ts carry an explicit timeout
// for, and this file is seen crossing vitest's 5s default under a loaded parallel run too.
vi.setConfig({ testTimeout: 30_000 });
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatch } from '@shared/review';
import {
  blobSize,
  currentBranch,
  diffFilePatch,
  diffNameStatus,
  diffWorkingTree,
  git,
  mergeBase,
  parseNameStatusZ,
  parseNumstatZ,
  readWorkingFile,
  showBlob,
} from './git';

let repo = '';
let base = '';

async function commitFile(dir: string, name: string, content: string | Buffer, message: string) {
  writeFileSync(join(dir, name), content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--no-verify', '-m', message]);
}

async function headSha(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'orch-review-'));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await commitFile(
    repo,
    'a.txt',
    'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
    'initial',
  );
  base = await currentBranch(repo);
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('diffNameStatus / diffFilePatch — a commit-only diff', () => {
  it('finds the merge base, reports status and counts, and a patch with the right hunk line numbers', async () => {
    await git(repo, ['checkout', '-b', 'feature']);
    writeFileSync(
      join(repo, 'a.txt'),
      'line1\nCHANGED\nline3\nline4\nline5\nline6\nline7\nline8\n',
    );
    writeFileSync(join(repo, 'b.txt'), 'brand new\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', 'edit a, add b']);

    const mb = await mergeBase(repo, base, 'feature');
    expect(mb).toMatch(/^[0-9a-f]{40}$/);

    const entries = await diffNameStatus(repo, mb, 'feature');
    expect(entries.find((e) => e.path === 'a.txt')).toMatchObject({
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
    });
    expect(entries.find((e) => e.path === 'b.txt')).toMatchObject({
      status: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
    });

    const patch = await diffFilePatch(repo, { from: mb, to: 'feature', path: 'a.txt' });
    const [file] = parsePatch(patch ?? '');
    expect(file.status).toBe('modified');
    expect(file.hunks).toHaveLength(1);
    const removed = file.hunks[0].lines.find((l) => l.kind === 'del');
    const added = file.hunks[0].lines.find((l) => l.kind === 'add');
    expect(removed).toMatchObject({ text: 'line2', oldLine: 2 });
    expect(added).toMatchObject({ text: 'CHANGED', newLine: 2 });
  });
});

describe('diffWorkingTree — uncommitted edits', () => {
  it('is invisible to diffNameStatus but shows up in diffWorkingTree with counts and a patch', async () => {
    await git(repo, ['checkout', '-b', 'feature']);
    writeFileSync(join(repo, 'b.txt'), 'brand new\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', 'add b']);
    const mb = await mergeBase(repo, base, 'feature');

    // Uncommitted edit on a tracked file — not part of any commit yet.
    writeFileSync(
      join(repo, 'a.txt'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n',
    );

    const committedOnly = await diffNameStatus(repo, mb, 'feature');
    expect(committedOnly.find((e) => e.path === 'a.txt')).toBeUndefined();

    const working = await diffWorkingTree(repo, mb);
    expect(working.find((e) => e.path === 'a.txt')).toMatchObject({
      status: 'modified',
      additions: 1,
      deletions: 0,
      binary: false,
    });

    const patch = await diffFilePatch(repo, { from: mb, to: null, path: 'a.txt' });
    expect(patch).toContain('+line9');
  });
});

describe('diffWorkingTree — an untracked file', () => {
  it('lists it as added/untracked with counts, and its patch has newLine 1..n', async () => {
    writeFileSync(join(repo, 'c.txt'), 'x\ny\nz\n');

    const entries = await diffWorkingTree(repo, base);
    expect(entries.find((e) => e.path === 'c.txt')).toMatchObject({
      status: 'added',
      additions: 3,
      deletions: 0,
      binary: false,
      untracked: true,
    });

    const patch = await diffFilePatch(repo, { from: base, path: 'c.txt', untracked: true });
    const [file] = parsePatch(patch ?? '');
    expect(file.status).toBe('added');
    expect(file.hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
  });
});

describe('diffNameStatus / diffFilePatch — a rename', () => {
  it('reports renamed with oldPath, and the two-path pathspec patch parses as renamed too', async () => {
    await git(repo, ['checkout', '-b', 'feature']);
    await git(repo, ['mv', 'a.txt', 'renamed.txt']);
    writeFileSync(
      join(repo, 'renamed.txt'),
      'line1\nline2 edited\nline3\nline4\nline5\nline6\nline7\nline8\n',
    );
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', 'rename a, edit a line']);

    const mb = await mergeBase(repo, base, 'feature');
    const entries = await diffNameStatus(repo, mb, 'feature');
    expect(entries.find((e) => e.path === 'renamed.txt')).toMatchObject({
      status: 'renamed',
      oldPath: 'a.txt',
    });

    const patch = await diffFilePatch(repo, {
      from: mb,
      to: 'feature',
      path: 'renamed.txt',
      oldPath: 'a.txt',
    });
    const [file] = parsePatch(patch ?? '');
    expect(file.status).toBe('renamed');
    expect(file.oldPath).toBe('a.txt');
    expect(file.path).toBe('renamed.txt');
  });
});

describe('showBlob / blobSize / readWorkingFile — an image', () => {
  it('round-trips raw binary bytes through numstat, a committed blob, and an uncommitted overwrite', async () => {
    const original = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x01, 0x02,
    ]);
    const beforeSha = await headSha(repo);
    await commitFile(repo, 'img.png', original, 'add image');
    const afterSha = await headSha(repo);

    const entries = await diffNameStatus(repo, beforeSha, afterSha);
    expect(entries.find((e) => e.path === 'img.png')).toMatchObject({
      status: 'added',
      binary: true,
    });

    const blob = await showBlob(repo, afterSha, 'img.png');
    expect(blob).not.toBeNull();
    expect(blob!.equals(original)).toBe(true);

    expect(await blobSize(repo, afterSha, 'img.png')).toBe(original.length);

    const updated = Buffer.from([0x00, 0x11, 0x22, 0xee, 0x0d, 0x0a]);
    writeFileSync(join(repo, 'img.png'), updated);
    const fromDisk = readWorkingFile(repo, 'img.png');
    expect(fromDisk).not.toBeNull();
    expect(fromDisk!.equals(updated)).toBe(true);
  });
});

describe('parseNameStatusZ / parseNumstatZ — pure parsing of hand-written -z strings', () => {
  it('parseNameStatusZ reads a rename record', () => {
    expect(parseNameStatusZ('R100\0old.txt\0new.txt\0')).toEqual([
      { status: 'R100', path: 'new.txt', oldPath: 'old.txt' },
    ]);
  });

  it('parseNameStatusZ reads a path containing spaces', () => {
    expect(parseNameStatusZ('A\0path with spaces.txt\0')).toEqual([
      { status: 'A', path: 'path with spaces.txt' },
    ]);
  });

  it('parseNumstatZ reads a binary file record', () => {
    expect(parseNumstatZ('-\t-\tbinary.bin\0')).toEqual([
      { path: 'binary.bin', additions: 0, deletions: 0, binary: true },
    ]);
  });

  it('parseNumstatZ reads a rename record', () => {
    expect(parseNumstatZ('3\t1\t\0old.txt\0new.txt\0')).toEqual([
      { path: 'new.txt', oldPath: 'old.txt', additions: 3, deletions: 1, binary: false },
    ]);
  });

  it('parseNumstatZ reads a path containing spaces', () => {
    expect(parseNumstatZ('5\t0\tpath with spaces.txt\0')).toEqual([
      { path: 'path with spaces.txt', additions: 5, deletions: 0, binary: false },
    ]);
  });
});

describe('failure cases', () => {
  it('showBlob and blobSize report an unknown ref as null/-1', async () => {
    const unknownRef = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(await showBlob(repo, unknownRef, 'a.txt')).toBeNull();
    expect(await blobSize(repo, unknownRef, 'a.txt')).toBe(-1);
  });

  it('mergeBase of unrelated histories is empty', async () => {
    await git(repo, ['checkout', '--orphan', 'feat/orphan']);
    await git(repo, ['rm', '-rf', '--cached', '.']);
    await commitFile(repo, 'orphan.txt', 'orphan\n', 'orphan commit');
    expect(await mergeBase(repo, base, 'feat/orphan')).toBe('');
  });
});
