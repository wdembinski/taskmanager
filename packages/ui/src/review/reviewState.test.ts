import { describe, expect, it } from 'vitest';
import type {
  DiffFile,
  DiffFileEntry,
  DiffHunk,
  DiffSummaryResult,
  ReviewComment,
  ReviewSendResult,
} from '@tm/shared/review';
import { DIFF_COLLAPSE_LINES } from '@tm/shared/review';
import {
  EMPTY_REVIEW,
  canComment,
  canSend,
  clickLine,
  closeEditor,
  commentDeleted,
  commentSaved,
  commentsArrived,
  commentsAt,
  commentsLoadStarted,
  editDraft,
  editNote,
  fileArrived,
  fileFailed,
  fileLoadStarted,
  filesToLoad,
  isCollapsedByDefault,
  openExistingDraft,
  rangeLines,
  reviewAccepts,
  reviewSent,
  saveRefused,
  saveStarted,
  selectFile,
  sendStarted,
  summaryArrived,
  summaryFailed,
  summaryLoadStarted,
  toggleExpanded,
  unsentCount,
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
