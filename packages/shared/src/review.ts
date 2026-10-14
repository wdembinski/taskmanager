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

/** Lock files and the usual generated outputs — what {@link isCollapsedByDefault} folds away. */
const GENERATED_FILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$|\.(min\.(js|css)|map|snap)$|(^|\/)(dist|build|generated|__generated__)\//;

/**
 * Whether a file starts collapsed in the review pane: a lock or generated file with more
 * than `DIFF_COLLAPSE_LINES` changed lines. Still readable on demand, under the same
 * per-file cap as any other — this decides the default, not what can be read.
 */
export function isCollapsedByDefault(
  entry: Pick<DiffFileEntry, 'path' | 'additions' | 'deletions'>,
): boolean {
  return GENERATED_FILE.test(entry.path) && entry.additions + entry.deletions > DIFF_COLLAPSE_LINES;
}

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

/**
 * One file's result from `parsePatch` (F6.2). The design doc describes the signature as
 * `parsePatch(text) → DiffHunk[]`; this is a deliberate deviation from that doc. The ticket
 * needs added/deleted/renamed/copied and binary facts, and those only live in a file's
 * header lines, not in any hunk — so parsing returns one `PatchFile` per file instead of a
 * bare hunk list. A one-file read (F6.6) takes `parsePatch(t)[0]?.hunks ?? []`.
 *
 * `parsePatch`'s own contract, fixed here for F6.2's implementation step:
 *
 * - **CRLF.** Split on `\n` and strip one trailing `\r` per line, so a CRLF-transported patch
 *   and a CRLF file's own content both yield clean `text` — `DiffLine.text` never contains `\r`.
 * - **`DiffHunk.header`** is the whole `@@ -a,b +c,d @@ section` line, kept renderable as-is.
 * - **A hunk's body is consumed by count, not by line prefix.** Read lines until `oldLines`
 *   old-side and `newLines` new-side lines have been used, so a content line that happens to
 *   start `--- `, `+++ ` or `diff ` is never mistaken for the next header. Omitted counts
 *   default to 1 (`@@ -3 +3 @@`); `-0,0`/`+0,0` means that side is empty.
 * - **Line kinds.** `' '` is context (`oldLine` and `newLine` both set), `'-'` is a deletion
 *   (`oldLine` only), `'+'` is an addition (`newLine` only). A bare empty line inside a hunk is
 *   context `""` (some tools trim trailing whitespace on write). `\ No newline at end of file`
 *   sets `noNewlineAtEof: true` on the line before it and is not itself a line.
 * - **Headers recognised:** `diff --git`, `new file mode`, `deleted file mode`, `old mode`/
 *   `new mode`, `similarity index`/`dissimilarity index`, `rename from`/`rename to`,
 *   `copy from`/`copy to`, `index`, `---`/`+++` (including `/dev/null`), `Binary files … differ`,
 *   and `GIT binary patch` (its body is skipped, never parsed as hunks).
 * - **Paths.** Prefer `rename/copy from/to` and `---`/`+++`; fall back to the
 *   `diff --git a/X b/X` line (split it symmetrically so a path containing spaces still
 *   works). C-style quoted paths (`"a/t\303\251st.txt"`) are unquoted — octal escapes decode as
 *   UTF-8 bytes, plus `\t \n \" \\` — and `a/`/`b/` prefixes are stripped.
 * - **Status.** `added` (new file mode, or `--- /dev/null`), `deleted`, `renamed`, `copied`,
 *   else `modified` (this also covers a mode-only change with no hunks). An empty added/deleted
 *   file parses to `hunks: []`.
 * - **Out of scope.** Combined diffs (`diff --cc`) are not handled. Any text before the first
 *   `diff --git` line is ignored. Empty input returns `[]`.
 */
export interface PatchFile {
  /** New-side path; the old-side path for a deletion. */
  path: string;
  /** Set only when the file was renamed or copied. */
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

const DIFF_GIT_PREFIX = 'diff --git ';
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/** Strip one trailing `\r`, so a CRLF-transported patch and a CRLF file's own content both yield clean lines. */
function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * The closing `"` of a C-style quoted string starting at `s[0]`, honouring backslash escapes
 * (`\"`, `\\`, an octal byte) so an escaped quote inside the path is never mistaken for the end
 * of it.
 */
function findClosingQuote(s: string): number {
  let escaped = false;
  for (let i = 1; i < s.length; i += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (s[i] === '\\') {
      escaped = true;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

/**
 * Decode a C-style quoted path (`"a/t\303\251st.txt"`, quotes included) into the real string.
 * Octal escapes are bytes, not characters — they are collected and decoded as UTF-8 only when a
 * non-escaped character breaks the run, so a multi-byte character split across several `\NNN`
 * escapes comes back as one. `\t`, `\n`, `\"` and `\\` decode directly.
 */
function unquotePath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const bytes: number[] = [];
  let out = '';
  const flushBytes = () => {
    if (bytes.length > 0) {
      out += new TextDecoder().decode(Uint8Array.from(bytes));
      bytes.length = 0;
    }
  };
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c !== '\\') {
      flushBytes();
      out += c;
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      let j = i + 1;
      let octal = '';
      while (j < inner.length && octal.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
        octal += inner[j];
        j += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      i = j - 1;
      continue;
    }
    flushBytes();
    if (next === 't') out += '\t';
    else if (next === 'n') out += '\n';
    else out += next ?? '';
    i += 1;
  }
  flushBytes();
  return out;
}

/** Decode `raw` if it is a quoted path; otherwise return it unchanged. */
function maybeUnquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  return unquotePath(raw.slice(0, findClosingQuote(raw) + 1));
}

/** Strip a leading `a/` or `b/` prefix, as used by `---`/`+++` and the `diff --git` line. */
function stripAbPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A `---`/`+++` line's path: `null` for `/dev/null`, else unquoted with its `a/`/`b/` prefix gone. */
function parsePathLine(raw: string): string | null {
  if (raw === '/dev/null') return null;
  return stripAbPrefix(maybeUnquote(raw));
}

/**
 * The two paths on a `diff --git a/X b/X` line. Outside a rename, `a` and `b` are the identical
 * path, so an unquoted line is split exactly in half rather than searched for `" b/"` — a search
 * would misfire if the path itself contained that substring.
 */
function parseGitDiffHeader(line: string): { a: string; b: string } {
  const rest = line.slice(DIFF_GIT_PREFIX.length);
  if (rest.startsWith('"')) {
    const aRaw = rest.slice(0, findClosingQuote(rest) + 1);
    const a = stripAbPrefix(unquotePath(aRaw));
    const b = stripAbPrefix(maybeUnquote(rest.slice(aRaw.length + 1)));
    return { a, b };
  }
  const pathLength = (rest.length - 5) / 2;
  return { a: rest.slice(2, 2 + pathLength), b: rest.slice(2 + pathLength + 3) };
}

/** The four numbers on a hunk header, with omitted counts defaulting to 1. */
function parseHunkCounts(header: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} {
  const match = HUNK_HEADER.exec(header);
  if (!match) return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
  const [, oldStart, oldLines, newStart, newLines] = match;
  return {
    oldStart: Number(oldStart),
    oldLines: oldLines === undefined ? 1 : Number(oldLines),
    newStart: Number(newStart),
    newLines: newLines === undefined ? 1 : Number(newLines),
  };
}

/**
 * One hunk starting at `lines[i]`, consumed by count rather than by line prefix — so a content
 * line that happens to start `--- `, `+++ ` or `diff ` is never mistaken for the next header.
 * Returns the index just past the hunk, for the caller to resume at.
 */
function parseHunk(lines: string[], i: number, end: number): { hunk: DiffHunk; next: number } {
  const counts = parseHunkCounts(lines[i]);
  const diffLines: DiffLine[] = [];
  let oldLine = counts.oldStart;
  let newLine = counts.newStart;
  let oldRemaining = counts.oldLines;
  let newRemaining = counts.newLines;
  let j = i + 1;
  while (j < end && (oldRemaining > 0 || newRemaining > 0)) {
    const raw = lines[j];
    if (raw === '' || raw[0] === ' ') {
      diffLines.push({ kind: 'context', text: raw === '' ? '' : raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else if (raw[0] === '-') {
      diffLines.push({ kind: 'del', text: raw.slice(1), oldLine });
      oldLine += 1;
      oldRemaining -= 1;
    } else if (raw[0] === '+') {
      diffLines.push({ kind: 'add', text: raw.slice(1), newLine });
      newLine += 1;
      newRemaining -= 1;
    } else {
      break; // malformed input — stop rather than loop forever
    }
    j += 1;
    if (lines[j] === NO_NEWLINE_MARKER) {
      diffLines[diffLines.length - 1].noNewlineAtEof = true;
      j += 1;
    }
  }
  return {
    hunk: {
      oldStart: counts.oldStart,
      oldLines: counts.oldLines,
      newStart: counts.newStart,
      newLines: counts.newLines,
      header: lines[i],
      lines: diffLines,
    },
    next: j,
  };
}

/** One file's section, from its `diff --git` line up to (not including) `end`. */
function parseFileSection(lines: string[], start: number, end: number): PatchFile {
  const { a: gitA, b: gitB } = parseGitDiffHeader(lines[start]);

  let newFile = false;
  let deletedFile = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let copyFrom: string | undefined;
  let copyTo: string | undefined;
  let minusPath: string | null | undefined;
  let plusPath: string | null | undefined;
  let binary = false;
  const hunks: DiffHunk[] = [];

  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    if (line.startsWith('@@ ')) {
      const parsed = parseHunk(lines, i, end);
      hunks.push(parsed.hunk);
      i = parsed.next - 1;
    } else if (line.startsWith('new file mode')) {
      newFile = true;
    } else if (line.startsWith('deleted file mode')) {
      deletedFile = true;
    } else if (line.startsWith('rename from ')) {
      renameFrom = maybeUnquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      renameTo = maybeUnquote(line.slice('rename to '.length));
    } else if (line.startsWith('copy from ')) {
      copyFrom = maybeUnquote(line.slice('copy from '.length));
    } else if (line.startsWith('copy to ')) {
      copyTo = maybeUnquote(line.slice('copy to '.length));
    } else if (line.startsWith('--- ')) {
      minusPath = parsePathLine(line.slice('--- '.length));
    } else if (line.startsWith('+++ ')) {
      plusPath = parsePathLine(line.slice('+++ '.length));
    } else if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      binary = true;
    } else if (line.startsWith('GIT binary patch')) {
      binary = true;
      break; // its body is never hunks — nothing after this belongs to this file
    }
    // old/new mode, similarity/dissimilarity index, index: recognised, nothing to extract.
  }

  let status: DiffFileStatus;
  if (renameFrom !== undefined && renameTo !== undefined) status = 'renamed';
  else if (copyFrom !== undefined && copyTo !== undefined) status = 'copied';
  else if (newFile || minusPath === null) status = 'added';
  else if (deletedFile || plusPath === null) status = 'deleted';
  else status = 'modified';

  let path: string;
  let oldPath: string | undefined;
  if (status === 'renamed') {
    path = renameTo ?? gitB;
    oldPath = renameFrom;
  } else if (status === 'copied') {
    path = copyTo ?? gitB;
    oldPath = copyFrom;
  } else if (status === 'deleted') {
    path = minusPath ?? gitA;
  } else {
    path = plusPath ?? gitB;
  }

  return { path, oldPath, status, binary, hunks };
}

/**
 * Parse `git diff --no-color --no-ext-diff` output into one {@link PatchFile} per file. See the
 * contract fixed above {@link PatchFile}.
 */
export function parsePatch(text: string): PatchFile[] {
  if (!text) return [];
  const lines = text.split('\n').map(stripTrailingCr);
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith(DIFF_GIT_PREFIX)) starts.push(i);
  });
  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    return parseFileSection(lines, start, end);
  });
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

export const WORD_DIFF_MAX_CHARS = 2_000; // per side; above it, skip tokenising entirely
export const WORD_DIFF_MAX_TOKENS = 400; // per side, after trimming common prefix/suffix

export type WordSegmentKind = 'same' | 'del' | 'add';

export interface WordSegment {
  kind: WordSegmentKind;
  text: string;
}

/**
 * A changed line's inner highlight, one side at a time: `old` carries `same`/`del`
 * segments, `new` carries `same`/`add` segments — a unified view highlights the `-`
 * line from `old` and the `+` line from `new`. `wholeLine` means tokenising was
 * skipped or gave up (too long, too many tokens, or nothing meaningful in common);
 * the line should render as a plain whole-line change, not word-highlighted.
 */
export interface WordDiff {
  old: WordSegment[];
  new: WordSegment[];
  wholeLine: boolean;
}

/**
 * Token-level diff between one old/new line pair, bounded so a single huge or
 * minified line cannot blow up cost: `WORD_DIFF_MAX_CHARS` skips tokenising
 * entirely, `WORD_DIFF_MAX_TOKENS` bounds the LCS after trimming the common
 * prefix/suffix. Falls back to a whole-line `del`/`add` pair (`wholeLine: true`)
 * past either cap, or when nothing meaningful survives in common.
 */
export function wordDiff(oldText: string, newText: string): WordDiff {
  if (oldText === newText) {
    return {
      old: oldText.length ? [{ kind: 'same', text: oldText }] : [],
      new: newText.length ? [{ kind: 'same', text: newText }] : [],
      wholeLine: false,
    };
  }

  if (oldText.length > WORD_DIFF_MAX_CHARS || newText.length > WORD_DIFF_MAX_CHARS) {
    return wholeLineDiff(oldText, newText);
  }

  // A line that only moved across a CRLF/whitespace boundary never counts as a change.
  if (stripWhitespace(oldText) === stripWhitespace(newText)) {
    return {
      old: [{ kind: 'same', text: oldText }],
      new: [{ kind: 'same', text: newText }],
      wholeLine: false,
    };
  }

  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);

  if (oldTokens.length > WORD_DIFF_MAX_TOKENS || newTokens.length > WORD_DIFF_MAX_TOKENS) {
    return wholeLineDiff(oldText, newText);
  }

  const maxOverlap = Math.min(oldTokens.length, newTokens.length);
  let prefixLen = 0;
  while (prefixLen < maxOverlap && oldTokens[prefixLen] === newTokens[prefixLen]) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < maxOverlap - prefixLen &&
    oldTokens[oldTokens.length - 1 - suffixLen] === newTokens[newTokens.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const middleOld = oldTokens.slice(prefixLen, oldTokens.length - suffixLen);
  const middleNew = newTokens.slice(prefixLen, newTokens.length - suffixLen);
  const { oldOps, newOps, lcsLength } = lcsDiff(middleOld, middleNew);

  // Nothing shared at the edges or in the middle — a token-level diff would
  // just be a single del/add pair anyway, so skip straight to that shape.
  if (prefixLen === 0 && suffixLen === 0 && lcsLength === 0) {
    return wholeLineDiff(oldText, newText);
  }

  const prefixText = oldTokens.slice(0, prefixLen).join('');
  const suffixText = suffixLen ? oldTokens.slice(oldTokens.length - suffixLen).join('') : '';

  const old: WordSegment[] = [];
  const updated: WordSegment[] = [];
  pushSegment(old, 'same', prefixText);
  for (const op of oldOps) pushSegment(old, op.kind, op.text);
  pushSegment(old, 'same', suffixText);
  pushSegment(updated, 'same', prefixText);
  for (const op of newOps) pushSegment(updated, op.kind, op.text);
  pushSegment(updated, 'same', suffixText);

  return { old, new: updated, wholeLine: false };
}

function wholeLineDiff(oldText: string, newText: string): WordDiff {
  return {
    old: oldText.length ? [{ kind: 'del', text: oldText }] : [],
    new: newText.length ? [{ kind: 'add', text: newText }] : [],
    wholeLine: true,
  };
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

// Words, whitespace runs and punctuation runs each move as one token, so a
// rename or reorder highlights the identifier, not its surrounding spaces.
function tokenize(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]+/g) ?? [];
}

function pushSegment(segments: WordSegment[], kind: WordSegmentKind, text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    segments.push({ kind, text });
  }
}

/** Longest common subsequence over tokens, walked back into same/del and same/add runs. */
function lcsDiff(
  oldTokens: string[],
  newTokens: string[],
): {
  oldOps: Array<{ kind: 'same' | 'del'; text: string }>;
  newOps: Array<{ kind: 'same' | 'add'; text: string }>;
  lcsLength: number;
} {
  const n = oldTokens.length;
  const m = newTokens.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldTokens[i] === newTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const oldOps: Array<{ kind: 'same' | 'del'; text: string }> = [];
  const newOps: Array<{ kind: 'same' | 'add'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) {
      oldOps.push({ kind: 'same', text: oldTokens[i] });
      newOps.push({ kind: 'same', text: newTokens[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      oldOps.push({ kind: 'del', text: oldTokens[i] });
      i++;
    } else {
      newOps.push({ kind: 'add', text: newTokens[j] });
      j++;
    }
  }
  while (i < n) {
    oldOps.push({ kind: 'del', text: oldTokens[i] });
    i++;
  }
  while (j < m) {
    newOps.push({ kind: 'add', text: newTokens[j] });
    j++;
  }

  return { oldOps, newOps, lcsLength: dp[0]?.[0] ?? 0 };
}
