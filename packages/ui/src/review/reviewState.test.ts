import { describe, expect, it } from 'vitest';
import { oversizedAnswerMessage } from '@tm/shared/ipcRelay';
import type {
  DiffContext,
  DiffContextResult,
  DiffFile,
  DiffFileEntry,
  DiffHunk,
  DiffSummaryResult,
  ReviewComment,
  ReviewSendResult,
  ReviewViewedMark,
} from '@tm/shared/review';
import { DIFF_COLLAPSE_LINES, DIFF_CONTEXT_MAX_LINES } from '@tm/shared/review';
import {
  EMPTY_REVIEW,
  canComment,
  canSend,
  cancelSelection,
  clickLine,
  closeEditor,
  commentDeleted,
  commentOnSelection,
  commentSaved,
  commentsArrived,
  commentsAt,
  commentsLoadStarted,
  contextArrived,
  contextFailed,
  contextLoadStarted,
  contextRequest,
  editDraft,
  editNote,
  fileArrived,
  fileFailed,
  fileLoadStarted,
  filesToLoad,
  gapBounds,
  isCollapsedByDefault,
  navigationOrder,
  nextFile,
  nextHunk,
  openExistingDraft,
  prevFile,
  prevHunk,
  rangeLines,
  reviewAccepts,
  reviewSent,
  saveRefused,
  saveStarted,
  selectFile,
  sendStarted,
  setViewed,
  summaryArrived,
  summaryFailed,
  summaryLoadStarted,
  tapLine,
  toggleExpanded,
  toggleViewedAndAdvance,
  unsentCount,
  viewedArrived,
  viewedLoadStarted,
  viewedStatuses,
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

let nextCommentId = 0;
const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id: `c${++nextCommentId}`,
  taskId: 'a',
  diffId: 'd1',
  path: 'a.ts',
  side: 'new',
  line: 3,
  body: 'a comment',
  excerpt: 'three',
  createdAt: 1,
  updatedAt: 1,
  sentAt: null,
  ...overrides,
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

  it('classifies the relay oversized-answer error as tooLargeForBrowser', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileFailed(state, 'a', 'd1', 'a.ts', 2, oversizedAnswerMessage(5_000_000));

    expect(state.files['a.ts']).toEqual({ status: 'tooLargeForBrowser', bytes: 5_000_000 });
  });

  it('keeps any other error as idle, rather than misreading it as oversized', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = fileLoadStarted(state, 'a', 'd1', 'a.ts', 2);
    state = fileFailed(state, 'a', 'd1', 'a.ts', 2, 'network error');

    expect(state.files['a.ts']).toEqual({ status: 'idle', error: 'network error' });
  });

  it('never refetches a tooLargeForBrowser path, the same as tooLarge', () => {
    let state = summaryLoaded('d1', ['a.ts', 'b.ts']);
    state = toggleExpanded(state, 'b.ts');
    state = fileLoadStarted(state, 'a', 'd1', 'b.ts', 2);
    state = fileFailed(state, 'a', 'd1', 'b.ts', 2, oversizedAnswerMessage(123));

    expect(state.files['b.ts']).toEqual({ status: 'tooLargeForBrowser', bytes: 123 });
    expect(filesToLoad(state)).not.toContain('b.ts');
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

describe('commentsLoadStarted / commentsArrived', () => {
  it('replaces the list wholesale when accepted', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = commentsLoadStarted(state, 'a', 1);
    const c = comment();

    state = commentsArrived(state, 'a', 1, [c]);

    expect(state.comments).toEqual([c]);
  });

  it('drops a late answer once a newer load has started', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = commentsLoadStarted(state, 'a', 1);
    state = commentsLoadStarted(state, 'a', 2);

    const stale = commentsArrived(state, 'a', 1, [comment()]);

    expect(stale).toBe(state);
  });

  it('refuses an answer meant for a different card', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = commentsLoadStarted(state, 'a', 1);

    const foreign = commentsArrived(state, 'b', 1, [comment()]);

    expect(foreign).toBe(state);
  });
});

describe('add, save and the editor', () => {
  it('closes the editor and lists the comment once a new draft is saved', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 3 }, false);
    state = saveStarted(state);
    expect(state.editor).toMatchObject({ saving: true });

    const saved = comment({ line: 3 });
    state = commentSaved(state, 'a', saved);

    expect(state.editor).toBeNull();
    expect(commentsAt(state, 'a.ts', 'new', 3)).toEqual([saved]);
  });

  it('keeps the draft and sets staleDiffId when a save is refused as stale', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = clickLine(state, { path: 'a.ts', side: 'new', line: 3 }, false);
    state = editDraft(state, 'a draft');
    state = saveStarted(state);

    state = saveRefused(state, 'a', { status: 'stale', diffId: 'd1', currentDiffId: 'd2' });

    expect(state.editor).toMatchObject({
      draft: 'a draft',
      saving: false,
      error: 'the diff moved on — reload',
    });
    expect(state.staleDiffId).toBe('d2');
  });

  it('replaces the body in place when an edit of an existing draft is saved', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const original = comment({ line: 3, body: 'first' });
    state = { ...state, comments: [original] };
    state = openExistingDraft(state, original);
    state = editDraft(state, 'edited');
    state = saveStarted(state);

    const updated: ReviewComment = { ...original, body: 'edited', updatedAt: 2 };
    state = commentSaved(state, 'a', updated);

    expect(state.editor).toBeNull();
    expect(state.comments).toEqual([updated]);
  });

  it('refuses to open a sent comment for editing', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    const sent = comment({ sentAt: 5 });

    expect(openExistingDraft(state, sent)).toBe(state);
  });

  it('sets "already sent" on the editor when a save is refused because the comment went out', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const original = comment({ line: 3, body: 'first' });
    state = { ...state, comments: [original] };
    state = openExistingDraft(state, original);
    state = saveStarted(state);

    state = saveRefused(state, 'a', { status: 'sent', sentAt: 5 });

    expect(state.editor).toMatchObject({ draft: 'first', saving: false, error: 'already sent' });
  });
});

describe('commentDeleted', () => {
  it('removes the comment and closes its editor if it was open', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const c = comment({ line: 3 });
    state = { ...state, comments: [c] };
    state = openExistingDraft(state, c);

    state = commentDeleted(state, 'a', c.id);

    expect(state.comments).toEqual([]);
    expect(state.editor).toBeNull();
  });

  it('is a no-op for a foreign taskId', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const c = comment({ line: 3 });
    state = { ...state, comments: [c] };

    expect(commentDeleted(state, 'b', c.id)).toBe(state);
  });
});

describe('sendStarted / reviewSent', () => {
  it('flips sentAt on the returned comments and clears note, sending and sendError on sent/resumed', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const draft = comment({ line: 3 });
    state = { ...state, comments: [draft], note: 'ptal', sendError: 'limit' };
    state = sendStarted(state);
    expect(state.sending).toBe(true);
    expect(state.sendError).toBeNull();

    const sent: ReviewSendResult = {
      status: 'sent',
      taskId: 'step-1',
      runId: 'run-1',
      comments: [{ ...draft, sentAt: 10 }],
    };
    state = reviewSent(state, 'a', sent);

    expect(unsentCount(state)).toBe(0);
    expect(state.note).toBe('');
    expect(state.sending).toBe(false);
    expect(state.sendError).toBeNull();
  });

  it('keeps every draft and the note on a refused send, and sets sendError', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const draft = comment({ line: 3 });
    state = { ...state, comments: [draft], note: 'ptal' };
    state = sendStarted(state);

    const refused: ReviewSendResult = { status: 'refused', taskId: 'a', reason: 'nothing-to-send' };
    state = reviewSent(state, 'a', refused);

    expect(state.comments).toEqual([draft]);
    expect(state.note).toBe('ptal');
    expect(state.sending).toBe(false);
    expect(state.sendError).toBe('nothing-to-send');
  });

  it('is a no-op for a foreign taskId', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    const sent: ReviewSendResult = { status: 'sent', taskId: 'a', runId: 'run-1', comments: [] };

    expect(reviewSent(state, 'b', sent)).toBe(state);
  });
});

describe('comments and note through a card switch or a stale reload', () => {
  it('clears comments and note when switching to a different card', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    state = { ...state, comments: [comment()], note: 'ptal' };

    const switched = summaryLoadStarted(state, 'b', 2);

    expect(switched.comments).toEqual([]);
    expect(switched.note).toBe('');
  });

  it('keeps comments and note through a stale reload of the same card', () => {
    let state = summaryLoaded('d1', ['a.ts']);
    const c = comment();
    state = { ...state, comments: [c], note: 'ptal' };

    state = summaryLoadStarted(state, 'a', 2);
    state = summaryArrived(state, 'a', 2, summary('d2', [entry('a.ts')]));

    expect(state.comments).toEqual([c]);
    expect(state.note).toBe('ptal');
  });
});

describe('editNote', () => {
  it('is a no-op when the text is unchanged', () => {
    expect(editNote(EMPTY_REVIEW, '')).toBe(EMPTY_REVIEW);
  });

  it('updates the note', () => {
    expect(editNote(EMPTY_REVIEW, 'ptal').note).toBe('ptal');
  });
});

describe('canSend / canComment', () => {
  it('is false when there are no unsent drafts, even with a note', () => {
    const state = { ...summaryLoaded('d1', ['a.ts']), note: 'ptal' };
    expect(canSend(state)).toBe(false);
  });

  it('is true once there is an unsent draft, and false while sending', () => {
    let state: ReviewState = { ...summaryLoaded('d1', ['a.ts']), comments: [comment()] };
    expect(canSend(state)).toBe(true);

    state = sendStarted(state);
    expect(canSend(state)).toBe(false);
  });

  it('refuses a new comment once the diff is stale', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    expect(canComment(state)).toBe(true);

    expect(canComment({ ...state, staleDiffId: 'd2' })).toBe(false);
  });

  it('refuses both while readOnly, even when every other condition is met', () => {
    const state = { ...summaryLoaded('d1', ['a.ts']), comments: [comment()] };
    expect(canSend(state)).toBe(true);
    expect(canComment(state)).toBe(true);

    expect(canSend(state, true)).toBe(false);
    expect(canComment(state, true)).toBe(false);
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

describe('tap selection', () => {
  it('starts a single selection on the tapped line', () => {
    const state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });

    expect(state.selection).toEqual({ path: 'a.ts', anchor: { side: 'new', line: 2 } });
  });

  it('forms a range ordered by rendered position, tapping the later line first', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 10 });
    state = tapLine(state, { path: 'a.ts', side: 'new', line: 2 });

    expect(state.selection).toEqual({
      path: 'a.ts',
      start: { side: 'new', line: 2 },
      anchor: { side: 'new', line: 10 },
    });
  });

  it('forms the same ordered range tapping the earlier line first', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });
    state = tapLine(state, { path: 'a.ts', side: 'new', line: 10 });

    expect(state.selection).toEqual({
      path: 'a.ts',
      start: { side: 'new', line: 2 },
      anchor: { side: 'new', line: 10 },
    });
  });

  it('orders across old/new sides by rendered position, not line number', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 12 });
    state = tapLine(state, { path: 'a.ts', side: 'old', line: 1 });

    expect(state.selection).toEqual({
      path: 'a.ts',
      start: { side: 'old', line: 1 },
      anchor: { side: 'new', line: 12 },
    });
  });

  it('cancels a single selection by tapping the same line again', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });
    state = tapLine(state, { path: 'a.ts', side: 'new', line: 2 });

    expect(state.selection).toBeNull();
  });

  it('cancels via cancelSelection, a no-op when there is already none', () => {
    const selected = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });

    const cancelled = cancelSelection(selected);
    expect(cancelled.selection).toBeNull();

    expect(cancelSelection(cancelled)).toBe(cancelled);
  });

  it('restarts the selection when tapping another file', () => {
    let state = summaryLoaded('d1', ['a.ts', 'other.ts']);
    state = tapLine(state, { path: 'a.ts', side: 'new', line: 2 });

    state = tapLine(state, { path: 'other.ts', side: 'new', line: 5 });

    expect(state.selection).toEqual({ path: 'other.ts', anchor: { side: 'new', line: 5 } });
  });

  it('restarts the selection when tapping while a range is already selected', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });
    state = tapLine(state, { path: 'a.ts', side: 'new', line: 10 });
    expect(state.selection?.start).toBeDefined();

    state = tapLine(state, { path: 'a.ts', side: 'new', line: 11 });

    expect(state.selection).toEqual({ path: 'a.ts', anchor: { side: 'new', line: 11 } });
  });

  it('refuses a tap while the editor is already open', () => {
    const state = clickLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 }, false);

    const again = tapLine(state, { path: 'a.ts', side: 'new', line: 10 });

    expect(again).toBe(state);
  });

  it('commentOnSelection opens the same single-line editor clickLine would', () => {
    const viaTap = commentOnSelection(
      tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 }),
    );
    const viaClick = clickLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 }, false);

    expect(viaTap.editor).toEqual(viaClick.editor);
    expect(viaTap.selection).toBeNull();
  });

  it('commentOnSelection opens the same range editor openRange would', () => {
    let tapped = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 10 });
    tapped = tapLine(tapped, { path: 'a.ts', side: 'new', line: 2 });
    const viaTap = commentOnSelection(tapped);

    let clicked = clickLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 10 }, false);
    clicked = closeEditor(clicked);
    clicked = clickLine(clicked, { path: 'a.ts', side: 'new', line: 2 }, true);

    expect(viaTap.editor).toEqual(clicked.editor);
    expect(viaTap.selection).toBeNull();
  });

  it('refuses commentOnSelection with no selection, an open editor, or when canComment is false', () => {
    const noSelection = twoHunkLoaded();
    expect(commentOnSelection(noSelection)).toBe(noSelection);

    const selected = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });
    const editorOpen: ReviewState = {
      ...selected,
      editor: {
        path: 'b.ts',
        anchor: { side: 'new', line: 1 },
        draft: '',
        outdated: false,
        saving: false,
      },
    };
    expect(commentOnSelection(editorOpen)).toBe(editorOpen);

    const stale = { ...selected, staleDiffId: 'd2' };
    expect(commentOnSelection(stale)).toBe(stale);
  });

  it('clears the selection on a new diffId', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });
    state = summaryLoadStarted(state, 'a', 10);

    state = summaryArrived(state, 'a', 10, summary('d2', [entry('a.ts')]));

    expect(state.selection).toBeNull();
  });

  it('clears the selection on a non-ok summary', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 2 });
    state = summaryLoadStarted(state, 'a', 10);

    state = summaryArrived(state, 'a', 10, { status: 'landed', forgeUrl: null });

    expect(state.selection).toBeNull();
  });

  it('rangeLines reads a selection the same way it reads an editor', () => {
    let state = tapLine(twoHunkLoaded(), { path: 'a.ts', side: 'new', line: 10 });
    state = tapLine(state, { path: 'a.ts', side: 'new', line: 2 });

    const lines = rangeLines(twoHunkFile, state.selection!);
    expect(lines.map((l) => l.newLine)).toEqual([2, 3, 10]);
  });
});

describe('navigationOrder', () => {
  it('flattens a tree into leaf path order, directories first, depth first', () => {
    const order = navigationOrder([
      entry('z.ts'),
      entry('src/b.ts'),
      entry('src/a.ts'),
      entry('a.ts'),
    ]);
    expect(order).toEqual(['src/a.ts', 'src/b.ts', 'a.ts', 'z.ts']);
  });

  it('is empty for no files', () => {
    expect(navigationOrder([])).toEqual([]);
  });
});

describe('nextFile / prevFile', () => {
  it('selects the first file from no selection, and wraps forward past the last', () => {
    let state = summaryLoaded('d1', ['a.ts', 'b.ts', 'c.ts']);

    state = nextFile(state);
    expect(state.selectedPath).toBe('a.ts');
    state = nextFile(state);
    expect(state.selectedPath).toBe('b.ts');
    state = nextFile(state);
    expect(state.selectedPath).toBe('c.ts');
    state = nextFile(state);
    expect(state.selectedPath).toBe('a.ts');
  });

  it('selects the last file from no selection, and wraps backward past the first', () => {
    let state = summaryLoaded('d1', ['a.ts', 'b.ts', 'c.ts']);

    state = prevFile(state);
    expect(state.selectedPath).toBe('c.ts');
    state = prevFile(state);
    expect(state.selectedPath).toBe('b.ts');
    state = prevFile(state);
    expect(state.selectedPath).toBe('a.ts');
    state = prevFile(state);
    expect(state.selectedPath).toBe('c.ts');
  });

  it('is a no-op while the summary is not loaded ok', () => {
    const state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
    expect(nextFile(state)).toBe(state);
    expect(prevFile(state)).toBe(state);
  });

  it('is a no-op for an empty file list', () => {
    const state = summaryLoaded('d1', []);
    expect(nextFile(state)).toBe(state);
    expect(prevFile(state)).toBe(state);
  });

  it('resets hunkIndex when it moves the selection', () => {
    let state = selectFile(twoHunkLoaded(), 'a.ts');
    state = nextHunk(state);
    expect(state.hunkIndex).toBe(0);

    state = summaryLoaded('d1', ['a.ts', 'b.ts']);
    state = { ...state, selectedPath: 'a.ts', hunkIndex: 0 };
    state = nextFile(state);

    expect(state.selectedPath).toBe('b.ts');
    expect(state.hunkIndex).toBeNull();
  });
});

describe('nextHunk / prevHunk', () => {
  it('moves the cursor forward from null, then stops at the last hunk', () => {
    let state = selectFile(twoHunkLoaded(), 'a.ts');
    expect(state.hunkIndex).toBeNull();

    state = nextHunk(state);
    expect(state.hunkIndex).toBe(0);
    state = nextHunk(state);
    expect(state.hunkIndex).toBe(1);

    const atEnd = nextHunk(state);
    expect(atEnd).toBe(state);
  });

  it('moves the cursor backward, but null never jumps anywhere', () => {
    let state = selectFile(twoHunkLoaded(), 'a.ts');

    const noCursor = prevHunk(state);
    expect(noCursor).toBe(state);

    state = nextHunk(nextHunk(state));
    expect(state.hunkIndex).toBe(1);
    state = prevHunk(state);
    expect(state.hunkIndex).toBe(0);

    const atStart = prevHunk(state);
    expect(atStart).toBe(state);
  });

  it('is a no-op with no selection, an unloaded file, or no hunks', () => {
    const noSelection = summaryLoaded('d1', ['a.ts']);
    expect(nextHunk(noSelection)).toBe(noSelection);
    expect(prevHunk(noSelection)).toBe(noSelection);

    const notLoaded = selectFile(noSelection, 'a.ts');
    expect(nextHunk(notLoaded)).toBe(notLoaded);

    let empty = summaryLoaded('d1', ['empty.ts']);
    empty = selectFile(empty, 'empty.ts');
    empty = fileLoadStarted(empty, 'a', 'd1', 'empty.ts', 2);
    empty = fileArrived(empty, 'a', 'd1', 'empty.ts', 2, {
      status: 'ok',
      file: file('d1', 'empty.ts', []),
    });
    expect(nextHunk(empty)).toBe(empty);
  });
});

/** A card whose summary has already arrived, listing `paths` each with their own `newBlobSha`. */
function summaryLoadedWithBlobs(diffId: string, paths: string[]): ReviewState {
  const state = summaryLoadStarted(EMPTY_REVIEW, 'a', 1);
  return summaryArrived(
    state,
    'a',
    1,
    summary(
      diffId,
      paths.map((p) => entry(p, { newBlobSha: `sha-${p}` })),
    ),
  );
}

describe('setViewed', () => {
  it('marks a file viewed with the entry own newBlobSha, and collapses it', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts']);
    state = selectFile(state, 'a.ts');
    expect(state.expanded).toContain('a.ts');

    state = setViewed(state, 'a.ts', true, 100);

    expect(state.viewedMarks).toEqual([
      { subjectId: 'task:a', path: 'a.ts', blobSha: 'sha-a.ts', viewedAt: 100 },
    ]);
    expect(state.expanded).not.toContain('a.ts');
  });

  it('replaces an existing mark for the same path rather than duplicating it', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts']);
    state = setViewed(state, 'a.ts', true, 100);
    state = setViewed(state, 'a.ts', true, 200);

    expect(state.viewedMarks).toEqual([
      { subjectId: 'task:a', path: 'a.ts', blobSha: 'sha-a.ts', viewedAt: 200 },
    ]);
  });

  it('unviewing removes the mark without re-expanding what viewing had collapsed', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts']);
    state = selectFile(state, 'a.ts');
    state = setViewed(state, 'a.ts', true, 100);
    expect(state.expanded).not.toContain('a.ts');

    state = setViewed(state, 'a.ts', false, 200);

    expect(state.viewedMarks).toEqual([]);
    expect(state.expanded).not.toContain('a.ts');
  });

  it('refuses when there is no newBlobSha to key a mark on', () => {
    const state = summaryLoaded('d1', ['a.ts']);
    expect(setViewed(state, 'a.ts', true, 100)).toBe(state);
  });

  it('refuses for a path not in the summary, no taskId, or a non-ok summary', () => {
    const state = summaryLoadedWithBlobs('d1', ['a.ts']);
    expect(setViewed(state, 'missing.ts', true, 100)).toBe(state);
    expect(setViewed(EMPTY_REVIEW, 'a.ts', true, 100)).toBe(EMPTY_REVIEW);

    const landed = summaryArrived(state, 'a', 1, { status: 'landed', forgeUrl: null });
    expect(setViewed(landed, 'a.ts', true, 100)).toBe(landed);
  });
});

describe('toggleViewedAndAdvance', () => {
  it('advances to the next unviewed file after marking the current one viewed', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts', 'b.ts', 'c.ts']);
    state = selectFile(state, 'a.ts');

    state = toggleViewedAndAdvance(state, 100);
    expect(viewedStatuses(state).byPath['a.ts']).toBe('viewed');
    expect(state.selectedPath).toBe('b.ts');

    state = toggleViewedAndAdvance(state, 100);
    expect(state.selectedPath).toBe('c.ts');
  });

  it('wraps around, and stays put once every file is viewed', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts', 'b.ts']);
    state = selectFile(state, 'a.ts');
    state = toggleViewedAndAdvance(state, 100); // a viewed, advances to b
    expect(state.selectedPath).toBe('b.ts');

    state = toggleViewedAndAdvance(state, 100); // b viewed, nothing left to advance to

    expect(state.selectedPath).toBe('b.ts');
    expect(viewedStatuses(state).viewedCount).toBe(2);
  });

  it('advances to a changed file too, not only an unviewed one', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts', 'b.ts']);
    state = setViewed(state, 'b.ts', true, 50);
    // b's mark is now stale: the entry moved to a new blob since it was viewed. Same diffId,
    // so this is a poll — it replaces `summary` without touching `files`/`selectedPath`.
    state = summaryArrived(
      state,
      'a',
      state.applied,
      summary('d1', [
        entry('a.ts', { newBlobSha: 'sha-a.ts' }),
        entry('b.ts', { newBlobSha: 'sha-b.ts-v2' }),
      ]),
    );
    state = selectFile(state, 'a.ts');
    expect(viewedStatuses(state).byPath['b.ts']).toBe('changed');

    state = toggleViewedAndAdvance(state, 100);

    expect(state.selectedPath).toBe('b.ts');
  });

  it('never advances when the toggle turns a file OFF', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts', 'b.ts']);
    state = selectFile(state, 'a.ts');
    state = toggleViewedAndAdvance(state, 100);
    expect(state.selectedPath).toBe('b.ts');

    state = selectFile(state, 'a.ts');
    state = toggleViewedAndAdvance(state, 200);

    expect(viewedStatuses(state).byPath['a.ts']).toBe('unviewed');
    expect(state.selectedPath).toBe('a.ts');
  });

  it('is a no-op with no selection or a refused setViewed', () => {
    const noSelection = summaryLoadedWithBlobs('d1', ['a.ts']);
    expect(toggleViewedAndAdvance(noSelection, 100)).toBe(noSelection);

    const noBlobSha = selectFile(summaryLoaded('d1', ['a.ts']), 'a.ts');
    expect(toggleViewedAndAdvance(noBlobSha, 100)).toBe(noBlobSha);
  });
});

describe('viewedLoadStarted / viewedArrived / viewedStatuses', () => {
  const mark = (path: string, blobSha: string): ReviewViewedMark => ({
    subjectId: 'task:a',
    path,
    blobSha,
    viewedAt: 1,
  });

  it('replaces viewedMarks wholesale when accepted', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts']);
    state = viewedLoadStarted(state, 'a', 1);

    state = viewedArrived(state, 'a', 1, [mark('a.ts', 'sha-a.ts')]);

    expect(state.viewedMarks).toEqual([mark('a.ts', 'sha-a.ts')]);
    expect(viewedStatuses(state).byPath['a.ts']).toBe('viewed');
  });

  it('drops a late answer once a newer load has started', () => {
    let state = summaryLoadedWithBlobs('d1', ['a.ts']);
    state = viewedLoadStarted(state, 'a', 1);
    state = viewedLoadStarted(state, 'a', 2);

    const stale = viewedArrived(state, 'a', 1, [mark('a.ts', 'sha-a.ts')]);

    expect(stale).toBe(state);
  });

  it('viewedStatuses is empty while the summary is not loaded ok', () => {
    expect(viewedStatuses(EMPTY_REVIEW)).toEqual({ byPath: {}, viewedCount: 0 });
  });
});

describe('gapBounds / contextRequest', () => {
  it('bounds the file-start, between-hunk and trailing gaps of twoHunkFile', () => {
    expect(gapBounds(twoHunkFile, 0)).toEqual({ low: 1, high: 1 });
    expect(gapBounds(twoHunkFile, 1)).toEqual({ low: 4, high: 10 });
    expect(gapBounds(twoHunkFile, 2)).toEqual({ low: 13, high: Infinity });
  });

  it('"step" reads the 20 lines closest to the gap, always on the new side', () => {
    expect(contextRequest(twoHunkFile, 1, 'step')).toEqual({ side: 'new', from: 4, to: 9 });
    expect(contextRequest(twoHunkFile, 2, 'step')).toEqual({ side: 'new', from: 13, to: 32 });
  });

  it('"all" reads the whole gap, capped to DIFF_CONTEXT_MAX_LINES for an open-ended one', () => {
    expect(contextRequest(twoHunkFile, 1, 'all')).toEqual({ side: 'new', from: 4, to: 9 });
    expect(contextRequest(twoHunkFile, 2, 'all')).toEqual({
      side: 'new',
      from: 13,
      to: 13 + DIFF_CONTEXT_MAX_LINES - 1,
    });
  });
});

describe('contextLoadStarted / contextArrived / contextFailed', () => {
  const contextResult = (contextOverrides: Partial<DiffContext> = {}): DiffContextResult => ({
    status: 'ok',
    context: {
      diffId: 'd1',
      path: 'a.ts',
      side: 'new',
      start: 4,
      text: ['four', 'five', 'six', 'seven', 'eight', 'nine'],
      truncated: false,
      ...contextOverrides,
    },
  });

  it('sets loading at the gap own low bound, computed from the current hunks', () => {
    const state = contextLoadStarted(twoHunkLoaded(), 'a', 'd1', 'a.ts', 1, 5);
    expect(state.context['a.ts']?.[4]).toEqual({ status: 'loading', seq: 5 });
  });

  it('refuses unless the task matches, diffId matches, and the file is loaded', () => {
    const state = twoHunkLoaded();
    expect(contextLoadStarted(state, 'b', 'd1', 'a.ts', 1, 5)).toBe(state);
    expect(contextLoadStarted(state, 'a', 'd0', 'a.ts', 1, 5)).toBe(state);

    const notLoaded = selectFile(summaryLoaded('d1', ['a.ts']), 'a.ts');
    expect(contextLoadStarted(notLoaded, 'a', 'd1', 'a.ts', 1, 5)).toBe(notLoaded);
  });

  it('merges a full-gap answer, closing the gap and clamping hunkIndex', () => {
    let state = twoHunkLoaded();
    state = { ...state, hunkIndex: 1 };
    state = contextLoadStarted(state, 'a', 'd1', 'a.ts', 1, 5);

    state = contextArrived(state, 'a', 'd1', 'a.ts', 4, 5, contextResult());

    expect(state.context['a.ts']?.[4]).toBeUndefined();
    const loaded = state.files['a.ts'] as { status: 'loaded'; file: DiffFile };
    expect(loaded.file.hunks).toHaveLength(1);
    expect(state.hunkIndex).toBe(0);
  });

  it('deletes the entry with no merge when the gap no longer exists', () => {
    let state = twoHunkLoaded();
    state = contextLoadStarted(state, 'a', 'd1', 'a.ts', 1, 5);
    // This answer merges gap 1 away entirely — the file's two hunks become one — so no gap
    // has `low === 4` any more afterwards.
    state = contextArrived(state, 'a', 'd1', 'a.ts', 4, 5, contextResult());
    expect((state.files['a.ts'] as { status: 'loaded'; file: DiffFile }).file.hunks).toHaveLength(
      1,
    );

    // A second, slower answer for that same now-gone gap was still in flight — simulated
    // directly, since `contextLoadStarted` can only ever produce an entry for a gap that
    // exists *right now*, never one that is already stale by construction.
    state = {
      ...state,
      context: { ...state.context, 'a.ts': { 4: { status: 'loading', seq: 6 } } },
    };
    state = contextArrived(state, 'a', 'd1', 'a.ts', 4, 6, contextResult());

    expect(state.context['a.ts']?.[4]).toBeUndefined();
    expect((state.files['a.ts'] as { status: 'loaded'; file: DiffFile }).file.hunks).toHaveLength(
      1,
    );
  });

  it('records tooLarge, and leaves a stale answer loading while setting staleDiffId', () => {
    let state = twoHunkLoaded();
    state = contextLoadStarted(state, 'a', 'd1', 'a.ts', 1, 5);

    const tooLarge = contextArrived(
      state,
      'a',
      'd1',
      'a.ts',
      4,
      5,
      contextResult({ tooLarge: { bytes: 999 } }),
    );
    expect(tooLarge.context['a.ts']?.[4]).toEqual({ status: 'tooLarge', bytes: 999 });

    const stale = contextArrived(state, 'a', 'd1', 'a.ts', 4, 5, {
      status: 'stale',
      diffId: 'd1',
      currentDiffId: 'd2',
    });
    expect(stale.staleDiffId).toBe('d2');
    expect(stale.context['a.ts']?.[4]).toEqual({ status: 'loading', seq: 5 });
  });

  it('refuses a late answer for an old diffId as a no-op, same as a file answer', () => {
    let state = twoHunkLoaded();
    state = contextLoadStarted(state, 'a', 'd1', 'a.ts', 1, 5);

    const stale = contextArrived(state, 'a', 'd0', 'a.ts', 4, 5, contextResult());
    expect(stale).toBe(state);
  });

  it('contextFailed sets idle with the error, refused the same way as contextArrived', () => {
    let state = twoHunkLoaded();
    state = contextLoadStarted(state, 'a', 'd1', 'a.ts', 1, 5);

    state = contextFailed(state, 'a', 'd1', 'a.ts', 4, 5, 'network error');
    expect(state.context['a.ts']?.[4]).toEqual({ status: 'idle', error: 'network error' });

    const unchanged = contextFailed(state, 'a', 'd0', 'a.ts', 4, 5, 'network error');
    expect(unchanged).toBe(state);
  });
});
