import { describe, expect, it } from 'vitest';
import {
  excerptFor,
  expandContext,
  pairWordDiffs,
  splitRows,
  viewedState,
  type DiffFile,
  type DiffFileEntry,
  type DiffHunk,
  type DiffLine,
  type ReviewViewedMark,
} from './review';

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
  return { diffId: 'diff-1', path: 'src/example.ts', hunks, ...overrides };
}

describe('splitRows', () => {
  it('pairs an uneven run of 3 dels + 1 add, padding the tail null on the right', () => {
    const lines = [
      line({ kind: 'del', text: 'a', oldLine: 1 }),
      line({ kind: 'del', text: 'b', oldLine: 2 }),
      line({ kind: 'del', text: 'c', oldLine: 3 }),
      line({ kind: 'add', text: 'x', newLine: 1 }),
    ];
    const [rows] = splitRows(file([hunk(lines, { oldLines: 3, newLines: 1 })]));

    expect(rows).toEqual([
      { left: lines[0], right: lines[3], leftIndex: 0, rightIndex: 3 },
      { left: lines[1], right: null, leftIndex: 1, rightIndex: null },
      { left: lines[2], right: null, leftIndex: 2, rightIndex: null },
    ]);
  });

  it('pairs an uneven run of 1 del + 3 adds, padding the tail null on the left', () => {
    const lines = [
      line({ kind: 'del', text: 'a', oldLine: 1 }),
      line({ kind: 'add', text: 'x', newLine: 1 }),
      line({ kind: 'add', text: 'y', newLine: 2 }),
      line({ kind: 'add', text: 'z', newLine: 3 }),
    ];
    const [rows] = splitRows(file([hunk(lines, { oldLines: 1, newLines: 3 })]));

    expect(rows).toEqual([
      { left: lines[0], right: lines[1], leftIndex: 0, rightIndex: 1 },
      { left: null, right: lines[2], leftIndex: null, rightIndex: 2 },
      { left: null, right: lines[3], leftIndex: null, rightIndex: 3 },
    ]);
  });

  it('fills a context row on both sides from the same line', () => {
    const lines = [line({ text: 'unchanged', oldLine: 5, newLine: 5 })];
    const [rows] = splitRows(file([hunk(lines)]));

    expect(rows).toEqual([{ left: lines[0], right: lines[0], leftIndex: 0, rightIndex: 0 }]);
  });

  it('gives a lone del run a blank right side for every row', () => {
    const lines = [
      line({ kind: 'del', text: 'a', oldLine: 1 }),
      line({ kind: 'del', text: 'b', oldLine: 2 }),
    ];
    const [rows] = splitRows(file([hunk(lines, { oldLines: 2, newLines: 0 })]));

    expect(rows).toEqual([
      { left: lines[0], right: null, leftIndex: 0, rightIndex: null },
      { left: lines[1], right: null, leftIndex: 1, rightIndex: null },
    ]);
  });

  it('gives every row of a pure-add file a blank left side', () => {
    const lines = [
      line({ kind: 'add', text: 'a', newLine: 1 }),
      line({ kind: 'add', text: 'b', newLine: 2 }),
      line({ kind: 'add', text: 'c', newLine: 3 }),
    ];
    const [rows] = splitRows(
      file([
        hunk(lines, {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          header: '@@ -0,0 +1,3 @@',
        }),
      ]),
    );

    expect(rows).toEqual([
      { left: null, right: lines[0], leftIndex: null, rightIndex: 0 },
      { left: null, right: lines[1], leftIndex: null, rightIndex: 1 },
      { left: null, right: lines[2], leftIndex: null, rightIndex: 2 },
    ]);
  });
});

describe('pairWordDiffs (re-exported from shared)', () => {
  it('pairs a single del/add run positionally', () => {
    const lines = [
      line({ kind: 'del', text: 'const a = 1;' }),
      line({ kind: 'add', text: 'const a = 2;' }),
    ];
    const result = pairWordDiffs(lines);

    expect(result[0]).toEqual([
      { kind: 'same', text: 'const a = ' },
      { kind: 'del', text: '1' },
      { kind: 'same', text: ';' },
    ]);
    expect(result[1]).toEqual([
      { kind: 'same', text: 'const a = ' },
      { kind: 'add', text: '2' },
      { kind: 'same', text: ';' },
    ]);
  });
});

describe('expandContext', () => {
  it('file start: prepends lines 1-4 with oldLine === newLine, starting the hunk at 1', () => {
    const nextLines = [line({ kind: 'del', text: 'old5', oldLine: 5 })];
    const f = file([hunk(nextLines, { oldStart: 5, oldLines: 3, newStart: 5, newLines: 4 })]);

    const result = expandContext(f, 0, { start: 1, text: ['line1', 'line2', 'line3', 'line4'] });

    expect(result.hunks).toHaveLength(1);
    const [extended] = result.hunks;
    expect(extended.lines.slice(0, 4)).toEqual([
      { kind: 'context', text: 'line1', newLine: 1, oldLine: 1 },
      { kind: 'context', text: 'line2', newLine: 2, oldLine: 2 },
      { kind: 'context', text: 'line3', newLine: 3, oldLine: 3 },
      { kind: 'context', text: 'line4', newLine: 4, oldLine: 4 },
    ]);
    expect(extended.oldStart).toBe(1);
    expect(extended.newStart).toBe(1);
  });

  it('between hunks with an offset: expanding part of the gap shows both numbers', () => {
    const prevLines = [
      line({ text: 'ctx1', oldLine: 1, newLine: 1 }),
      line({ kind: 'add', text: 'added', newLine: 2 }),
    ];
    const nextLines = [line({ kind: 'del', text: 'old5', oldLine: 5 })];
    const f = file([
      hunk(prevLines, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }),
      hunk(nextLines, { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1 }),
    ]);

    const result = expandContext(f, 1, { start: 4, text: ['line4'] });

    expect(result.hunks).toHaveLength(3);
    const [, middle] = result.hunks;
    expect(middle.lines).toEqual([{ kind: 'context', text: 'line4', newLine: 4, oldLine: 3 }]);
  });

  it('between hunks with an offset: filling the whole gap merges the two hunks into one', () => {
    const prevLines = [
      line({ text: 'ctx1', oldLine: 1, newLine: 1 }),
      line({ kind: 'add', text: 'added', newLine: 2 }),
    ];
    const nextLines = [line({ kind: 'del', text: 'old5', oldLine: 5 })];
    const f = file([
      hunk(prevLines, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }),
      hunk(nextLines, { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1 }),
    ]);

    const result = expandContext(f, 1, { start: 3, text: ['line3', 'line4', 'line5'] });

    expect(result.hunks).toHaveLength(1);
    const [merged] = result.hunks;
    expect(merged.lines).toEqual([
      ...prevLines,
      { kind: 'context', text: 'line3', newLine: 3, oldLine: 2 },
      { kind: 'context', text: 'line4', newLine: 4, oldLine: 3 },
      { kind: 'context', text: 'line5', newLine: 5, oldLine: 4 },
      ...nextLines,
    ]);
  });

  it('file end: numbers continue from oldEnd/newEnd', () => {
    const prevLines = [
      line({ text: 'ctx1', oldLine: 1, newLine: 1 }),
      line({ kind: 'add', text: 'added', newLine: 2 }),
    ];
    const f = file([hunk(prevLines, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 })]);

    const result = expandContext(f, 1, { start: 3, text: ['line3', 'line4'] });

    expect(result.hunks).toHaveLength(1);
    const [extended] = result.hunks;
    expect(extended.lines.slice(2)).toEqual([
      { kind: 'context', text: 'line3', newLine: 3, oldLine: 2 },
      { kind: 'context', text: 'line4', newLine: 4, oldLine: 3 },
    ]);
  });

  it('clipping: lines overlapping a neighbouring hunk are dropped', () => {
    const prevLines = [
      line({ text: 'ctx1', oldLine: 1, newLine: 1 }),
      line({ kind: 'add', text: 'added', newLine: 2 }),
    ];
    const nextLines = [line({ kind: 'del', text: 'old5', oldLine: 5 })];
    const f = file([
      hunk(prevLines, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }),
      hunk(nextLines, { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1 }),
    ]);

    // the gap is new-side [3, 6); lines 2 and 6 overlap the neighbouring hunks and are dropped.
    const result = expandContext(f, 1, {
      start: 2,
      text: ['line2', 'line3', 'line4', 'line5', 'line6'],
    });

    expect(result.hunks).toHaveLength(1);
    const [merged] = result.hunks;
    expect(merged.lines.map((l) => l.text)).toEqual([
      'ctx1',
      'added',
      'line3',
      'line4',
      'line5',
      'old5',
    ]);
  });

  it('a pure-delete hunk neighbour uses the zero-count convention', () => {
    const deleteLines = [
      line({ kind: 'del', text: 'old5', oldLine: 5 }),
      line({ kind: 'del', text: 'old6', oldLine: 6 }),
      line({ kind: 'del', text: 'old7', oldLine: 7 }),
    ];
    const f = file([hunk(deleteLines, { oldStart: 5, oldLines: 3, newStart: 4, newLines: 0 })]);

    const result = expandContext(f, 1, { start: 5, text: ['line5'] });

    expect(result.hunks).toHaveLength(1);
    const [extended] = result.hunks;
    expect(extended.lines.at(-1)).toEqual({
      kind: 'context',
      text: 'line5',
      newLine: 5,
      oldLine: 8,
    });
  });

  it('a non-adjacent chunk becomes its own hunk', () => {
    const prevLines = [
      line({ text: 'ctx1', oldLine: 1, newLine: 1 }),
      line({ kind: 'add', text: 'added', newLine: 2 }),
    ];
    const nextLines = [line({ kind: 'del', text: 'old5', oldLine: 5 })];
    const f = file([
      hunk(prevLines, { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }),
      hunk(nextLines, { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1 }),
    ]);

    const result = expandContext(f, 1, { start: 4, text: ['line4'] });

    expect(result.hunks).toHaveLength(3);
    const [first, standalone, last] = result.hunks;
    expect(first).toBe(f.hunks[0]);
    expect(last).toBe(f.hunks[1]);
    expect(standalone.header).toBe('@@ -3,1 +4,1 @@');
  });

  it('does not mutate its input', () => {
    const prevLines = [line({ text: 'ctx1', oldLine: 1, newLine: 1 })];
    const original = Object.freeze(hunk(prevLines, { oldLines: 1, newLines: 1 })) as DiffHunk;
    const input = Object.freeze(file([original])) as DiffFile;

    const result = expandContext(input, 1, { start: 2, text: ['line2'] });

    expect(result).not.toBe(input);
    expect(input.hunks).toEqual([original]);
    expect(original.lines).toEqual(prevLines);
  });
});

describe('excerptFor on an expanded line', () => {
  function expandedFile(): DiffFile {
    const nextLines = [
      line({ kind: 'del', text: 'old3', oldLine: 3 }),
      line({ kind: 'add', text: 'new3', newLine: 3 }),
    ];
    const f = file([hunk(nextLines, { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 })]);
    return expandContext(f, 0, { start: 1, text: ['line1', 'line2'] });
  }

  it('anchors { side: "new", line: 2 } on an expanded row to its text', () => {
    expect(excerptFor(expandedFile(), { side: 'new', line: 2 })).toBe('line2');
  });

  it('anchors { side: "old", line: 2 } on an expanded row to its text', () => {
    expect(excerptFor(expandedFile(), { side: 'old', line: 2 })).toBe('line2');
  });

  it('resolves a range from an expanded row into a hunk line', () => {
    const result = excerptFor(expandedFile(), {
      side: 'new',
      line: 3,
      start: { side: 'new', line: 2 },
    });

    expect(result).toBe('line2\nold3\nnew3');
  });
});

describe('viewedState', () => {
  function entry(path: string, overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
    return {
      path,
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      image: false,
      bytes: 10,
      ...overrides,
    };
  }

  function mark(path: string, overrides: Partial<ReviewViewedMark> = {}): ReviewViewedMark {
    return { subjectId: 'task:1', path, blobSha: 'sha-a', viewedAt: 0, ...overrides };
  }

  it('gives a matching SHA viewed, and counts it', () => {
    const entries = [entry('a.ts', { newBlobSha: 'sha-a' })];
    const marks = [mark('a.ts', { blobSha: 'sha-a' })];

    const result = viewedState(entries, marks);

    expect(result.byPath).toEqual({ 'a.ts': 'viewed' });
    expect(result.viewedCount).toBe(1);
  });

  it('gives a new blob SHA changed, and does not count it', () => {
    const entries = [entry('a.ts', { newBlobSha: 'sha-b' })];
    const marks = [mark('a.ts', { blobSha: 'sha-a' })];

    const result = viewedState(entries, marks);

    expect(result.byPath).toEqual({ 'a.ts': 'changed' });
    expect(result.viewedCount).toBe(0);
  });

  it('gives an entry with no newBlobSha unviewed', () => {
    const entries = [entry('a.ts', { newBlobSha: undefined })];

    const result = viewedState(entries, []);

    expect(result.byPath).toEqual({ 'a.ts': 'unviewed' });
    expect(result.viewedCount).toBe(0);
  });

  it('gives an unmarked file unviewed', () => {
    const entries = [entry('a.ts', { newBlobSha: 'sha-a' })];

    const result = viewedState(entries, []);

    expect(result.byPath).toEqual({ 'a.ts': 'unviewed' });
    expect(result.viewedCount).toBe(0);
  });

  it('ignores a stray mark for a path not in entries', () => {
    const entries = [entry('a.ts', { newBlobSha: 'sha-a' })];
    const marks = [mark('a.ts', { blobSha: 'sha-a' }), mark('stray.ts', { blobSha: 'sha-a' })];

    const result = viewedState(entries, marks);

    expect(result.byPath).toEqual({ 'a.ts': 'viewed' });
    expect(result.viewedCount).toBe(1);
  });

  it('computes viewedCount correctly across a mix of statuses', () => {
    const entries = [
      entry('viewed.ts', { newBlobSha: 'sha-a' }),
      entry('changed.ts', { newBlobSha: 'sha-b' }),
      entry('unviewed.ts', { newBlobSha: 'sha-a' }),
      entry('untracked.ts', { newBlobSha: undefined }),
    ];
    const marks = [
      mark('viewed.ts', { blobSha: 'sha-a' }),
      mark('changed.ts', { blobSha: 'sha-a' }),
    ];

    const result = viewedState(entries, marks);

    expect(result.byPath).toEqual({
      'viewed.ts': 'viewed',
      'changed.ts': 'changed',
      'unviewed.ts': 'unviewed',
      'untracked.ts': 'unviewed',
    });
    expect(result.viewedCount).toBe(1);
  });
});
