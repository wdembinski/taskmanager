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
import type {
  DiffFileEntry,
  DiffFileStatus,
  DiffLine,
  DiffSummary,
  WordSegment,
} from '@tm/shared/review';
import { wordDiff } from '@tm/shared/review';
import { filesToLoad, isCollapsedByDefault, type ReviewState } from './reviewState';

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
 * meaningful fork, not one per path segment.
 */
export function buildFileTree(entries: readonly DiffFileEntry[]): FileTreeNode[] {
  const root: RawDir = { kind: 'dir', children: new Map() };
  for (const entry of entries) insert(root, entry);
  return buildChildren(root, '');
}

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

/**
 * The inner word-highlight for each line in one hunk's already-flattened lines, aligned
 * positionally: every run of `del` lines immediately followed by a run of `add` lines pairs up
 * index-for-index through `wordDiff`, shortest run first — a run with more dels than adds (or
 * the reverse) leaves its unmatched tail `null`, same as every `context` line and every pair
 * `wordDiff` gave up on (`wholeLine`), which reads as a plain whole-line change with no inner
 * highlight rather than a stale one.
 */
export function pairWordDiffs(lines: readonly DiffLine[]): ReadonlyArray<WordSegment[] | null> {
  const result = new Array<WordSegment[] | null>(lines.length).fill(null);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') {
      i += 1;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].kind === 'del') i += 1;
    const delEnd = i;
    const addStart = i;
    while (i < lines.length && lines[i].kind === 'add') i += 1;
    const addEnd = i;

    const pairCount = Math.min(delEnd - delStart, addEnd - addStart);
    for (let k = 0; k < pairCount; k += 1) {
      const diff = wordDiff(lines[delStart + k].text, lines[addStart + k].text);
      if (diff.wholeLine) continue;
      result[delStart + k] = diff.old;
      result[addStart + k] = diff.new;
    }
  }
  return result;
}

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
 * The expanded paths `ReviewPane` should fetch as a patch right now: {@link filesToLoad} minus
 * any binary entry. A binary file is never fetched through `task:diffReadFile` — there is no
 * text patch to show — and an image goes through `task:diffImage` instead, which `ImageDiff`
 * fetches for itself.
 */
export function fetchablePaths(state: ReviewState): readonly string[] {
  if (state.summary?.status !== 'ok') return [];
  const binaryPaths = new Set(
    state.summary.summary.files.filter((entry) => entry.binary).map((entry) => entry.path),
  );
  return filesToLoad(state).filter((path) => !binaryPaths.has(path));
}
