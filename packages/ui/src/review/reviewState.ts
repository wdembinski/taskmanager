/**
 * The Changes pane's file tree, diff reads and comment editor, kept as a pure state machine —
 * same reasons as `taskTimeline.ts` and `issues/issueBrowserState.ts`: this workspace has no DOM
 * test harness (no jsdom, no testing-library), so the only way to prove the pane's races are
 * closed is to pull its transitions out of the component and test them as plain functions.
 *
 * Two races, one counter each. `ReviewPane` fetches a summary, then — lazily, per expanded file
 * — each file's patch, and those awaits are not guaranteed to land in request order. The caller
 * mints every `seq` from one ever-increasing counter. `applied` is the newest load this state
 * has accepted a summary for (`reviewAccepts`); each file's own `loading { seq }` is a SEPARATE
 * frontier, since files load independently of each other and of the summary. A late summary
 * answer for an old `(taskId, seq)`, a late file answer for a `diffId` the state has since moved
 * past, or a file answer a newer re-request has already superseded, is a no-op that returns the
 * SAME state object — the tests assert this with `toBe`.
 *
 * Two things that are NOT part of either race, by design:
 *  - `editor` holds the human's own typing, not a fact about the current diff. It survives a
 *    same-card reload and a stale-diff reload untouched but for `outdated` flipping to `true`;
 *    only a non-ok summary (landed/conflicted/no-branch), switching to a different card, or an
 *    explicit `closeEditor` clears it.
 *  - `expanded` is the human's own choice of what is open, not a fact about the current diff
 *    either — a reload keeps it, and only a diffId change prunes paths that stopped existing.
 */
import type {
  DiffFile,
  DiffFileEntry,
  DiffFileResult,
  DiffLine,
  DiffSide,
  DiffSummaryResult,
  ReviewComment,
} from '@tm/shared/review';
import { DIFF_COLLAPSE_LINES } from '@tm/shared/review';

export type FileLoad =
  | { status: 'idle'; error?: string } // never fetched, or a failed fetch (message kept)
  | { status: 'loading'; seq: number }
  | { status: 'loaded'; file: DiffFile }
  | { status: 'tooLarge'; bytes: number } // DiffFile.tooLarge was set
  | { status: 'stale'; currentDiffId: string }; // answered DiffStale

export interface CommentAnchor {
  path: string;
  side: DiffSide;
  line: number;
}

/** `start`/`anchor` are ordered by rendered position: `start` is always the earlier line. */
export interface CommentEditor {
  path: string;
  anchor: { side: DiffSide; line: number };
  start?: { side: DiffSide; line: number };
  draft: string;
  commentId?: string; // editing an existing draft rather than adding a new one
  outdated: boolean; // the diff moved on since the editor opened (drafts are kept)
}

export interface ReviewState {
  taskId: string | null;
  /** The newest load sequence number this state has accepted a summary for. */
  applied: number;
  loading: boolean;
  summary: DiffSummaryResult | null;
  /** `summary.status === 'ok' ? summary.summary.diffId : null`. */
  diffId: string | null;
  /** A file answer said the worktree moved on → the pane offers Reload. */
  staleDiffId: string | null;
  selectedPath: string | null;
  expanded: readonly string[];
  files: Readonly<Record<string, FileLoad>>;
  /** The last plain-clicked line, which Shift-click extends from. */
  rangeAnchor: CommentAnchor | null;
  editor: CommentEditor | null;
}

export const EMPTY_REVIEW: ReviewState = {
  taskId: null,
  applied: 0,
  loading: false,
  summary: null,
  diffId: null,
  staleDiffId: null,
  selectedPath: null,
  expanded: [],
  files: {},
  rangeAnchor: null,
  editor: null,
};

/** Whether an answer carrying `(taskId, seq)` is still the frontier `state` accepts. */
export function reviewAccepts(s: ReviewState, taskId: string | null, seq: number): boolean {
  return taskId === s.taskId && seq >= s.applied;
}

/**
 * A summary load began. Switching to a different card resets everything to empty, including
 * the editor, since none of it belongs to the new card. Reloading the SAME card (a poll, or
 * after a stale-diff Reload) keeps `selectedPath`, `expanded`, `files` and `editor` on screen —
 * only `applied` and `loading` change.
 */
export function summaryLoadStarted(
  s: ReviewState,
  taskId: string | null,
  seq: number,
): ReviewState {
  if (seq < s.applied) return s;
  if (taskId === s.taskId) return { ...s, applied: seq, loading: true };
  return { ...EMPTY_REVIEW, taskId, applied: seq, loading: true };
}

/**
 * A summary answered. Refused unless `reviewAccepts`. The same `diffId` changes nothing but
 * `summary` and `loading` — a poll. A new `diffId` is a stale reload: `files` resets to `{}` so
 * the expanded ones are fetched again, `expanded`/`selectedPath` are pruned to paths still in
 * the summary, `staleDiffId` clears, and the editor is kept with `outdated: true` even when its
 * path vanished. A non-ok result (landed/conflicted/no-branch) clears `files`, `expanded`, the
 * selection and the anchor — the editor stays, since its draft text is the human's.
 */
export function summaryArrived(
  s: ReviewState,
  taskId: string | null,
  seq: number,
  result: DiffSummaryResult,
): ReviewState {
  if (!reviewAccepts(s, taskId, seq)) return s;
  if (result.status !== 'ok') {
    return {
      ...s,
      loading: false,
      summary: result,
      diffId: null,
      files: {},
      expanded: [],
      selectedPath: null,
      rangeAnchor: null,
    };
  }
  const diffId = result.summary.diffId;
  if (diffId === s.diffId) return { ...s, loading: false, summary: result };
  const paths = new Set(result.summary.files.map((f) => f.path));
  return {
    ...s,
    loading: false,
    summary: result,
    diffId,
    staleDiffId: null,
    files: {},
    expanded: s.expanded.filter((p) => paths.has(p)),
    selectedPath: s.selectedPath !== null && paths.has(s.selectedPath) ? s.selectedPath : null,
    editor: s.editor === null ? null : { ...s.editor, outdated: true },
  };
}

/** A summary load failed. Refused unless `reviewAccepts`; only clears `loading`. */
export function summaryFailed(s: ReviewState, taskId: string | null, seq: number): ReviewState {
  if (!reviewAccepts(s, taskId, seq)) return s;
  return { ...s, loading: false };
}

/** Selects `path` and expands it — the host scrolls to it. A no-op if already selected+expanded. */
export function selectFile(s: ReviewState, path: string): ReviewState {
  if (s.selectedPath === path && s.expanded.includes(path)) return s;
  return {
    ...s,
    selectedPath: path,
    expanded: s.expanded.includes(path) ? s.expanded : [...s.expanded, path],
  };
}

/** Expands `path` if collapsed, collapses it if expanded. */
export function toggleExpanded(s: ReviewState, path: string): ReviewState {
  const expanded = s.expanded.includes(path)
    ? s.expanded.filter((p) => p !== path)
    : [...s.expanded, path];
  return { ...s, expanded };
}

function pathListed(s: ReviewState, path: string): boolean {
  return s.summary?.status === 'ok' && s.summary.summary.files.some((f) => f.path === path);
}

/**
 * A file's load began. Refused unless the task matches, `diffId === s.diffId` and the path is
 * in the current summary. Sets the path to `loading { seq }`.
 */
export function fileLoadStarted(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  seq: number,
): ReviewState {
  if (taskId !== s.taskId || diffId !== s.diffId || !pathListed(s, path)) return s;
  return { ...s, files: { ...s.files, [path]: { status: 'loading', seq } } };
}

function isLoadingThisSeq(load: FileLoad | undefined, seq: number): boolean {
  return load !== undefined && load.status === 'loading' && load.seq === seq;
}

/**
 * A file answered. A no-op unless the task matches, `diffId === s.diffId` (a late answer for an
 * old diffId is dropped) and the path is `loading` with this exact `seq` (a newer re-request
 * wins). An `ok` answer becomes `tooLarge` when `file.tooLarge` is set, `loaded` otherwise. A
 * `stale` answer becomes `stale` and sets `staleDiffId`.
 */
export function fileArrived(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  seq: number,
  result: DiffFileResult,
): ReviewState {
  if (taskId !== s.taskId || diffId !== s.diffId || !isLoadingThisSeq(s.files[path], seq)) {
    return s;
  }
  const fileLoad: FileLoad =
    result.status === 'ok'
      ? result.file.tooLarge
        ? { status: 'tooLarge', bytes: result.file.tooLarge.bytes }
        : { status: 'loaded', file: result.file }
      : { status: 'stale', currentDiffId: result.currentDiffId };
  return {
    ...s,
    files: { ...s.files, [path]: fileLoad },
    staleDiffId: result.status === 'stale' ? result.currentDiffId : s.staleDiffId,
  };
}

/** A file's load failed. Same guards as {@link fileArrived}; sets the path to `idle { error }`. */
export function fileFailed(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  seq: number,
  error: string,
): ReviewState {
  if (taskId !== s.taskId || diffId !== s.diffId || !isLoadingThisSeq(s.files[path], seq)) {
    return s;
  }
  return { ...s, files: { ...s.files, [path]: { status: 'idle', error } } };
}

function flattenLines(file: DiffFile): readonly DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.lines);
}

/**
 * The index of `(side, line)` in `file`'s hunks, flattened in rendered order, or `null` when it
 * is not in any loaded hunk. Old and new line numbers do not compare across a unified diff, so
 * this is how a range's two endpoints get ordered.
 */
export function renderedIndex(file: DiffFile, side: DiffSide, line: number): number | null {
  const lines = flattenLines(file);
  for (let i = 0; i < lines.length; i++) {
    const diffLine = lines[i];
    if (side === 'old' ? diffLine.oldLine === line : diffLine.newLine === line) return i;
  }
  return null;
}

function openRange(
  s: ReviewState,
  anchor: CommentAnchor,
  clicked: { path: string; side: DiffSide; line: number },
): ReviewState {
  const load = s.files[clicked.path];
  const file = load?.status === 'loaded' ? load.file : null;
  const anchorIdx = file === null ? null : renderedIndex(file, anchor.side, anchor.line);
  const clickedIdx = file === null ? null : renderedIndex(file, clicked.side, clicked.line);
  const anchorFirst = anchorIdx !== null && clickedIdx !== null ? anchorIdx <= clickedIdx : true;
  const [start, end] = anchorFirst ? [anchor, clicked] : [clicked, anchor];
  return {
    ...s,
    rangeAnchor: anchor,
    editor: {
      path: clicked.path,
      anchor: { side: end.side, line: end.line },
      start: { side: start.side, line: start.line },
      draft: '',
      outdated: false,
    },
  };
}

/**
 * A gutter click. A plain click sets `rangeAnchor` and opens the editor on that one line. A
 * Shift-click on the same path as an existing `rangeAnchor` opens a range instead, ordered by
 * rendered position so it reads correctly regardless of which end was clicked first; a
 * Shift-click with no anchor, or on another file, acts as a plain click. Either way, a click is
 * refused while the editor already holds a draft — plain or ranged, clicking elsewhere must
 * never silently drop what the human already typed.
 */
export function clickLine(
  s: ReviewState,
  click: { path: string; side: DiffSide; line: number },
  shift: boolean,
): ReviewState {
  if (s.editor !== null) return s;
  if (shift && s.rangeAnchor !== null && s.rangeAnchor.path === click.path) {
    return openRange(s, s.rangeAnchor, click);
  }
  const { path, side, line } = click;
  return {
    ...s,
    rangeAnchor: { path, side, line },
    editor: { path, anchor: { side, line }, draft: '', outdated: false },
  };
}

/** Edits the open editor's draft text. A no-op if there is no editor, or the text is unchanged. */
export function editDraft(s: ReviewState, text: string): ReviewState {
  if (s.editor === null || s.editor.draft === text) return s;
  return { ...s, editor: { ...s.editor, draft: text } };
}

/** Opens the editor on an existing comment, to edit it. `outdated` reflects `s.diffId` now. */
export function openExistingDraft(s: ReviewState, comment: ReviewComment): ReviewState {
  return {
    ...s,
    rangeAnchor: { path: comment.path, side: comment.side, line: comment.line },
    editor: {
      path: comment.path,
      anchor: { side: comment.side, line: comment.line },
      start: comment.start,
      draft: comment.body,
      commentId: comment.id,
      outdated: comment.diffId !== s.diffId,
    },
  };
}

/** Closes the editor. The host calls this after a successful save or a cancel. */
export function closeEditor(s: ReviewState): ReviewState {
  if (s.editor === null) return s;
  return { ...s, editor: null };
}

/**
 * The expanded paths that still need a fetch: `idle` with no error. Once `staleDiffId` is set
 * this returns `[]`, because the pane must offer Reload rather than refetch blindly against a
 * diff that is already known to be behind.
 */
export function filesToLoad(s: ReviewState): readonly string[] {
  if (s.staleDiffId !== null) return [];
  return s.expanded.filter((path) => {
    const load = s.files[path];
    return load === undefined || (load.status === 'idle' && load.error === undefined);
  });
}

/**
 * The rendered `DiffLine`s `editor`'s excerpt covers, in `file`. Flattening the hunks first
 * means slicing between two rendered indices never invents a line for an unloaded gap between
 * hunks — it simply is not in the flattened array to begin with.
 */
export function rangeLines(file: DiffFile, editor: CommentEditor): readonly DiffLine[] {
  const start = editor.start ?? editor.anchor;
  const startIdx = renderedIndex(file, start.side, start.line);
  const endIdx = renderedIndex(file, editor.anchor.side, editor.anchor.line);
  if (startIdx === null || endIdx === null) return [];
  return flattenLines(file).slice(startIdx, endIdx + 1);
}

/** Whether `entry` collapses by default: a generated or simply huge file. */
export function isCollapsedByDefault(entry: DiffFileEntry): boolean {
  return entry.additions + entry.deletions > DIFF_COLLAPSE_LINES;
}
