/**
 * The drawing half of the review pane: the file tree shape, the summary's totals, the inline
 * word-highlight pairing and which files load first — with no React in it.
 *
 * `reviewState.ts` already answered the hard question — what the pane's data IS, and when an
 * answer is stale. What is left is turning a flat file list into a tree, a status into a
 * letter, and a run of `-`/`+` lines into the pairs `wordDiff` highlights — and that is exactly
 * the kind of thing worth having on its own: a chain that collapses one directory too many, or
 * a word pairing that drifts off by one row, is a bug you can write a test for, and
 * `ReviewPaneView` is a component you cannot (this workspace has no DOM test harness). Same
 * split `gitGraphView.ts` makes for the commit graph, for the same reason.
 */
import type { DiffFileStatus, DiffSide, DiffSummary, ReviewSendRefusal } from '@tm/shared/review';
import { formatAge } from '../countdown';
import { REFUSAL_HINT } from '../taskChat';
import {
  filesToLoad,
  isCollapsedByDefault,
  type FileLoad,
  type LineSelection,
  type ReviewState,
} from './reviewState';

/**
 * `buildFileTree` and its `FileTree*` types now live in `reviewState.ts`, alongside the
 * `navigationOrder` keyboard navigation needs built from the same tree — this module already
 * imports runtime values from that one (`filesToLoad`, `isCollapsedByDefault`, above), so the
 * reverse import would be a genuine cycle. Re-exported here unchanged, the same shape as
 * `pairWordDiffs` below, so `FileTree.tsx`/`ReviewPaneView.tsx` need no changes.
 */
export {
  buildFileTree,
  type FileTreeDir,
  type FileTreeFile,
  type FileTreeNode,
} from './reviewState';

/** The single-letter badge `FileTree`'s aside slot shows for a file's status. */
export function statusLetter(status: DiffFileStatus): 'A' | 'M' | 'D' | 'R' | 'C' {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
  }
}

export interface SummaryTotals {
  files: number;
  additions: number;
  deletions: number;
}

/** The pane header's `N files · +a −b`. */
export function summaryTotals(summary: DiffSummary): SummaryTotals {
  return summary.files.reduce<SummaryTotals>(
    (totals, file) => ({
      files: totals.files + 1,
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export { pairWordDiffs } from '@tm/shared/review';

/**
 * The paths that load without the human expanding anything: the first `limit` files that are
 * not collapsed by default, not binary and not an image. Seeding the expansion this way, rather
 * than expanding every file, keeps the "one file at a time, lazily" rule — a file collapsed by
 * default loads only once the human expands it ("load anyway").
 */
export function defaultExpanded(summary: DiffSummary, limit = 5): readonly string[] {
  const paths: string[] = [];
  for (const entry of summary.files) {
    if (paths.length >= limit) break;
    if (entry.binary || entry.image || isCollapsedByDefault(entry)) continue;
    paths.push(entry.path);
  }
  return paths;
}

/**
 * The expanded paths `ReviewPane` should fetch as a patch right now: at most one of
 * {@link filesToLoad} minus any binary entry, and none at all while another file is already
 * `loading` — "one file at a time, lazily on expand", the design's own rule (F6.13). A binary
 * file is never fetched through `task:diffReadFile` — there is no text patch to show — and an
 * image goes through `task:diffImage` instead, which `ImageDiff` fetches for itself.
 *
 * `ReviewPane`'s fetch effect re-runs on every state change, so returning one path here is
 * enough to drain a whole queue: each fetch flips its path to `loading`, which is what makes
 * this function return `[]` until that one lands, and the next idle path only becomes
 * reachable once it does.
 */
export function fetchablePaths(state: ReviewState): readonly string[] {
  if (state.summary?.status !== 'ok') return [];
  const anyLoading = Object.values(state.files).some((load) => load.status === 'loading');
  if (anyLoading) return [];
  const binaryPaths = new Set(
    state.summary.summary.files.filter((entry) => entry.binary).map((entry) => entry.path),
  );
  return filesToLoad(state)
    .filter((path) => !binaryPaths.has(path))
    .slice(0, 1);
}

/** The refusals `review:send` can return on top of a plain chat refusal. */
const SEND_SPECIFIC_REFUSAL: Partial<Record<ReviewSendRefusal, string>> = {
  'nothing-to-send': 'Every draft has already been sent.',
  landed: 'This work has already merged — there is no diff left to send a review against.',
  conflicted: 'This worktree is mid-rebase or has conflicts — resolve that before sending.',
  'no-branch': 'This card hasn’t produced a branch yet.',
};

/**
 * Why `review:send` refused, as a sentence for the pane's warning banner. The four reasons
 * specific to sending a review are answered here; everything else is a plain `ChatRefusal`,
 * so it reuses `taskChat.ts`'s own `REFUSAL_HINT` rather than keeping a second copy of those
 * sentences that could drift from the composer's.
 */
export function sendRefusalText(reason: ReviewSendRefusal): string {
  return SEND_SPECIFIC_REFUSAL[reason] ?? REFUSAL_HINT[reason as keyof typeof REFUSAL_HINT];
}

/**
 * The sentence `DiffView.tsx`'s `FileBody` shows in place of a file's content, for every
 * `FileLoad` that is not a spinner and not the loaded diff itself. `null` for `idle` with no
 * error, `loading` and `loaded` — those are drawn by the caller instead.
 */
export function fileLoadNotice(load: FileLoad | undefined): string | null {
  if (load === undefined) return null;
  switch (load.status) {
    case 'idle':
      return load.error === undefined ? null : `Couldn't load this file: ${load.error}`;
    case 'loading':
    case 'loaded':
      return null;
    case 'tooLarge':
      return (
        `This file is too large to show here (${load.bytes.toLocaleString()} bytes) — ` +
        `open it in your editor.`
      );
    case 'stale':
      return 'The files changed since this was loaded — reload to see the latest.';
    case 'tooLargeForBrowser':
      return (
        `This file is too large to send to the browser (${load.bytes.toLocaleString()} bytes) ` +
        `— open it on the desktop.`
      );
  }
}

/** "Sent 3m ago" / "Sent just now" — a comment card's stamp once `sentAt` is set. */
export function formatSentStamp(sentAt: number, now: number): string {
  const age = formatAge(sentAt, now);
  return age === 'now' ? 'Sent just now' : `Sent ${age} ago`;
}

function sideLabel(side: DiffSide): string {
  return side === 'old' ? 'old' : 'new';
}

/**
 * The compact pane's selection pill: "Line 12" for a single line, "Lines 10–14" for a range on
 * one side, or "Lines 10 (old)–14 (new)" when the two ends are on different sides — a range can
 * span old and new, where a single line number alone would be ambiguous.
 */
export function selectionLabel(selection: LineSelection): string {
  if (selection.start === undefined) return `Line ${selection.anchor.line}`;
  const { start, anchor: end } = selection;
  if (start.side === end.side) return `Lines ${start.line}–${end.line}`;
  return `Lines ${start.line} (${sideLabel(start.side)})–${end.line} (${sideLabel(end.side)})`;
}
