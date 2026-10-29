/**
 * The Changes pane's file tree, diff reads and comment editor, kept as a pure state machine —
 * same reasons as `taskTimeline.ts` and `issues/issueBrowserState.ts`: this workspace has no DOM
 * test harness (no jsdom, no testing-library), so the only way to prove the pane's races are
 * closed is to pull its transitions out of the component and test them as plain functions.
 *
 * Several races, one counter each, all minted from the pane's one shared `seq` counter. `ReviewPane`
 * fetches a summary, then — lazily, per expanded file — each file's patch, separately
 * `review:list`'s comments, separately the viewed marks, and separately still a context-expansion
 * answer per gap, and none of those awaits are guaranteed to land in request order.
 * `applied` is the newest load this state has accepted a summary for (`reviewAccepts`);
 * `commentsSeq` is the same idea for comments; `viewedSeq` the same again for `viewedMarks` (loaded
 * wholesale, just like `comments`); each file's own `loading { seq }` is a SEPARATE frontier again,
 * since files load independently of each other, of the summary and of comments. `context` takes
 * that one step further: it is keyed by `[path][low]` — `low` being the gap's own low bound
 * *captured at request time* — so two different gaps in the same file, or the same gap re-requested
 * after the file reloads, each get their own independent `loading { seq }` frontier rather than
 * colliding on one counter per file. A late summary answer for an old `(taskId, seq)`, a late
 * comments or viewed-marks answer the same way, a late file or context answer for a `diffId` the
 * state has since moved past, or a file/context answer a newer re-request has already superseded,
 * is a no-op that returns the SAME state object — the tests assert this with `toBe`.
 *
 * Things that are NOT part of any race, by design:
 *  - `editor` holds the human's own typing, not a fact about the current diff. It survives a
 *    same-card reload and a stale-diff reload untouched but for `outdated` flipping to `true`;
 *    only a non-ok summary (landed/conflicted/no-branch), switching to a different card, or an
 *    explicit `closeEditor` clears it.
 *  - `expanded` is the human's own choice of what is open, not a fact about the current diff
 *    either — a reload keeps it, and only a diffId change prunes paths that stopped existing.
 *  - `selection` is the compact pane's own tap-to-select stand-in for `rangeAnchor` plus a
 *    Shift-click — touch has no modifier key, so `tapLine` builds the same anchor/start shape
 *    across two taps instead, and only ever turns into `editor` through `commentOnSelection`.
 *    Unlike `editor`, it never survives a diffId change: `summaryArrived` clears it the same
 *    moment `files` resets, since line numbers from the old diff don't mean the same thing
 *    any more.
 *  - `hunkIndex` is the selected file's own cursor — `n`/`p`/`j`/`k` move it directly, with no
 *    fetch behind it, the same way `selectFile`/`toggleExpanded` move `selectedPath`/`expanded`
 *    with no fetch behind them either. `setViewed`'s own write to `viewedMarks` is the same kind
 *    of thing: an optimistic local edit the human's `v` keypress makes directly, never going
 *    through `viewedSeq` — only the *load* of `viewedMarks` is race-guarded, not every write to it.
 *  - `draftDecided` is the same kind of optimistic local edit again: Keep/Dismiss/Restore on an
 *    AI draft stamps `acceptedAt`/`dismissedAt` with the server's own rules the moment the
 *    human clicks, and the server's answer is reconciled through `commentSaved`'s upsert like
 *    any other save. `showDismissed` is the human's own choice, like `expanded` — but it
 *    belongs to one subject, so a new subject resets it with everything else.
 *
 * AI drafts (`origin: 'ai'`) are only the human's once accepted (editing accepts too, on the
 * server). Every count and send reads {@link sendableDrafts} — the shared `isSendableDraft`
 * predicate — so an unaccepted or dismissed AI draft never counts as unsent and never enables
 * Send; {@link visibleComments} hides dismissed ones unless `showDismissed` is on.
 */
import type {
  DiffContextResult,
  DiffFile,
  DiffFileEntry,
  DiffFileResult,
  DiffLine,
  DiffSide,
  DiffStale,
  DiffSummaryResult,
  ReviewComment,
  ReviewCommentPatch,
  ReviewCommentSent,
  ReviewSendResult,
  ReviewViewedMark,
  ViewedStatus,
} from '@tm/shared/review';
import {
  DIFF_COLLAPSE_LINES,
  DIFF_CONTEXT_MAX_LINES,
  endLine,
  expandContext,
  firstLine,
  isSendableDraft,
  taskSubjectId,
  viewedState,
} from '@tm/shared/review';
import { parseOversizedAnswer } from '@tm/shared/ipcRelay';

/** A leaf: one changed file. */
export interface FileTreeFile {
  kind: 'file';
  entry: DiffFileEntry;
}

/**
 * A branch. `name` is the collapsed chain's whole label (`src/main/review`), `path` is that
 * same chain's full repo-relative prefix — identical to `name` when the chain starts at the
 * root, longer when an ancestor chain collapsed above it too.
 */
export interface FileTreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: FileTreeNode[];
}

export type FileTreeNode = FileTreeDir | FileTreeFile;

type RawDir = { kind: 'dir'; children: Map<string, RawNode> };
type RawNode = RawDir | { kind: 'file'; entry: DiffFileEntry };

function insert(root: RawDir, entry: DiffFileEntry): void {
  const parts = entry.path.split('/');
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const existing = node.children.get(part);
    const dir: RawDir =
      existing && existing.kind === 'dir' ? existing : { kind: 'dir', children: new Map() };
    node.children.set(part, dir);
    node = dir;
  }
  node.children.set(parts[parts.length - 1], { kind: 'file', entry });
}

/**
 * Walks `name`/`node` down a chain of directories that each hold exactly one child, and that
 * child is itself a directory — `src` → `main` → `review` becomes one node labelled
 * `src/main/review` whose children are `review`'s own. Stops at the first directory that holds
 * more than one entry, or whose only entry is a file.
 */
function collapseChain(name: string, node: RawDir): { name: string; node: RawDir } {
  let label = name;
  let current = node;
  while (current.children.size === 1) {
    const [[onlyName, onlyChild]] = current.children;
    if (onlyChild.kind !== 'dir') break;
    label = `${label}/${onlyName}`;
    current = onlyChild;
  }
  return { name: label, node: current };
}

/** Directories first, then files, each alphabetically by its own displayed name. */
function buildChildren(node: RawDir, parentPath: string): FileTreeNode[] {
  const dirs: FileTreeDir[] = [];
  const files: FileTreeFile[] = [];
  for (const [key, child] of node.children) {
    if (child.kind === 'file') {
      files.push({ kind: 'file', entry: child.entry });
      continue;
    }
    const { name, node: collapsed } = collapseChain(key, child);
    const path = parentPath ? `${parentPath}/${name}` : name;
    dirs.push({ kind: 'dir', name, path, children: buildChildren(collapsed, path) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
  return [...dirs, ...files];
}

/**
 * Groups `entries` by directory into a tree, collapsing a chain of single-child directories
 * into one node (`src/main/review`) the way `FileTree.tsx` wants to render it — one branch per
 * meaningful fork, not one per path segment. Lives here, not in `reviewView.ts`, because
 * `navigationOrder` (below) needs it and `reviewView.ts` already imports runtime values from
 * this module — the other way round would be a genuine import cycle. `reviewView.ts` re-exports
 * this and the three `FileTree*` types unchanged.
 */
export function buildFileTree(entries: readonly DiffFileEntry[]): FileTreeNode[] {
  const root: RawDir = { kind: 'dir', children: new Map() };
  for (const entry of entries) insert(root, entry);
  return buildChildren(root, '');
}

/**
 * `entries` flattened into the leaf order `FileTree.tsx` renders them in — depth first,
 * directories in their already-sorted order — what `nextFile`/`prevFile` step through.
 */
export function navigationOrder(entries: readonly DiffFileEntry[]): readonly string[] {
  const order: string[] = [];
  const walk = (nodes: readonly FileTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'file') order.push(node.entry.path);
      else walk(node.children);
    }
  };
  walk(buildFileTree(entries));
  return order;
}

export type FileLoad =
  | { status: 'idle'; error?: string } // never fetched, or a failed fetch (message kept)
  | { status: 'loading'; seq: number }
  | { status: 'loaded'; file: DiffFile }
  | { status: 'tooLarge'; bytes: number } // DiffFile.tooLarge was set
  | { status: 'stale'; currentDiffId: string } // answered DiffStale
  | { status: 'tooLargeForBrowser'; bytes: number }; // the relay itself refused the answer

/**
 * One gap's context-expansion load state, keyed by `[path][low]` — see {@link gapBounds} for
 * what `low` means. No `stale`/`tooLargeForBrowser` variants: a stale answer only ever sets
 * `staleDiffId` and leaves the entry `loading` (see the header comment), and `review:context`
 * has no oversized-relay-answer path the way a whole-file read does.
 */
export type ContextLoad =
  | { status: 'loading'; seq: number }
  | { status: 'tooLarge'; bytes: number }
  | { status: 'idle'; error?: string };

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
  /** Files this card's human has marked read — subject-keyed, not task-keyed; see the header
   *  comment and `setViewed`'s own docs for the `taskId` → `subjectId` bridge. */
  viewedMarks: readonly ReviewViewedMark[];
  /** The newest load sequence number this state has accepted a viewed-marks answer for. */
  viewedSeq: number;
  /** Context-expansion load state, keyed by `[path][low]` — see {@link gapBounds}. */
  context: Readonly<Record<string, Readonly<Record<number, ContextLoad>>>>;
  /** The selected file's current hunk, moved by `n`/`j`/`k`; `null` until a hunk key first moves
   *  it, same as `selectedPath` is `null` before any file is selected. */
  hunkIndex: number | null;
  /** The note that goes out alongside the batched drafts when Send review runs. */
  note: string;
  sending: boolean;
  sendError: string | null;
  /** Whether dismissed AI drafts are shown (dimmed, with Restore) — "show dismissed (N)". */
  showDismissed: boolean;
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
  viewedMarks: [],
  viewedSeq: 0,
  context: {},
  hunkIndex: null,
  note: '',
  sending: false,
  sendError: null,
  showDismissed: false,
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
 * line numbers from the old diff don't mean the same thing any more. `context` resets to `{}` in
 * both branches alongside `files`, for the same reason: a gap's bounds only mean something
 * against the hunks they were computed from.
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
      context: {},
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
    context: {},
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

/**
 * Selects `path` and expands it — the host scrolls to it — and resets `hunkIndex` to `null`,
 * since a cursor position in one file's hunks means nothing in another's. A no-op if `path` is
 * already selected and expanded — `toggleViewedAndAdvance` relies on that early return to leave
 * `hunkIndex` untouched when it lands back on the same file because nothing else qualified.
 */
export function selectFile(s: ReviewState, path: string): ReviewState {
  if (s.selectedPath === path && s.expanded.includes(path)) return s;
  return {
    ...s,
    selectedPath: path,
    expanded: s.expanded.includes(path) ? s.expanded : [...s.expanded, path],
    hunkIndex: null,
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
 * in the current summary. Sets the path to `loading { seq }`, and clears any context-expansion
 * state for it — a refetch invalidates any gap bounds computed against its previous hunks.
 */
export function fileLoadStarted(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  seq: number,
): ReviewState {
  if (taskId !== s.taskId || diffId !== s.diffId || !pathListed(s, path)) return s;
  return {
    ...s,
    files: { ...s.files, [path]: { status: 'loading', seq } },
    context: { ...s.context, [path]: {} },
  };
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
 * longer a draft to edit. An AI draft opens like any other (its Edit action): saving it sends a
 * `body` through `review:update`, which the server turns into acceptance.
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

/**
 * The human's verdict on an AI draft, stamped locally before `review:update` answers — the
 * same rules the server applies: `accept` sets `acceptedAt` and clears `dismissedAt`;
 * `dismiss` sets `dismissedAt` and clears `acceptedAt`; `restore` clears `dismissedAt`.
 * Refused (same object) for a foreign `taskId`, an unknown id, a comment that has already gone
 * out, or a human draft. The server's answer lands through {@link commentSaved}'s upsert.
 */
export function draftDecided(
  s: ReviewState,
  taskId: string | null,
  id: string,
  decision: NonNullable<ReviewCommentPatch['decision']>,
  now: number,
): ReviewState {
  if (taskId !== s.taskId) return s;
  const existing = s.comments.find((c) => c.id === id);
  if (existing === undefined || existing.sentAt !== null || !isAiDraft(existing)) return s;
  const stamps =
    decision === 'accept'
      ? { acceptedAt: now, dismissedAt: null }
      : decision === 'dismiss'
        ? { acceptedAt: null, dismissedAt: now }
        : { dismissedAt: null };
  return { ...s, comments: upsertComment(s.comments, { ...existing, ...stamps }) };
}

/** Flips "show dismissed (N)". */
export function toggleShowDismissed(s: ReviewState): ReviewState {
  return { ...s, showDismissed: !s.showDismissed };
}

/** Whether `c` was written by the AI reviewer rather than the human. */
export function isAiDraft(c: ReviewComment): boolean {
  return c.origin === 'ai';
}

/** An AI draft still waiting on Keep/Edit/Dismiss: unsent, neither accepted nor dismissed. */
export function isAwaitingDecision(c: ReviewComment): boolean {
  return isAiDraft(c) && c.sentAt === null && c.acceptedAt == null && c.dismissedAt == null;
}

/** How many drafts are dismissed — the N in "show dismissed (N)". */
export function dismissedCount(s: ReviewState): number {
  return s.comments.filter((c) => c.dismissedAt != null).length;
}

/** The comments the diff renders: every one, minus dismissed drafts unless `showDismissed`. */
export function visibleComments(s: ReviewState): readonly ReviewComment[] {
  if (s.showDismissed) return s.comments;
  return s.comments.filter((c) => c.dismissedAt == null);
}

/** The drafts the next review message carries — human drafts and accepted AI drafts. */
export function sendableDrafts(s: ReviewState): readonly ReviewComment[] {
  return s.comments.filter(isSendableDraft);
}

/** How many drafts will go out — what the Send review button's badge and every header count
 * show. Unaccepted and dismissed AI drafts are not counted. */
export function unsentCount(s: ReviewState): number {
  return sendableDrafts(s).length;
}

/** The comments whose END anchor is `(path, side, line)` — where `ReviewPane` renders each one,
 * whether it is a single line or the tail of a range. */
export function commentsAt(
  s: ReviewState,
  path: string,
  side: DiffSide,
  line: number,
): readonly ReviewComment[] {
  return visibleComments(s).filter((c) => c.path === path && c.side === side && c.line === line);
}

/**
 * Whether Send review can run: at least one sendable draft, not already sending, and the host
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

/** Selects the file after `s.selectedPath` in {@link navigationOrder}, wrapping to the first;
 *  `null` selects the first outright. A no-op while the summary is not loaded ok, or empty. */
export function nextFile(s: ReviewState): ReviewState {
  const summary = s.summary;
  if (summary?.status !== 'ok') return s;
  const order = navigationOrder(summary.summary.files);
  if (order.length === 0) return s;
  if (s.selectedPath === null) return selectFile(s, order[0]);
  const idx = order.indexOf(s.selectedPath);
  return selectFile(s, order[(idx + 1) % order.length]);
}

/** Selects the file before `s.selectedPath` in {@link navigationOrder}, wrapping to the last;
 *  `null` selects the last outright. A no-op while the summary is not loaded ok, or empty. */
export function prevFile(s: ReviewState): ReviewState {
  const summary = s.summary;
  if (summary?.status !== 'ok') return s;
  const order = navigationOrder(summary.summary.files);
  if (order.length === 0) return s;
  if (s.selectedPath === null) return selectFile(s, order[order.length - 1]);
  const idx = order.indexOf(s.selectedPath);
  return selectFile(s, order[(idx - 1 + order.length) % order.length]);
}

/**
 * Moves `hunkIndex` forward by one in the selected file's own loaded hunks. A no-op when there
 * is no selection, the file is not `loaded`, it has no hunks, or the cursor is already on the
 * last one. `null` (no cursor yet) moves to the first hunk, `0`.
 */
export function nextHunk(s: ReviewState): ReviewState {
  if (s.selectedPath === null) return s;
  const load = s.files[s.selectedPath];
  if (load?.status !== 'loaded' || load.file.hunks.length === 0) return s;
  if (s.hunkIndex === null) return { ...s, hunkIndex: 0 };
  if (s.hunkIndex >= load.file.hunks.length - 1) return s;
  return { ...s, hunkIndex: s.hunkIndex + 1 };
}

/**
 * Moves `hunkIndex` back by one in the selected file's own loaded hunks. A no-op when there is
 * no selection, the file is not `loaded`, it has no hunks, there is no cursor yet, or the cursor
 * is already on the first hunk — unlike {@link nextHunk}, `null` does not jump anywhere.
 */
export function prevHunk(s: ReviewState): ReviewState {
  if (s.selectedPath === null) return s;
  const load = s.files[s.selectedPath];
  if (load?.status !== 'loaded' || load.file.hunks.length === 0) return s;
  if (s.hunkIndex === null || s.hunkIndex === 0) return s;
  return { ...s, hunkIndex: s.hunkIndex - 1 };
}

/**
 * Marks `path` viewed or unviewed for the card `s.taskId` names, deriving its `subjectId` on
 * the spot — `ReviewState` stays keyed by `taskId` throughout (see the header comment);
 * `ReviewViewedMark` is the one shape shared with drafts and the queue cache that is not.
 * Refused (same object) when there is no `taskId`, the summary is not loaded ok, or `path`
 * is not one of its files. Marking viewed is refused further when that entry has no
 * `newBlobSha` — there is nothing for the mark to key on — and otherwise upserts a mark by
 * `path` and collapses `path` out of `expanded`. Marking unviewed just removes any existing
 * mark and leaves `expanded` alone — unviewing never re-expands. Never touches `viewedSeq`,
 * which belongs to the load race only; there is deliberately no save-ack counterpart, since
 * the optimistic local mark here IS the state until the next `viewedArrived` reconciles it.
 */
export function setViewed(s: ReviewState, path: string, viewed: boolean, now: number): ReviewState {
  const { taskId, summary } = s;
  if (taskId === null || summary?.status !== 'ok') return s;
  const entry = summary.summary.files.find((f) => f.path === path);
  if (entry === undefined) return s;
  if (!viewed) {
    return { ...s, viewedMarks: s.viewedMarks.filter((m) => m.path !== path) };
  }
  if (entry.newBlobSha === undefined) return s;
  const mark: ReviewViewedMark = {
    subjectId: taskSubjectId(taskId),
    path,
    blobSha: entry.newBlobSha,
    viewedAt: now,
  };
  const idx = s.viewedMarks.findIndex((m) => m.path === path);
  const viewedMarks =
    idx === -1 ? [...s.viewedMarks, mark] : s.viewedMarks.map((m, i) => (i === idx ? mark : m));
  return { ...s, viewedMarks, expanded: s.expanded.filter((p) => p !== path) };
}

/**
 * The `v` key: marks the selected file viewed or unviewed via {@link setViewed}, and — only
 * when that turned it ON — advances the selection to the next file after it in
 * {@link navigationOrder} (wrapping) whose status is `'unviewed'` or `'changed'`. Turning a
 * file OFF never advances. A no-op when there is no selection, the summary is not loaded ok,
 * or `setViewed` itself refused; "stays put" (returns the toggle's own result unchanged) when
 * no later file qualifies.
 */
export function toggleViewedAndAdvance(s: ReviewState, now: number): ReviewState {
  const summary = s.summary;
  if (s.selectedPath === null || summary?.status !== 'ok') return s;
  const path = s.selectedPath;
  const wasViewed = viewedState(summary.summary.files, s.viewedMarks).byPath[path] === 'viewed';
  const next = setViewed(s, path, !wasViewed, now);
  if (next === s || wasViewed) return next;

  const order = navigationOrder(summary.summary.files);
  const statuses = viewedState(summary.summary.files, next.viewedMarks).byPath;
  const startIdx = order.indexOf(path);
  for (let i = 1; i <= order.length; i += 1) {
    const candidate = order[(startIdx + i) % order.length];
    if (statuses[candidate] === 'unviewed' || statuses[candidate] === 'changed') {
      return selectFile(next, candidate);
    }
  }
  return next;
}

/** Whether an answer carrying `(taskId, seq)` is still the frontier `state` accepts for viewed
 *  marks — same shape as `commentsAccepted`. */
function viewedAccepted(s: ReviewState, taskId: string | null, seq: number): boolean {
  return taskId === s.taskId && seq >= s.viewedSeq;
}

/** A viewed-marks fetch began. Refused (same object) for a foreign `taskId` or a seq the
 *  frontier has already moved past — same shape as `commentsLoadStarted`. */
export function viewedLoadStarted(s: ReviewState, taskId: string | null, seq: number): ReviewState {
  if (!viewedAccepted(s, taskId, seq)) return s;
  return { ...s, viewedSeq: seq };
}

/**
 * A viewed-marks answer arrived. Refused unless `viewedAccepted`; replaces `viewedMarks`
 * wholesale, same as `commentsArrived` does for `comments` — the caller is expected to have
 * already filtered `marks` down to this card's own `subjectId`.
 */
export function viewedArrived(
  s: ReviewState,
  taskId: string | null,
  seq: number,
  marks: readonly ReviewViewedMark[],
): ReviewState {
  if (!viewedAccepted(s, taskId, seq)) return s;
  return { ...s, viewedSeq: seq, viewedMarks: marks };
}

/** Each current file's viewed status, plus the viewed count — `{}`/`0` while the summary is
 *  not loaded ok. Thin wrapper over `viewedState`; no subject-filtering logic of its own. */
export function viewedStatuses(s: ReviewState): {
  byPath: Record<string, ViewedStatus>;
  viewedCount: number;
} {
  const summary = s.summary;
  if (summary?.status !== 'ok') return { byPath: {}, viewedCount: 0 };
  return viewedState(summary.summary.files, s.viewedMarks);
}

/**
 * Gap `gap`'s new-side bounds in `file` — `[1, next.first)` at the file start, `[prev.end,
 * next.first)` between hunks, `[prev.end, ∞)` at the file end. The exact arithmetic
 * `expandContext` itself uses to decide what it keeps, exported from `@tm/shared/review` rather
 * than duplicated here.
 */
export function gapBounds(file: DiffFile, gap: number): { low: number; high: number } {
  const prev = gap > 0 ? file.hunks[gap - 1] : undefined;
  const next = gap < file.hunks.length ? file.hunks[gap] : undefined;
  const low = prev ? endLine(prev.newStart, prev.newLines) : 1;
  const high = next ? firstLine(next.newStart, next.newLines) : Infinity;
  return { low, high };
}

/**
 * The new-side line range a `review:context` request for `gap` should cover, always
 * `side: 'new'`. `'step'` reads the 20 lines closest to the gap's near edge — right before the
 * next hunk, or right after the previous one for the trailing gap, where there is no next hunk
 * to be close to. `'all'` reads the whole gap, capped to `DIFF_CONTEXT_MAX_LINES` — the file's
 * own length is not this function's problem; `review:context`'s handler (F15.10) clips to that
 * and reports `truncated` itself.
 */
export function contextRequest(
  file: DiffFile,
  gap: number,
  mode: 'step' | 'all',
): { side: 'new'; from: number; to: number } {
  const { low, high } = gapBounds(file, gap);
  const next = gap < file.hunks.length ? file.hunks[gap] : undefined;
  if (mode === 'step') {
    if (next !== undefined) {
      return { side: 'new', from: Math.max(low, high - 20), to: high - 1 };
    }
    return { side: 'new', from: low, to: low + 19 };
  }
  const to = Number.isFinite(high)
    ? Math.min(high - 1, low + DIFF_CONTEXT_MAX_LINES - 1)
    : low + DIFF_CONTEXT_MAX_LINES - 1;
  return { side: 'new', from: low, to };
}

function isLoadingContextSeq(load: ContextLoad | undefined, seq: number): boolean {
  return load !== undefined && load.status === 'loading' && load.seq === seq;
}

function setContext(s: ReviewState, path: string, low: number, load: ContextLoad): ReviewState {
  return { ...s, context: { ...s.context, [path]: { ...s.context[path], [low]: load } } };
}

function clearContext(s: ReviewState, path: string, low: number): ReviewState {
  const forPath = { ...s.context[path] };
  delete forPath[low];
  return { ...s, context: { ...s.context, [path]: forPath } };
}

/**
 * A context-expansion load for `path`'s gap `gap` began. Refused (same object) unless the task
 * matches, `diffId === s.diffId`, and `path` is currently `loaded`. Computes `{ low }` from that
 * file's *current* hunks via `gapBounds` and sets `context[path][low]` to `loading { seq }`
 * unconditionally — the same "overwrite once past the guards" rule `fileLoadStarted` follows.
 */
export function contextLoadStarted(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  gap: number,
  seq: number,
): ReviewState {
  if (taskId !== s.taskId || diffId !== s.diffId) return s;
  const load = s.files[path];
  if (load?.status !== 'loaded') return s;
  const { low } = gapBounds(load.file, gap);
  return setContext(s, path, low, { status: 'loading', seq });
}

/**
 * A context-expansion answer arrived for the bound captured at request time as `low` — never
 * re-derived from `gap`, since the file's hunks may have shifted since the request went out.
 * Refused (same object) unless the task matches, `diffId === s.diffId`, and `context[path][low]`
 * is still `loading` with this exact `seq`.
 *
 * An `ok` answer whose `context.tooLarge` is unset re-scans the *current* loaded file for the
 * gap whose own `gapBounds(...).low` still equals `low`, merges the read text into it via
 * `expandContext`, stores the merged file, and clamps `hunkIndex` down to the merged file's own
 * last hunk when it is not `null` — a merge can only ever shrink the hunk count, never grow it.
 * When no such gap exists any more (a neighbouring expansion already swallowed this bound),
 * nothing is merged, but the stale `context[path][low]` entry is still deleted either way, since
 * nothing will ever read that key again. `context.tooLarge` set instead records the size.
 *
 * A `stale` answer sets `staleDiffId`, same as a file's own stale answer, and otherwise leaves
 * `context[path][low]` as `loading` — harmless, since `staleDiffId` already freezes every other
 * load until Reload, which clears `context` wholesale via the next `summaryArrived` anyway.
 */
export function contextArrived(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  low: number,
  seq: number,
  result: DiffContextResult,
): ReviewState {
  if (
    taskId !== s.taskId ||
    diffId !== s.diffId ||
    !isLoadingContextSeq(s.context[path]?.[low], seq)
  ) {
    return s;
  }
  if (result.status === 'stale') {
    return { ...s, staleDiffId: result.currentDiffId };
  }
  if (result.context.tooLarge) {
    return setContext(s, path, low, { status: 'tooLarge', bytes: result.context.tooLarge.bytes });
  }
  const load = s.files[path];
  const file = load?.status === 'loaded' ? load.file : undefined;
  if (file === undefined) return clearContext(s, path, low);

  let gap = -1;
  for (let g = 0; g <= file.hunks.length; g += 1) {
    if (gapBounds(file, g).low === low) {
      gap = g;
      break;
    }
  }
  if (gap === -1) return clearContext(s, path, low);

  const merged = expandContext(file, gap, {
    start: result.context.start,
    text: result.context.text,
  });
  return {
    ...clearContext(s, path, low),
    files: { ...s.files, [path]: { status: 'loaded', file: merged } },
    hunkIndex: s.hunkIndex === null ? null : Math.min(s.hunkIndex, merged.hunks.length - 1),
  };
}

/**
 * A context-expansion load failed outright (not a `DiffContextResult`, a rejected fetch). Same
 * guards as {@link contextArrived}; sets `context[path][low]` to `idle { error }`.
 */
export function contextFailed(
  s: ReviewState,
  taskId: string | null,
  diffId: string,
  path: string,
  low: number,
  seq: number,
  error: string,
): ReviewState {
  if (
    taskId !== s.taskId ||
    diffId !== s.diffId ||
    !isLoadingContextSeq(s.context[path]?.[low], seq)
  ) {
    return s;
  }
  return setContext(s, path, low, { status: 'idle', error });
}
