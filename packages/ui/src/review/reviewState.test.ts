import { describe, expect, it } from 'vitest';
import type {
  DiffFile,
  DiffFileEntry,
  DiffHunk,
  DiffSummaryResult,
  ReviewComment,
} from '@tm/shared/review';
import { DIFF_COLLAPSE_LINES } from '@tm/shared/review';
import {
  EMPTY_REVIEW,
  clickLine,
  closeEditor,
  editDraft,
  fileArrived,
  fileFailed,
  fileLoadStarted,
  filesToLoad,
  isCollapsedByDefault,
  openExistingDraft,
  rangeLines,
  reviewAccepts,
  selectFile,
  summaryArrived,
  summaryFailed,
  summaryLoadStarted,
  toggleExpanded,
  type ReviewState,
} from './reviewState';

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

const summary = (diffId: string, files: DiffFileEntry[]): DiffSummaryResult => ({
  status: 'ok',
  summary: {
    diffId,
    baseRef: 'main',
    baseSha: 'base-sha',
    headSha: 'head-sha',
    includesWorkingTree: false,
    files,
    truncated: false,
  },
});

const file = (diffId: string, path: string, hunks: DiffHunk[]): DiffFile => ({
  diffId,
  path,
  hunks,
});

/** A card whose summary has already arrived, listing `paths` under `diffId`. */
function summaryLoaded(diffId: string, paths: string[]): ReviewState {
  const state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
  return summaryArrived(
    state,
    'a',
    1,
    summary(
      diffId,
      paths.map((p) => entry(p)),
    ),
  );
}

const twoHunkFile: DiffFile = file('d1', 'a.ts', [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    header: '@@ -1,3 +1,3 @@',
    lines: [
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'two', oldLine: 2, newLine: 2 },
      { kind: 'context', text: 'three', oldLine: 3, newLine: 3 },
    ],
  },
  {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 3,
    header: '@@ -10,3 +10,3 @@',
    lines: [
      { kind: 'context', text: 'ten', oldLine: 10, newLine: 10 },
      { kind: 'context', text: 'eleven', oldLine: 11, newLine: 11 },
      { kind: 'context', text: 'twelve', oldLine: 12, newLine: 12 },
    ],
  },
]);

/** A card with `twoHunkFile` already loaded, selected and expanded. */
function twoHunkLoaded(): ReviewState {
  let state = summaryLoaded(twoHunkFile.diffId, [twoHunkFile.path]);
  state = fileLoadStarted(state, 'a', twoHunkFile.diffId, twoHunkFile.path, 2);
  return fileArrived(state, 'a', twoHunkFile.diffId, twoHunkFile.path, 2, {
    status: 'ok',
    file: twoHunkFile,
  });
}

describe('summaryLoadStarted', () => {
  it('clears a card switch in the same step that starts the new load', () => {
    let state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
    state = summaryArrived(state, 'a', 1, summary('d1', [entry('a.ts')]));

    const switched = summaryLoadStarted(state, 'b', 2);

    expect(switched).toEqual({ ...EMPTY_REVIEW, taskId: 'b', applied: 2, loading: true });
  });

  it('keeps an already-loaded summary on screen while the same card reloads', () => {
    let state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
    state = summaryArrived(state, 'a', 1, summary('d1', [entry('a.ts')]));

    const reloaded = summaryLoadStarted(state, 'a', 2);

    expect(reloaded.summary).toEqual(summary('d1', [entry('a.ts')]));
    expect(reloaded.loading).toBe(true);
  });
});

describe('summaryArrived / summaryFailed', () => {
  it('treats the same diffId as a poll, not a reload', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileArrived(state, 'a', 'd1', 'a.ts', 2, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });

    const polled = summaryArrived(state, 'a', 1, summary('d1', [entry('a.ts')]));

    expect(polled.files['a.ts']).toEqual({ status: 'loaded', file: file('d1', 'a.ts', []) });
    expect(polled.loading).toBe(false);
  });

  it('clears files, expansion and selection on a non-ok result but keeps the editor', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = selectFile(state, 'a.ts');
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 1 }, false);
    const editorBefore = state.editor;
    expect(editorBefore).not.toBeNull();

    const landed = summaryArrived(state, 'a', 1, { status: 'landed', forgeUrl: null });

    expect(landed.files).toEqual({});
    expect(landed.expanded).toEqual([]);
    expect(landed.selectedPath).toBeNull();
    expect(landed.rangeAnchor).toBeNull();
    expect(landed.editor).toBe(editorBefore);
  });

  it('refuses a stale summary failure the same way as a stale answer', () => {
    let state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
    state = summaryLoadStarted(state, 'a', 2);

    const stale = summaryFailed(state, 'a', 1);
    expect(stale).toBe(state);
  });

  it('clears loading on a fresh failure without touching data', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = summaryLoadStarted(state, 'a', 2);

    const failed = summaryFailed(state, 'a', 2);
    expect(failed.loading).toBe(false);
    expect(failed.diffId).toBe('d1');
  });
});

describe('fileLoadStarted / fileArrived out-of-order answers', () => {
  it('keeps the newest file answer when the newer load settles first', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 3);

    state = fileArrived(state, 'a', 'd1', 'a.ts', 3, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });
    const stale = fileArrived(state, 'a', 'd1', 'a.ts', 2, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });

    expect(stale).toBe(state);
    expect(state.files['a.ts']).toEqual({ status: 'loaded', file: file('d1', 'a.ts', []) });
  });

  it('ends on the newest seq when the older answer lands first instead', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 3);

    const stale = fileArrived(state, 'a', 'd1', 'a.ts', 2, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });
    expect(stale).toBe(state);

    state = fileArrived(state, 'a', 'd1', 'a.ts', 3, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });
    expect(state.files['a.ts']).toEqual({ status: 'loaded', file: file('d1', 'a.ts', []) });
  });

  it('drops a late answer for a diffId the state has since moved past', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);

    state = summaryLoadStarted(state, 'a', 3);
    state = summaryArrived(state, 'a', 3, summary('d2', [entry('a.ts')]));
    // The reload's own fetch happens to reuse seq 2 — isolates the diffId guard from the
    // seq guard, since a loading entry with a matching seq now exists under the NEW diffId.
    state = fileLoadStarted(state, 'a', 'd2', 'a.ts', 2);

    const stale = fileArrived(state, 'a', 'd1', 'a.ts', 2, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });

    expect(stale).toBe(state);
  });

  it('refuses a load for a path not in the current summary', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    expect(fileLoadStarted(state, 'a', 'd1', 'missing.ts', 2)).toBe(state);
  });

  it('refuses a load for a diffId the state has moved past', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    expect(fileLoadStarted(state, 'a', 'd0', 'a.ts', 2)).toBe(state);
  });
});

describe('fileArrived / fileFailed variants', () => {
  it('turns a tooLarge ok answer into a tooLarge file load', () => {
    let state = summaryLoaded('d1', ['big.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'big.ts', 2);
    state = fileArrived(state, 'a', 'd1', 'big.ts', 2, {
      status: 'ok',
      file: { ...file('d1', 'big.ts', []), tooLarge: { bytes: 999_999 } },
    });

    expect(state.files['big.ts']).toEqual({ status: 'tooLarge', bytes: 999_999 });
  });

  it('turns a failed file load into idle with the error kept', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileFailed(state, 'a', 'd1', 'a.ts', 2, 'network error');

    expect(state.files['a.ts']).toEqual({ status: 'idle', error: 'network error' });
  });

  it('refuses a stale fileFailed answer the same way as fileArrived', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 3);

    const stale = fileFailed(state, 'a', 'd1', 'a.ts', 2, 'network error');
    expect(stale).toBe(state);
  });
});

describe('switching cards mid-load', () => {
  it('refuses the old card answers once a new card starts loading, blanking its state', () => {
    let state = summaryLoadStarted(EMPTY_REVIEW, 'A', 1);
    state = summaryArrived(state, 'A', 1, summary('d1', [entry('a.ts')]));
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 1 }, false);
    expect(state.editor).not.toBeNull();

    state = summaryLoadStarted(state, 'A', 2);
    state = fileLoadStarted(state, 'A', 'd1', 'a.ts', 3);
    expect(state.editor).not.toBeNull();

    const switched = summaryLoadStarted(state, 'B', 4);

    expect(switched).toEqual({ ...EMPTY_REVIEW, taskId: 'B', applied: 4, loading: true });
    expect(switched.editor).toBeNull();

    const summaryNoOp = summaryArrived(switched, 'A', 2, summary('d1', [entry('a.ts')]));
    expect(summaryNoOp).toBe(switched);

    const fileNoOp = fileArrived(switched, 'A', 'd1', 'a.ts', 3, {
      status: 'ok',
      file: file('d1', 'a.ts', []),
    });
    expect(fileNoOp).toBe(switched);
  });
});

describe('a stale reload that keeps drafts', () => {
  it('keeps the draft through the reload, then marks it outdated and prunes expanded', () => {
    let state = summaryLoaded('d1', ['a.ts', 'b.ts']);
    state = selectFile(state, 'a.ts');
    state = toggleExpanded(state, 'b.ts');

    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileArrived(state, 'a', 'd1', 'a.ts', 2, {
      status: 'stale',
      diffId: 'd1',
      currentDiffId: 'd2',
    });

    expect(state.staleDiffId).toBe('d2');
    expect(filesToLoad(state)).toEqual([]);

    state = clickLine(state, { path: 'b.ts', side: 'new', line: 5 }, false);
    state = editDraft(state, 'keep my draft');

    const reloaded = summaryLoadStarted(state, 'a', 3);
    expect(reloaded.editor?.draft).toBe('keep my draft');
    expect(reloaded.staleDiffId).toBe('d2');

    const after = summaryArrived(reloaded, 'a', 3, summary('d2', [entry('a.ts')]));

    expect(after.editor).toMatchObject({ path: 'b.ts', draft: 'keep my draft', outdated: true });
    expect(after.files).toEqual({});
    expect(after.expanded).toEqual(['a.ts']);
    expect(after.staleDiffId).toBeNull();
  });
});

describe('range selection across a gap', () => {
  it('orders start before anchor when the plain click is in the later hunk', () => {
    let state = twoHunkLoaded();
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 10 }, false);
    state = closeEditor(state);
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 2 }, true);

    expect(state.editor).toMatchObject({
      path: 'a.ts',
      start: { side: 'new', line: 2 },
      anchor: { side: 'new', line: 10 },
    });
  });

  it('rangeLines returns only rendered lines, with none for the gap', () => {
    let state = twoHunkLoaded();
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 10 }, false);
    state = closeEditor(state);
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 2 }, true);

    const lines = rangeLines(twoHunkFile, state.editor!);
    expect(lines.map((l) => l.newLine)).toEqual([2, 3, 10]);
  });

  it('orders an old-side to new-side range by rendered position, not line number', () => {
    let state = twoHunkLoaded();
    state = clickLine(state, { path: 'a.ts', side: 'old', line: 1 }, false);
    state = closeEditor(state);
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 12 }, true);

    expect(state.editor).toMatchObject({
      start: { side: 'old', line: 1 },
      anchor: { side: 'new', line: 12 },
    });
  });
});

describe('clickLine edge cases', () => {
  it('treats a shift-click with no anchor as a plain click', () => {
    const state = clickLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 }, true);

    expect(state.editor).toMatchObject({ path: 'a.ts', anchor: { side: 'new', line: 2 } });
    expect(state.editor?.start).toBeUndefined();
    expect(state.rangeAnchor).toEqual({ path: 'a.ts', side: 'new', line: 2 });
  });

  it('treats a shift-click on a different file as a plain click', () => {
    let state = twoHunkLoaded();
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 2 }, false);
    state = closeEditor(state);
    state = clickLine(state, { path: 'other.ts', side: 'new', line: 5 }, true);

    expect(state.editor).toMatchObject({ path: 'other.ts', anchor: { side: 'new', line: 5 } });
    expect(state.editor?.start).toBeUndefined();
  });

  it('refuses a click while the editor is already open', () => {
    const state = clickLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 }, false);
    const again = clickLine(state, { path: 'a.ts', side: 'new', line: 10 }, false);
    expect(again).toBe(state);
  });
});

describe('editDraft / closeEditor', () => {
  it('is a no-op when there is no editor', () => {
    expect(editDraft(EMPTY_REVIEW, 'hello')).toBe(EMPTY_REVIEW);
    expect(closeEditor(EMPTY_REVIEW)).toBe(EMPTY_REVIEW);
  });

  it('is a no-op when the draft text is unchanged', () => {
    let state = clickLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 }, false);
    state = editDraft(state, 'hello');
    expect(editDraft(state, 'hello')).toBe(state);
  });
});

describe('openExistingDraft', () => {
  it('flags outdated when the comment diffId does not match the current diff', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    const comment: ReviewComment = {
      id: 'c1',
      taskId: 'a',
      diffId: 'd0',
      path: 'a.ts',
      side: 'new',
      line: 3,
      body: 'existing comment',
      excerpt: 'three',
      createdAt: 1,
      updatedAt: 1,
      sentAt: null,
    };

    const opened = openExistingDraft(state, comment);

    expect(opened.editor).toMatchObject({
      path: 'a.ts',
      draft: 'existing comment',
      outdated: true,
    });
  });
});

describe('selectFile / toggleExpanded', () => {
  it('expands and selects a collapsed file', () => {
    const state = selectFile(EMPTY_REVIEW, 'a.ts');
    expect(state.selectedPath).toBe('a.ts');
    expect(state.expanded).toEqual(['a.ts']);
  });

  it('is a no-op when the file is already selected and expanded', () => {
    const state = selectFile(EMPTY_REVIEW, 'a.ts');
    expect(selectFile(state, 'a.ts')).toBe(state);
  });

  it('toggles a file collapsed and back open', () => {
    const expanded = toggleExpanded(EMPTY_REVIEW, 'a.ts');
    expect(expanded.expanded).toEqual(['a.ts']);
    const collapsed = toggleExpanded(expanded, 'a.ts');
    expect(collapsed.expanded).toEqual([]);
  });
});

describe('reviewAccepts', () => {
  it('accepts the newest load for the current card', () => {
    const state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
    expect(reviewAccepts(state, 'a', 1)).toBe(true);
  });

  it('refuses an older load once a newer one has started', () => {
    const state = summaryLoadStarted(summaryLoadStarted(EMPTY_REVIEW, 'a', 1), 'a', 2);
    expect(reviewAccepts(state, 'a', 1)).toBe(false);
  });

  it('refuses an answer meant for a different card', () => {
    const state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
    expect(reviewAccepts(state, 'b', 1)).toBe(false);
  });
});

describe('isCollapsedByDefault', () => {
  it('collapses a file whose changed lines exceed the cap', () => {
    expect(
      isCollapsedByDefault(entry('generated.ts', { additions: DIFF_COLLAPSE_LINES, deletions: 1 })),
    ).toBe(true);
  });

  it('keeps a small file expanded', () => {
    expect(isCollapsedByDefault(entry('small.ts', { additions: 1, deletions: 1 }))).toBe(false);
  });
});
