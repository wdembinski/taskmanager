/**
 * F6 puts a card's diff in the app: read it, comment on lines, and send every comment
 * back to the agent as one review message (`docs/plan/feature-roadmap/F6-in-app-code-review.md`).
 * This module is the contract every later F6 card builds on — the diff and comment shapes,
 * and the result variants a diff read can come back with instead of data.
 *
 * Two rules sit behind the cap constants below:
 *
 *  - **One file at a time over the relay.** A web client fetches a file's patch or an image
 *    lazily, as the human expands it — never the whole diff in one answer.
 *  - **Every answer must fit under `RESULTS_BYTES_LIMIT`.** That limit lives in
 *    `apps/client/src/main/cloudResults.ts` and is checked by a test there (not imported
 *    here, since this package has no dependency on `apps/client`) — these caps just have
 *    to stay comfortably under it.
 */

export const DIFF_FILE_MAX_BYTES = 256_000; // one file's patch text
export const DIFF_IMAGE_MAX_BYTES = 512_000; // one image side, base64
export const DIFF_SUMMARY_MAX_FILES = 1000; // summary lists at most this many
export const DIFF_COLLAPSE_LINES = 2000; // generated/lock files above this collapse

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/** One file's row in a `DiffSummary`. `path` is repo-relative — never a host path (WSL). */
export interface DiffFileEntry {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  image: boolean;
  bytes: number;
}

/**
 * The file list for one diff.
 *
 * `diffId`: a short hash of (baseSha, headSha, working-tree fingerprint). Every later read
 * names it, and is refused `stale` when it has moved on since.
 */
export interface DiffSummary {
  diffId: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  includesWorkingTree: boolean;
  files: DiffFileEntry[];
  truncated: boolean;
}

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
  noNewlineAtEof?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

/** One file's patch. `tooLarge` means the patch exceeded `DIFF_FILE_MAX_BYTES` and `hunks` is empty. */
export interface DiffFile {
  diffId: string;
  path: string;
  hunks: DiffHunk[];
  tooLarge?: { bytes: number };
}

export type DiffImageSide =
  { bytes: number; mime: string; base64: string } | { bytes: number; tooLarge: true };

/** `old`/`new` are `null` on a side that does not exist (an added or deleted image). */
export interface DiffImage {
  diffId: string;
  path: string;
  old: DiffImageSide | null;
  new: DiffImageSide | null;
}

export type DiffSide = 'old' | 'new';

/**
 * A draft until `sentAt` is set. `excerpt` is the quoted anchor text, so an outdated comment
 * still tells the agent what it was about. `start` makes the comment a range.
 */
export interface ReviewComment {
  id: string;
  taskId: string;
  diffId: string;
  path: string;
  oldPath?: string;
  side: DiffSide;
  line: number;
  start?: { side: DiffSide; line: number };
  body: string;
  excerpt: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  /**
   * Computed by `markOutdated`, never authored or stored: whether the anchor still points at
   * the same text in the current revision. Left out entirely until something recomputes it.
   */
  outdated?: boolean;
}

/** The worktree moved on since the human loaded `diffId`. */
export interface DiffStale {
  status: 'stale';
  diffId: string;
  currentDiffId: string;
}

/** The branch/worktree is gone because the work merged; must read differently from "no changes". */
export interface DiffLanded {
  status: 'landed';
  forgeUrl: string | null;
}

/** Mid-rebase or conflict markers; the diff is not drawn, comments disabled. */
export interface DiffConflicted {
  status: 'conflicted';
  files: string[];
}

/** The card never produced a branch — an explicit empty state, never a git error. */
export interface DiffNoBranch {
  status: 'no-branch';
}

export type DiffSummaryResult =
  { status: 'ok'; summary: DiffSummary } | DiffLanded | DiffConflicted | DiffNoBranch;

export type DiffFileResult = { status: 'ok'; file: DiffFile } | DiffStale;

export type DiffImageResult = { status: 'ok'; image: DiffImage } | DiffStale;

/** The three fields that locate a comment's anchor, with no dependency on it having an `id`. */
export type ReviewAnchor = Pick<ReviewComment, 'side' | 'line' | 'start'>;

function rowIndex(rows: DiffLine[], side: DiffSide, line: number): number {
  return rows.findIndex((row) => (side === 'old' ? row.oldLine : row.newLine) === line);
}

/**
 * The quoted text an anchor points at, in `file`'s current hunks — `null` when the anchor no
 * longer resolves. `file.hunks` is flattened once, in display order; a row matches a side only
 * through that side's own field (`oldLine`/`newLine`), never the other one. The start row is
 * `anchor.start`, or `anchor` itself for a single-line anchor; the end row is always
 * `anchor`'s own `side`/`line`. Positions are compared by index in display order, not by the
 * raw line numbers, so a range that crosses sides has something to compare.
 */
export function excerptFor(file: DiffFile, anchor: ReviewAnchor): string | null {
  const rows = file.hunks.flatMap((hunk) => hunk.lines);
  const start = anchor.start ?? { side: anchor.side, line: anchor.line };
  const startIndex = rowIndex(rows, start.side, start.line);
  const endIndex = rowIndex(rows, anchor.side, anchor.line);
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) return null;
  return rows
    .slice(startIndex, endIndex + 1)
    .map((row) => row.text)
    .join('\n');
}

function normalizeExcerpt(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

/**
 * Recomputes `outdated` for every comment anchored in `file`, leaving everything else as the
 * exact same object by reference. A comment on another path, or on a `file.tooLarge` file
 * (no hunks to check an anchor against), passes through untouched. Otherwise a comment is
 * outdated when its anchor no longer resolves (`excerptFor` returns `null`) or resolves to
 * text that no longer matches its stored `excerpt` once both are normalised (CRLF folded to
 * `\n`, trailing whitespace trimmed per line) — so a moved line (same text, new number) reads
 * as outdated, and a reverted edit flips back to `outdated: false`.
 */
export function markOutdated(comments: ReviewComment[], file: DiffFile): ReviewComment[] {
  return comments.map((comment) => {
    if (comment.path !== file.path || file.tooLarge) return comment;
    const excerpt = excerptFor(file, comment);
    const outdated =
      excerpt === null || normalizeExcerpt(excerpt) !== normalizeExcerpt(comment.excerpt);
    return { ...comment, outdated };
  });
}

function implicitSideLabel(side: DiffSide): string {
  return side === 'old' ? ' (old)' : '';
}

function explicitSideLabel(side: DiffSide): string {
  return side === 'old' ? ' (old)' : ' (new)';
}

/** The backtick-quoted `path:line[-line]` location for one comment, outdated suffix last. */
function formatLocation(comment: ReviewComment): string {
  const end = { side: comment.side, line: comment.line };
  const start = comment.start ?? end;
  const renamed = Boolean(comment.oldPath) && comment.oldPath !== comment.path;

  let location: string;
  if (start.side === end.side) {
    const displayPath = end.side === 'old' ? (comment.oldPath ?? comment.path) : comment.path;
    const lineText = start.line === end.line ? `${end.line}` : `${start.line}-${end.line}`;
    location = `${displayPath}:${lineText}${implicitSideLabel(end.side)}`;
    if (end.side === 'old' && renamed) location += `, renamed to ${comment.path}`;
  } else {
    location = `${comment.path}:${start.line}${explicitSideLabel(start.side)}-${end.line}${explicitSideLabel(end.side)}`;
    if (renamed) location += `, renamed to ${comment.path}`;
  }

  if (comment.outdated) {
    location += ' — outdated: the code changed since; the excerpt shows what it was';
  }

  return location;
}

/** A fence one backtick longer than the longest run already inside `text`, floor 3. */
function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(longest + 1, 3));
}

function formatCommentEntry(index: number, comment: ReviewComment): string {
  const parts = [`${index}. \`${formatLocation(comment)}\``];
  if (comment.excerpt !== '') {
    const fence = fenceFor(comment.excerpt);
    parts.push(`${fence}\n${comment.excerpt}\n${fence}`);
  }
  parts.push(comment.body.trim());
  return parts.join('\n\n');
}

/**
 * The one batched follow-up for a review: a header naming the head SHA, `diffId` and
 * `baseRef`, an optional overall note, then every comment as a numbered entry (location,
 * fenced excerpt, trimmed body). Comments sort by `path`, then by their start line as a raw
 * number. An empty, whitespace-only `note` is left out; `comments` empty and no usable `note`
 * produces `''`, the signal a caller uses to refuse to send an empty message.
 */
export function formatReviewMessage(
  comments: ReviewComment[],
  summary: DiffSummary,
  note?: string,
): string {
  const trimmedNote = note?.trim();
  if (comments.length === 0 && !trimmedNote) return '';

  const sorted = [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return (a.start?.line ?? a.line) - (b.start?.line ?? b.line);
  });

  const count = sorted.length;
  const header = `Code review of ${summary.headSha} (diff ${summary.diffId}, against ${summary.baseRef}) — ${count} comment${count === 1 ? '' : 's'}.`;

  const parts = [header];
  if (trimmedNote) parts.push(trimmedNote);
  sorted.forEach((comment, index) => parts.push(formatCommentEntry(index + 1, comment)));

  return parts.join('\n\n');
}
