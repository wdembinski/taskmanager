/**
 * The Changes pane's file tree, diff reads and comment editor, kept as a pure state machine —
 * same reasons as `taskTimeline.ts` and `issues/issueBrowserState.ts`: this workspace has no DOM
 * test harness (no jsdom, no testing-library), so the only way to prove the pane's races are
 * closed is to pull its transitions out of the component and test them as plain functions.
 *
 * Three races, one counter each, all minted from the pane's one shared `seq` counter. `ReviewPane`
 * fetches a summary, then — lazily, per expanded file — each file's patch, and separately
 * `review:list`'s comments, and none of those awaits are guaranteed to land in request order.
 * `applied` is the newest load this state has accepted a summary for (`reviewAccepts`);
 * `commentsSeq` is the same idea for comments; each file's own `loading { seq }` is a SEPARATE
 * frontier again, since files load independently of each other, of the summary and of comments. A
 * late summary answer for an old `(taskId, seq)`, a late comments answer the same way, a late file
 * answer for a `diffId` the state has since moved past, or a file answer a newer re-request has
 * already superseded, is a no-op that returns the SAME state object — the tests assert this with
 * `toBe`.
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
  DiffStale,
  DiffSummaryResult,
  ReviewComment,
  ReviewCommentSent,
  ReviewSendResult,
} from '@tm/shared/review';
import { DIFF_COLLAPSE_LINES } from '@tm/shared/review';
import { parseOversizedAnswer } from '@tm/shared/ipcRelay';

export type FileLoad =
  | { status: 'idle'; error?: string } // never fetched, or a failed fetch (message kept)
  | { status: 'loading'; seq: number }
  | { status: 'loaded'; file: DiffFile }
  | { status: 'tooLarge'; bytes: number } // DiffFile.tooLarge was set
  | { status: 'stale'; currentDiffId: string } // answered DiffStale
  | { status: 'tooLargeForBrowser'; bytes: number }; // the relay itself refused the answer

export interface CommentAnchor {
  path: string;
  side: DiffSide;
  line: number;
}

/** A tap-selected line or line range, before a comment is started on it. Same `anchor`/`start`
 * shape and rendered-order rule as {@link CommentEditor} — `start` is always the earlier line. */
export interface LineSelection {
  path: string;
  anchor: { side: DiffSide; line: number };
  start?: { side: DiffSide; line: number };
}

/** `start`/`anchor` are ordered by rendered position: `start` is always the earlier line. */
export interface CommentEditor {
  path: string;
  anchor: { side: DiffSide; line: number };
  start?: { side: DiffSide; line: number };
  draft: string;
  commentId?: string; // editing an existing draft rather than adding a new one
  outdated: boolean; // the diff moved on since the editor opened (drafts are kept)
  saving: boolean;
  error?: string; // a refused save's message; the draft is kept
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
  /** The tap-selected line or range (compact mode), before a comment is started on it. */
  selection: LineSelection | null;
  editor: CommentEditor | null;
  /** Every draft and sent comment on this card's review, in no particular order. */
  comments: readonly ReviewComment[];
  /** The newest load sequence number this state has accepted a `review:list` answer for. */
  commentsSeq: number;
  /** The note that goes out alongside the batched drafts when Send review runs. */
  note: string;
  sending: boolean;
  sendError: string | null;
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
  selection: null,
  editor: null,
  comments: [],
  commentsSeq: 0,
  note: '',
  sending: false,
  sendError: null,
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
 * selection and the anchor — the editor stays, since its draft text is the human's. `selection`
 * clears whenever `diffId` changes or the result is non-ok, same reason as `files` resetting —
 * line numbers from the old diff don't mean the same thing any more.
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
      selection: null,
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
    selection: null,
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

/**
 * A file's load failed. Same guards as {@link fileArrived}; sets the path to `idle { error }`,
 * unless the relay itself refused the answer for being too large to ever send — then it becomes
 * `tooLargeForBrowser`, which `filesToLoad` never refetches since it is not `idle`.
 */
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
  const bytes = parseOversizedAnswer(error);
  const fileLoad: FileLoad =
    bytes === null ? { status: 'idle', error } : { status: 'tooLargeForBrowser', bytes };
  return { ...s, files: { ...s.files, [path]: fileLoad } };
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

/**
 * Orders `a` and `b` by rendered position in `path`'s loaded file — the earlier one first. Old
 * and new line numbers do not compare across a unified diff, so this is the only way to know
 * which of two endpoints comes first on screen. Falls back to `a` first when the file is not
 * loaded or either endpoint is not in any loaded hunk.
 */
function orderEndpoints<T extends { side: DiffSide; line: number }>(
  s: ReviewState,
  path: string,
  a: T,
  b: T,
): [T, T] {
  const load = s.files[path];
  const file = load?.status === 'loaded' ? load.file : null;
  const aIdx = file === null ? null : renderedIndex(file, a.side, a.line);
  const bIdx = file === null ? null : renderedIndex(file, b.side, b.line);
  const aFirst = aIdx !== null && bIdx !== null ? aIdx <= bIdx : true;
  return aFirst ? [a, b] : [b, a];
}

function openRange(
  s: ReviewState,
  anchor: CommentAnchor,
  clicked: { path: string; side: DiffSide; line: number },
): ReviewState {
  const [start, end] = orderEndpoints(s, clicked.path, anchor, clicked);
  return {
    ...s,
    rangeAnchor: anchor,
    editor: {
      path: clicked.path,
      anchor: { side: end.side, line: end.line },
      start: { side: start.side, line: start.line },
      draft: '',
      outdated: false,
      saving: false,
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
    editor: { path, anchor: { side, line }, draft: '', outdated: false, saving: false },
  };
}

/**
 * A tap on a gutter line (compact mode's stand-in for click/Shift-click, which touch has no
 * modifier key for). Refused (same object) while the editor already holds a draft, the same
 * rule as {@link clickLine} — a tap elsewhere must never silently drop what the human already
 * typed. With no selection, or a single selection on another path, the tap starts a new single
 * selection. Tapping the same line again as a single selection cancels it. Tapping a different
 * line in the same file extends it into a range, ordered by rendered position regardless of
 * which end was tapped first. Any tap while a range is already selected starts a new single
 * selection at the tapped line instead of extending further.
 */
export function tapLine(
  s: ReviewState,
  tap: { path: string; side: DiffSide; line: number },
): ReviewState {
  if (s.editor !== null) return s;
  const sel = s.selection;
  if (sel !== null && sel.start === undefined && sel.path === tap.path) {
    if (sel.anchor.side === tap.side && sel.anchor.line === tap.line) {
      return { ...s, selection: null };
    }
    const [start, end] = orderEndpoints(s, tap.path, sel.anchor, tap);
    return {
      ...s,
      selection: {
        path: tap.path,
        anchor: { side: end.side, line: end.line },
        start: { side: start.side, line: start.line },
      },
    };
  }
  return { ...s, selection: { path: tap.path, anchor: { side: tap.side, line: tap.line } } };
}

/** Clears the tap selection. Same object when there is already none. */
export function cancelSelection(s: ReviewState): ReviewState {
  if (s.selection === null) return s;
  return { ...s, selection: null };
}

/**
 * Starts a comment from the current tap selection — the same editor shape `openRange`/`clickLine`
 * build, with `start` set only for a range — and clears `selection`. Refused (same object) when
 * there is no selection, the editor is already open, or `canComment(s)` is false.
 */
export function commentOnSelection(s: ReviewState): ReviewState {
  if (s.selection === null || s.editor !== null || !canComment(s)) return s;
  const sel = s.selection;
  return {
    ...s,
    rangeAnchor: { path: sel.path, side: sel.anchor.side, line: sel.anchor.line },
    selection: null,
    editor: {
      path: sel.path,
      anchor: sel.anchor,
      start: sel.start,
      draft: '',
      outdated: false,
      saving: false,
    },
  };
}

/** Edits the open editor's draft text. A no-op if there is no editor, or the text is unchanged. */
export function editDraft(s: ReviewState, text: string): ReviewState {
  if (s.editor === null || s.editor.draft === text) return s;
  return { ...s, editor: { ...s.editor, draft: text } };
}

/**
 * Opens the editor on an existing comment, to edit it. `outdated` reflects `s.diffId` now.
 * Refused (same object) for a comment that has already gone out in a review message — it is no
 * longer a draft to edit.
 */
export function openExistingDraft(s: ReviewState, comment: ReviewComment): ReviewState {
  if (comment.sentAt !== null) return s;
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
      saving: false,
    },
  };
}

/** Closes the editor. The host calls this after a successful save or a cancel. */
export function closeEditor(s: ReviewState): ReviewState {
  if (s.editor === null) return s;
  return { ...s, editor: null };
}

/** Whether an answer carrying `(taskId, seq)` is still the frontier `state` accepts for comments. */
function commentsAccepted(s: ReviewState, taskId: string | null, seq: number): boolean {
  return taskId === s.taskId && seq >= s.commentsSeq;
}

/** A `review:list` fetch began. Refused (same object) for a foreign `taskId` or a seq the
 * frontier has already moved past. Bumps the frontier forward so a late answer for this load's
 * own seq is still accepted, but an older in-flight one is dropped once this one lands first. */
export function commentsLoadStarted(
  s: ReviewState,
  taskId: string | null,
  seq: number,
): ReviewState {
  if (!commentsAccepted(s, taskId, seq)) return s;
  return { ...s, commentsSeq: seq };
}

/** A `review:list` answer arrived. Refused unless `commentsAccepted`; replaces the list wholesale. */
export function commentsArrived(
  s: ReviewState,
  taskId: string | null,
  seq: number,
  comments: readonly ReviewComment[],
): ReviewState {
  if (!commentsAccepted(s, taskId, seq)) return s;
  return { ...s, commentsSeq: seq, comments };
}

function upsertComment(
  comments: readonly ReviewComment[],
  comment: ReviewComment,
): readonly ReviewComment[] {
  const idx = comments.findIndex((c) => c.id === comment.id);
  if (idx === -1) return [...comments, comment];
  const next = comments.slice();
  next[idx] = comment;
  return next;
}

/** A comment save began. A no-op if there is no editor. Clears a previous refusal's message. */
export function saveStarted(s: ReviewState): ReviewState {
  if (s.editor === null) return s;
  return { ...s, editor: { ...s.editor, saving: true, error: undefined } };
}

/**
 * A comment save succeeded. Refused (same object) for a foreign `taskId`. Upserts by `id`, and
 * closes the editor only if it is still the one that was saved — a brand new draft (there is
 * only ever one editor open at a time, so a save in flight for a new draft can only be this
 * one), or an edit of this exact comment.
 */
export function commentSaved(
  s: ReviewState,
  taskId: string | null,
  comment: ReviewComment,
): ReviewState {
  if (taskId !== s.taskId) return s;
  const comments = upsertComment(s.comments, comment);
  const closes =
    s.editor !== null && (s.editor.commentId === undefined || s.editor.commentId === comment.id);
  return { ...s, comments, editor: closes ? null : s.editor };
}

function saveRefusalMessage(result: DiffStale | ReviewCommentSent | { error: string }): string {
  if (!('status' in result)) return result.error;
  return result.status === 'stale' ? 'the diff moved on — reload' : 'already sent';
}

/**
 * A comment save was refused. Refused (same object) for a foreign `taskId` or no open editor.
 * Keeps the draft, sets `editor.error` and clears `saving`. A `stale` refusal also sets
 * `staleDiffId`, same as a file's own stale answer.
 */
export function saveRefused(
  s: ReviewState,
  taskId: string | null,
  result: DiffStale | ReviewCommentSent | { error: string },
): ReviewState {
  if (taskId !== s.taskId || s.editor === null) return s;
  return {
    ...s,
    staleDiffId:
      'status' in result && result.status === 'stale' ? result.currentDiffId : s.staleDiffId,
    editor: { ...s.editor, saving: false, error: saveRefusalMessage(result) },
  };
}

/**
 * A comment was deleted. Refused (same object) for a foreign `taskId`. Removes it, and closes
 * the editor if it was the one editing this comment.
 */
export function commentDeleted(s: ReviewState, taskId: string | null, id: string): ReviewState {
  if (taskId !== s.taskId) return s;
  const comments = s.comments.filter((c) => c.id !== id);
  const editor = s.editor !== null && s.editor.commentId === id ? null : s.editor;
  return { ...s, comments, editor };
}

/** Edits the note that goes out with Send review. A no-op if the text is unchanged. */
export function editNote(s: ReviewState, text: string): ReviewState {
  if (s.note === text) return s;
  return { ...s, note: text };
}

/** A send began. A no-op if a send is already in flight. Clears a previous refusal's message. */
export function sendStarted(s: ReviewState): ReviewState {
  if (s.sending) return s;
  return { ...s, sending: true, sendError: null };
}

/**
 * `review:send` answered. Refused (same object) for a foreign `taskId` — note this compares
 * against the card `taskId` the pane is showing, not `result.taskId`, which may name the live
 * step that actually received the message rather than the card itself. On `sent`/`resumed`,
 * upserts the returned comments (`sentAt` now stamped) and clears `note`, `sending` and
 * `sendError`. On `refused`, keeps every draft and the note untouched, and sets `sendError` to
 * the refusal reason — `reviewView.ts`'s `sendRefusalText` turns that into a sentence to show.
 */
export function reviewSent(
  s: ReviewState,
  taskId: string | null,
  result: ReviewSendResult,
): ReviewState {
  if (taskId !== s.taskId) return s;
  if (result.status === 'refused') {
    return { ...s, sending: false, sendError: result.reason };
  }
  const comments = result.comments.reduce(upsertComment, s.comments);
  return { ...s, comments, note: '', sending: false, sendError: null };
}

/** How many drafts have not gone out yet — what the Send review button's badge counts. */
export function unsentCount(s: ReviewState): number {
  return s.comments.filter((c) => c.sentAt === null).length;
}

/** The comments whose END anchor is `(path, side, line)` — where `ReviewPane` renders each one,
 * whether it is a single line or the tail of a range. */
export function commentsAt(
  s: ReviewState,
  path: string,
  side: DiffSide,
  line: number,
): readonly ReviewComment[] {
  return s.comments.filter((c) => c.path === path && c.side === side && c.line === line);
}

/**
 * Whether Send review can run: at least one unsent draft, not already sending, and the host
 * is reachable. A note alone never enables it — `reviewService.send` refuses a note-only send
 * as `nothing-to-send`. `readOnly` is `TaskDetail`'s `hostUnreachable` carried down as a plain
 * boolean — the pane cannot send a review the desktop that owns it cannot hear (F6.13).
 */
export function canSend(s: ReviewState, readOnly = false): boolean {
  return !readOnly && unsentCount(s) > 0 && !s.sending;
}

/**
 * Whether a new comment can be started: the summary loaded ok, the diff is not stale, and the
 * host is reachable — see {@link canSend}'s own note on `readOnly`.
 */
export function canComment(s: ReviewState, readOnly = false): boolean {
  return !readOnly && s.summary?.status === 'ok' && s.staleDiffId === null;
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
 * The rendered `DiffLine`s `range`'s excerpt covers, in `file` — `range` is a `CommentEditor` or
 * a `LineSelection`, since both share the same `anchor`/`start` shape. Flattening the hunks
 * first means slicing between two rendered indices never invents a line for an unloaded gap
 * between hunks — it simply is not in the flattened array to begin with.
 */
export function rangeLines(
  file: DiffFile,
  range: Pick<CommentEditor, 'anchor' | 'start'>,
): readonly DiffLine[] {
  const start = range.start ?? range.anchor;
  const startIdx = renderedIndex(file, start.side, start.line);
  const endIdx = renderedIndex(file, range.anchor.side, range.anchor.line);
  if (startIdx === null || endIdx === null) return [];
  return flattenLines(file).slice(startIdx, endIdx + 1);
}

/** Whether `entry` collapses by default: a generated or simply huge file. */
export function isCollapsedByDefault(entry: DiffFileEntry): boolean {
  return entry.additions + entry.deletions > DIFF_COLLAPSE_LINES;
}
