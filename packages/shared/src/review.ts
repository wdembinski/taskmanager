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
