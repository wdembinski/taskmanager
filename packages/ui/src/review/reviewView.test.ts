import { describe, expect, it } from 'vitest';
import type { DiffFileEntry, DiffLine, DiffSummary } from '@tm/shared/review';
import { DIFF_COLLAPSE_LINES } from '@tm/shared/review';
import { EMPTY_REVIEW, summaryArrived, summaryLoadStarted } from './reviewState';
import {
  buildFileTree,
  defaultExpanded,
  fetchablePaths,
  fileLoadNotice,
  pairWordDiffs,
  selectionLabel,
  statusLetter,
  summaryTotals,
  type FileTreeDir,
  type FileTreeFile,
} from './reviewView';

const entry = (path: string, overrides: Partial<DiffFileEntry> = {}): DiffFileEntry => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  image: false,
  bytes: 10,
  ...overrides,
});

const summary = (files: DiffFileEntry[]): DiffSummary => ({
  diffId: 'd1',
  baseRef: 'main',
  baseSha: 'base-sha',
  headSha: 'head-sha',
  includesWorkingTree: false,
  files,
  truncated: false,
});

const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

describe('buildFileTree', () => {
  it('collapses a chain of single-child directories into one node', () => {
    const tree = buildFileTree([entry('src/main/review/DiffView.tsx')]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as FileTreeDir;
    expect(dir.kind).toBe('dir');
    expect(dir.name).toBe('src/main/review');
    expect(dir.path).toBe('src/main/review');
    expect(dir.children).toHaveLength(1);
    expect((dir.children[0] as FileTreeFile).entry.path).toBe('src/main/review/DiffView.tsx');
  });

  it('stops collapsing at a directory with more than one entry', () => {
    const tree = buildFileTree([
      entry('src/main/review/DiffView.tsx'),
      entry('src/main/review/FileTree.tsx'),
    ]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as FileTreeDir;
    expect(dir.name).toBe('src/main/review');
    expect(dir.children).toHaveLength(2);
    expect(dir.children.every((c) => c.kind === 'file')).toBe(true);
  });

  it('sorts directories before files, each alphabetically', () => {
    const tree = buildFileTree([entry('z.ts'), entry('a.ts'), entry('m/one.ts')]);
    expect(tree.map((n) => n.kind)).toEqual(['dir', 'file', 'file']);
    expect(tree.map((n) => (n.kind === 'dir' ? n.name : n.entry.path))).toEqual([
      'm',
      'a.ts',
      'z.ts',
    ]);
  });

  it('gives a nested directory its full path once its ancestor chain collapsed too', () => {
    const tree = buildFileTree([
      entry('src/one/a.ts'),
      entry('src/one/two/three/b.ts'),
      entry('src/one/two/three/c.ts'),
    ]);
    const srcOne = tree[0] as FileTreeDir;
    expect(srcOne.name).toBe('src/one');
    expect(srcOne.path).toBe('src/one');
    const dirs = srcOne.children.filter((c): c is FileTreeDir => c.kind === 'dir');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].name).toBe('two/three');
    expect(dirs[0].path).toBe('src/one/two/three');
  });

  it('returns an empty tree for no entries', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('statusLetter', () => {
  it('maps every status to its letter', () => {
    expect(statusLetter('added')).toBe('A');
    expect(statusLetter('modified')).toBe('M');
    expect(statusLetter('deleted')).toBe('D');
    expect(statusLetter('renamed')).toBe('R');
    expect(statusLetter('copied')).toBe('C');
  });
});

describe('summaryTotals', () => {
  it('sums the file count and the additions and deletions', () => {
    const totals = summaryTotals(
      summary([
        entry('a.ts', { additions: 3, deletions: 1 }),
        entry('b.ts', { additions: 0, deletions: 5 }),
      ]),
    );
    expect(totals).toEqual({ files: 2, additions: 3, deletions: 6 });
  });

  it('is all zero for an empty summary', () => {
    expect(summaryTotals(summary([]))).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe('pairWordDiffs', () => {
  it('leaves context lines null', () => {
    const result = pairWordDiffs([line('context', 'same')]);
    expect(result).toEqual([null]);
  });

  it('pairs a single del/add run positionally', () => {
    const lines = [line('del', 'const foo = 1;'), line('add', 'const foo = 2;')];
    const result = pairWordDiffs(lines);
    expect(result[0]).not.toBeNull();
    expect(result[1]).not.toBeNull();
    expect(result[0]).toEqual([
      { kind: 'same', text: 'const foo = ' },
      { kind: 'del', text: '1' },
      { kind: 'same', text: ';' },
    ]);
    expect(result[1]).toEqual([
      { kind: 'same', text: 'const foo = ' },
      { kind: 'add', text: '2' },
      { kind: 'same', text: ';' },
    ]);
  });

  it('leaves the unmatched tail null when the runs have unequal counts', () => {
    const lines = [line('del', 'one'), line('del', 'two'), line('add', 'one!')];
    const result = pairWordDiffs(lines);
    expect(result[0]).not.toBeNull(); // 'one' -> 'one!' paired
    expect(result[1]).toBeNull(); // unmatched del, no add left to pair with
    expect(result[2]).not.toBeNull();
  });

  it('leaves both sides null when wordDiff gives up with wholeLine', () => {
    const lines = [line('del', 'abc'), line('add', 'completely different text altogether')];
    const result = pairWordDiffs(lines);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
  });

  it('pairs each of several consecutive del/add runs independently', () => {
    const lines = [
      line('del', 'const a = 1;'),
      line('add', 'const a = 2;'),
      line('context', 'unchanged'),
      line('del', 'const b = 1;'),
      line('add', 'const b = 2;'),
    ];
    const result = pairWordDiffs(lines);
    expect(result[2]).toBeNull();
    expect(result[0]).not.toBeNull();
    expect(result[3]).not.toBeNull();
  });
});

describe('defaultExpanded', () => {
  it('skips binary, image and collapsed-by-default files', () => {
    const paths = defaultExpanded(
      summary([
        entry('binary.png', { binary: true }),
        entry('image.jpg', { image: true }),
        entry('huge.ts', { additions: DIFF_COLLAPSE_LINES + 1, deletions: 0 }),
        entry('normal.ts'),
      ]),
    );
    expect(paths).toEqual(['normal.ts']);
  });

  it('respects the limit', () => {
    const files = Array.from({ length: 10 }, (_, i) => entry(`f${i}.ts`));
    expect(defaultExpanded(summary(files), 3)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
  });

  it('defaults the limit to 5', () => {
    const files = Array.from({ length: 10 }, (_, i) => entry(`f${i}.ts`));
    expect(defaultExpanded(summary(files))).toHaveLength(5);
  });
});

describe('fetchablePaths', () => {
  function summaryLoaded(files: DiffFileEntry[], expanded: string[]) {
    const started = summaryLoadStarted(EMPTY_REVIEW, 'task-1', 1);
    const arrived = summaryArrived(started, 'task-1', 1, { status: 'ok', summary: summary(files) });
    return { ...arrived, expanded };
  }

  it('is empty when the summary is not ok', () => {
    expect(fetchablePaths(EMPTY_REVIEW)).toEqual([]);
  });

  it('is the expanded paths that still need fetching, minus binary ones', () => {
    const state = summaryLoaded(
      [entry('a.ts'), entry('b.png', { binary: true })],
      ['a.ts', 'b.png'],
    );
    expect(fetchablePaths(state)).toEqual(['a.ts']);
  });

  it('excludes a path that already loaded', () => {
    const state = summaryLoaded([entry('a.ts'), entry('b.ts')], ['a.ts', 'b.ts']);
    const loaded = {
      ...state,
      files: {
        ...state.files,
        'a.ts': { status: 'loaded' as const, file: { diffId: 'd1', path: 'a.ts', hunks: [] } },
      },
    };
    expect(fetchablePaths(loaded)).toEqual(['b.ts']);
  });

  it('returns at most one path even with several expanded', () => {
    const state = summaryLoaded(
      [entry('a.ts'), entry('b.ts'), entry('c.ts')],
      ['a.ts', 'b.ts', 'c.ts'],
    );
    expect(fetchablePaths(state)).toEqual(['a.ts']);
  });

  it('returns nothing while any file is already loading', () => {
    const state = summaryLoaded([entry('a.ts'), entry('b.ts')], ['a.ts', 'b.ts']);
    const loading = {
      ...state,
      files: { ...state.files, 'a.ts': { status: 'loading' as const, seq: 1 } },
    };
    expect(fetchablePaths(loading)).toEqual([]);
  });
});

describe('fileLoadNotice', () => {
  it('is null while there is nothing to say: no load yet, loading, or loaded', () => {
    expect(fileLoadNotice(undefined)).toBeNull();
    expect(fileLoadNotice({ status: 'idle' })).toBeNull();
    expect(fileLoadNotice({ status: 'loading', seq: 1 })).toBeNull();
    expect(
      fileLoadNotice({ status: 'loaded', file: { diffId: 'd1', path: 'a.ts', hunks: [] } }),
    ).toBeNull();
  });

  it('names the error for an idle load that failed', () => {
    expect(fileLoadNotice({ status: 'idle', error: 'network error' })).toBe(
      "Couldn't load this file: network error",
    );
  });

  it('names the byte count for a file too large to show', () => {
    const notice = fileLoadNotice({ status: 'tooLarge', bytes: 999_999 });
    expect(notice).toContain('999,999 bytes');
    expect(notice).toContain('too large to show here');
  });

  it('points at reload for a stale file', () => {
    expect(fileLoadNotice({ status: 'stale', currentDiffId: 'd2' })).toContain('reload');
  });

  it('names the byte count and the desktop for a file too large to send over the relay', () => {
    const notice = fileLoadNotice({ status: 'tooLargeForBrowser', bytes: 5_000_000 });
    expect(notice).toBe(
      'This file is too large to send to the browser (5,000,000 bytes) — open it on the desktop.',
    );
  });
});

describe('selectionLabel', () => {
  it('labels a single line', () => {
    expect(selectionLabel({ path: 'a.ts', anchor: { side: 'new', line: 12 } })).toBe('Line 12');
  });

  it('labels a same-side range without naming the side', () => {
    const selection = {
      path: 'a.ts',
      start: { side: 'new' as const, line: 10 },
      anchor: { side: 'new' as const, line: 14 },
    };
    expect(selectionLabel(selection)).toBe('Lines 10–14');
  });

  it('names the side for each end of a range that spans old and new', () => {
    const selection = {
      path: 'a.ts',
      start: { side: 'old' as const, line: 10 },
      anchor: { side: 'new' as const, line: 14 },
    };
    expect(selectionLabel(selection)).toBe('Lines 10 (old)–14 (new)');
  });
});
