import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePatch, type DiffFileStatus, type DiffHunk } from './review';

/**
 * Fixtures under `__fixtures__/patches/` are real `git -c core.autocrlf=false diff --no-color
 * --no-ext-diff` output, captured in a scratch repo outside this worktree and checked in
 * `-text` (see that directory's `.gitattributes`) so CRLF content and trailing whitespace
 * survive checkout untouched. Commands used, run against the file(s) named:
 *
 *   modified-multi-hunk  git diff -- multi.txt            (two edits far enough apart for 2 hunks)
 *   added                git diff -- added.txt            (git add -N first, so it diffs as new)
 *   deleted              git diff -- deleted.txt          (single line, so "@@ -1 +0,0 @@" omits a count)
 *   renamed-edited       git diff -M --cached -- rename-src.txt rename-dst.txt
 *   renamed-pure         git diff -M --cached -- pure-src.txt pure-dst.txt      (git mv, no edit)
 *   copied               git diff -C --find-copies-harder --cached -- copy-src.txt copy-dst.txt
 *   no-newline           git diff -- nl-added.txt nl-removed.txt nl-both.txt
 *   binary               git diff -- image.bin
 *   binary-patch         git diff --binary -- image.bin
 *   empty-added          git diff -- empty.txt            (0-byte new file, git add -N first)
 *   crlf                 git diff -- crlf.txt             (file content is CRLF, one line edited)
 *   multi-file           git diff --cached -- mf-modified.txt mf-added.txt mf-mode.txt
 *                        (mf-mode.txt's mode flipped with `git update-index --chmod=+x`, no content change)
 *   quoted-path          git diff -- "café menu.txt"      (core.quotePath default: space + non-ASCII)
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'patches');

const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, `${name}.patch`), 'utf8');

/**
 * Every hunk's own invariant: del/context `oldLine` runs consecutively from `oldStart`, add/
 * context `newLine` runs consecutively from `newStart`, the counts seen match `oldLines`/
 * `newLines`, and a line never carries the line number of the side it doesn't belong to.
 */
function assertLineNumbers(hunk: DiffHunk): void {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let oldSeen = 0;
  let newSeen = 0;
  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      expect(line.oldLine).toBe(oldLine);
      expect(line.newLine).toBe(newLine);
      oldLine += 1;
      newLine += 1;
      oldSeen += 1;
      newSeen += 1;
    } else if (line.kind === 'del') {
      expect(line.oldLine).toBe(oldLine);
      expect(line.newLine).toBeUndefined();
      oldLine += 1;
      oldSeen += 1;
    } else {
      expect(line.newLine).toBe(newLine);
      expect(line.oldLine).toBeUndefined();
      newLine += 1;
      newSeen += 1;
    }
  }
  expect(oldSeen).toBe(hunk.oldLines);
  expect(newSeen).toBe(hunk.newLines);
}

interface ExpectedFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  hunkHeaders: string[];
}

describe('parsePatch — fixtures', () => {
  it.each<[string, ExpectedFile[]]>([
    [
      'modified-multi-hunk',
      [
        {
          path: 'multi.txt',
          status: 'modified',
          binary: false,
          hunkHeaders: ['@@ -3,6 +3,8 @@ line02', '@@ -17,7 +19,7 @@ line16'],
        },
      ],
    ],
    [
      'added',
      [{ path: 'added.txt', status: 'added', binary: false, hunkHeaders: ['@@ -0,0 +1,3 @@'] }],
    ],
    [
      // Single-line file: the old-side count is omitted ("@@ -1 +0,0 @@"), the one fixture
      // exercising the omitted-count-defaults-to-1 rule.
      'deleted',
      [{ path: 'deleted.txt', status: 'deleted', binary: false, hunkHeaders: ['@@ -1 +0,0 @@'] }],
    ],
    [
      'renamed-edited',
      [
        {
          path: 'rename-dst.txt',
          oldPath: 'rename-src.txt',
          status: 'renamed',
          binary: false,
          hunkHeaders: ['@@ -2,7 +2,7 @@ one'],
        },
      ],
    ],
    [
      'renamed-pure',
      [
        {
          path: 'pure-dst.txt',
          oldPath: 'pure-src.txt',
          status: 'renamed',
          binary: false,
          hunkHeaders: [],
        },
      ],
    ],
    [
      'copied',
      [
        {
          path: 'copy-dst.txt',
          oldPath: 'copy-src.txt',
          status: 'copied',
          binary: false,
          hunkHeaders: ['@@ -1,4 +1,4 @@'],
        },
      ],
    ],
    [
      'no-newline',
      [
        {
          path: 'nl-added.txt',
          status: 'modified',
          binary: false,
          hunkHeaders: ['@@ -1,2 +1,2 @@'],
        },
        {
          path: 'nl-both.txt',
          status: 'modified',
          binary: false,
          hunkHeaders: ['@@ -1,2 +1,2 @@'],
        },
        {
          path: 'nl-removed.txt',
          status: 'modified',
          binary: false,
          hunkHeaders: ['@@ -1,2 +1,2 @@'],
        },
      ],
    ],
    ['binary', [{ path: 'image.bin', status: 'modified', binary: true, hunkHeaders: [] }]],
    ['binary-patch', [{ path: 'image.bin', status: 'modified', binary: true, hunkHeaders: [] }]],
    ['empty-added', [{ path: 'empty.txt', status: 'added', binary: false, hunkHeaders: [] }]],
    [
      'crlf',
      [{ path: 'crlf.txt', status: 'modified', binary: false, hunkHeaders: ['@@ -1,3 +1,3 @@'] }],
    ],
    [
      'multi-file',
      [
        { path: 'mf-added.txt', status: 'added', binary: false, hunkHeaders: ['@@ -0,0 +1,2 @@'] },
        { path: 'mf-mode.txt', status: 'modified', binary: false, hunkHeaders: [] },
        {
          path: 'mf-modified.txt',
          status: 'modified',
          binary: false,
          hunkHeaders: ['@@ -1,3 +1,3 @@'],
        },
      ],
    ],
    [
      'quoted-path',
      [
        {
          path: 'café menu.txt',
          status: 'added',
          binary: false,
          hunkHeaders: ['@@ -0,0 +1,2 @@'],
        },
      ],
    ],
  ])('parses %s into the right PatchFile(s)', (name, expected) => {
    const files = parsePatch(fixture(name));
    expect(files).toHaveLength(expected.length);
    files.forEach((file, i) => {
      expect(file.path).toBe(expected[i].path);
      expect(file.oldPath).toBe(expected[i].oldPath);
      expect(file.status).toBe(expected[i].status);
      expect(file.binary).toBe(expected[i].binary);
      expect(file.hunks.map((h) => h.header)).toEqual(expected[i].hunkHeaders);
      file.hunks.forEach(assertLineNumbers);
    });
  });
});

describe('deleted — an omitted hunk count still defaults to 1, not 0', () => {
  it('reads the single deleted line rather than an empty hunk', () => {
    const [file] = parsePatch(fixture('deleted'));
    const [hunk] = file.hunks;
    expect(hunk.oldLines).toBe(1);
    expect(hunk.lines).toEqual([{ kind: 'del', text: 'alpha', oldLine: 1 }]);
  });
});

describe('modified-multi-hunk — exact line numbers around the second hunk', () => {
  const [file] = parsePatch(fixture('modified-multi-hunk'));
  const [, secondHunk] = file.hunks;

  it('numbers the deleted line and the line that replaces it independently', () => {
    const del = secondHunk.lines.find((l) => l.text === 'line20');
    const add = secondHunk.lines.find((l) => l.text === 'changed-line-20');
    expect(del).toMatchObject({ kind: 'del', oldLine: 20 });
    expect(del?.newLine).toBeUndefined();
    expect(add).toMatchObject({ kind: 'add', newLine: 22 });
    expect(add?.oldLine).toBeUndefined();
  });

  it('keeps counting context lines past the edit, offset by the earlier hunk’s insertion', () => {
    const lastContext = secondHunk.lines.find((l) => l.text === 'line23');
    expect(lastContext).toMatchObject({ kind: 'context', oldLine: 23, newLine: 25 });
  });
});

describe('no-newline — the marker lands on exactly the sides that lack a trailing newline', () => {
  const [added, both, removed] = parsePatch(fixture('no-newline'));

  it('newline added: only the old side lacked one', () => {
    const [, del, add] = added.hunks[0].lines;
    expect(del.noNewlineAtEof).toBe(true);
    expect(add.noNewlineAtEof).toBeUndefined();
  });

  it('newline removed: only the new side lacks one', () => {
    const [, del, add] = removed.hunks[0].lines;
    expect(del.noNewlineAtEof).toBeUndefined();
    expect(add.noNewlineAtEof).toBe(true);
  });

  it('missing on both sides: the marker appears after each', () => {
    const [, del, add] = both.hunks[0].lines;
    expect(del.noNewlineAtEof).toBe(true);
    expect(add.noNewlineAtEof).toBe(true);
  });
});

describe('crlf — DiffLine.text never carries a carriage return', () => {
  it('strips \\r from every hunk line, context and changed alike', () => {
    const [file] = parsePatch(fixture('crlf'));
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        expect(line.text).not.toContain('\r');
      }
    }
  });
});

describe('quoted-path — a quoted, non-ASCII, space-containing path is decoded', () => {
  it('decodes the octal escapes as UTF-8 and drops the a/ b/ prefix', () => {
    const [file] = parsePatch(fixture('quoted-path'));
    expect(file.path).toBe('café menu.txt');
  });
});

describe('copied — a hunk body is consumed by count, not by line prefix', () => {
  it('a context line starting "--" and an added line starting "++" are still ordinary lines', () => {
    const [file] = parsePatch(fixture('copied'));
    const [hunk] = file.hunks;
    expect(hunk.lines).toContainEqual(
      expect.objectContaining({ kind: 'context', text: '-- shared three' }),
    );
    expect(hunk.lines).toContainEqual(
      expect.objectContaining({ kind: 'add', text: '++ shared four boosted' }),
    );
  });
});

describe("parsePatch('')", () => {
  it('returns no files', () => {
    expect(parsePatch('')).toEqual([]);
  });
});
