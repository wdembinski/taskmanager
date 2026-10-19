/**
 * **File overlap** — whether two cards touch the same files, and which cards hold theirs.
 *
 * Every merge conflict of 2026-10-18 came from two cards editing the same files at the same
 * time. A card carries a file set (`Task.plannedFiles`), and a card is held back while an
 * *active* card in the same project touches any of the same files — the board says why, and
 * neither auto-start path (the chain engine, the project queue pump) starts it.
 *
 * Pure — no React, no DB, no Electron — so the boards, the engine and the plan check all
 * answer from the same rules. The candidate-vs-candidate rule (the first of two overlapping
 * candidates goes, the second waits for it) lives in `readyLanes`'s `planLanes`, because it
 * needs the lane order.
 */
import { isRunStatus, restingStatus } from './board';
import type { Task } from './model';

/** How many of a waiting card's overlapping files a chip or a check names. */
export const MAX_SHOWN_FILES = 3;

/** `\` → `/`, a leading `./` dropped, lowercased. Used for plan paths and branch paths alike. */
export function normalizePath(token: string): string {
  const slashed = token.replace(/\\/g, '/');
  const stripped = slashed.startsWith('./') ? slashed.slice(2) : slashed;
  return stripped.toLowerCase();
}

const WILDCARD = /[*?]/;

function isGlob(entry: string): boolean {
  return WILDCARD.test(entry);
}

/** The part of a glob before its first wildcard. */
function literalPrefix(glob: string): string {
  const idx = glob.search(WILDCARD);
  return idx === -1 ? glob : glob.slice(0, idx);
}

const globCache = new Map<string, RegExp>();

/**
 * A glob as an anchored regex: `**` matches anything including `/` (and `**\/` may match no
 * directory at all, so `src/**\/a.ts` covers `src/a.ts`), `*` anything but `/`, `?` one
 * character other than `/`. Everything else is literal.
 */
function globRegex(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${source}$`);
  globCache.set(pattern, re);
  return re;
}

/** Whether `path` matches the glob `pattern`. Both are compared as given — normalise first. */
export function globMatches(pattern: string, path: string): boolean {
  return globRegex(pattern).test(path);
}

/** Whether two normalised entries overlap. Two globs whose literal prefixes nest err on holding. */
function entriesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = isGlob(a);
  const gb = isGlob(b);
  if (ga && gb) {
    const pa = literalPrefix(a);
    const pb = literalPrefix(b);
    return pa.startsWith(pb) || pb.startsWith(pa);
  }
  if (ga) return globMatches(a, b);
  if (gb) return globMatches(b, a);
  return false;
}

/**
 * The entries of `mine` that overlap any entry of `theirs`, in `mine`'s order and spelling.
 * Both sides are normalised before comparing, so a stray capital or backslash cannot hide an
 * overlap. Empty when either side is empty, null or absent.
 */
export function overlappingFiles(
  mine: readonly string[] | null | undefined,
  theirs: readonly string[] | null | undefined,
): string[] {
  if (!mine?.length || !theirs?.length) return [];
  const other = theirs.map(normalizePath);
  return mine.filter((entry) => {
    const n = normalizePath(entry);
    return other.some((t) => entriesOverlap(n, t));
  });
}

/** The parents whose steps are live — a running step makes its parent active. */
export function liveStepParents(tasks: Iterable<Task>, running: ReadonlySet<string>): Set<string> {
  const parents = new Set<string>();
  for (const t of tasks) {
    if (t.parentTaskId && (running.has(t.id) || isRunStatus(t.status))) {
      parents.add(t.parentTaskId);
    }
  }
  return parents;
}

/**
 * Whether this card is **active**: a live run on it (which covers planning) or on one of its
 * steps, a run status it still wears, or a review with an open PR behind it. An active card
 * holds a ready lane, and holds its files against every other card in its project.
 * `liveSteps` is {@link liveStepParents}.
 */
export function isActiveHolder(
  task: Task,
  running: ReadonlySet<string>,
  liveSteps: ReadonlySet<string>,
  openPrs: ReadonlySet<string>,
): boolean {
  return (
    running.has(task.id) ||
    liveSteps.has(task.id) ||
    isRunStatus(task.status) ||
    (restingStatus(task) === 'in-review' && openPrs.has(task.id))
  );
}

/** Why a card is held: the active card it waits for, and its own entries that overlap. */
export interface FileHold {
  byTaskId: string;
  /** The held card's own overlapping entries — all of them; a chip shows {@link MAX_SHOWN_FILES}. */
  files: string[];
}

/** The first of `holders` whose files overlap `task`'s, or null. */
export function holdAgainst(task: Task, holders: readonly Task[]): FileHold | null {
  if (!task.plannedFiles?.length) return null;
  for (const holder of holders) {
    if (holder.id === task.id) continue;
    const files = overlappingFiles(task.plannedFiles, holder.plannedFiles);
    if (files.length > 0) return { byTaskId: holder.id, files };
  }
  return null;
}

/**
 * Every top-level, non-active card with files that an active card in the **same project**
 * holds — keyed by the held card's id. Files are repo-relative, so projects never overlap.
 *
 * `cards` should include steps, so a live step makes its parent active. This only answers
 * "held by an active card"; two candidates that overlap each other are ordered by
 * `planLanes`, which knows the lane order.
 */
export function fileHolds(
  cards: readonly Task[],
  running: ReadonlySet<string>,
  openPrs: ReadonlySet<string>,
): Map<string, FileHold> {
  const liveSteps = liveStepParents(cards, running);
  const holders = new Map<string, Task[]>();
  const waiting: Task[] = [];
  for (const task of cards) {
    if (task.parentTaskId) continue;
    if (isActiveHolder(task, running, liveSteps, openPrs)) {
      if (!task.plannedFiles?.length) continue;
      const group = holders.get(task.projectId);
      if (group) group.push(task);
      else holders.set(task.projectId, [task]);
    } else if (task.plannedFiles?.length) {
      waiting.push(task);
    }
  }

  const holds = new Map<string, FileHold>();
  for (const task of waiting) {
    const hold = holdAgainst(task, holders.get(task.projectId) ?? []);
    if (hold) holds.set(task.id, hold);
  }
  return holds;
}
