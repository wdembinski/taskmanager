/**
 * A chained card's place in its chain — the "2 of 5" a compact card shows instead of the
 * wide board's arrows, which this layout has no room to draw.
 *
 * Pure, over `@tm/shared/taskChain`'s own links — the engine's graph, not a second one.
 */
import { chainComponent, predecessorsOf, type TaskLink } from '@tm/shared/taskChain';

/** Where one card stands in its chain. See {@link chainPosition}. */
export interface ChainPosition {
  /** 1-based: this card's own step number. */
  n: number;
  /** The chain's longest step number — the "of 5" half of "2 of 5". */
  m: number;
}

/**
 * The longest predecessor path ending at `taskId`, i.e. how many hops back to a card with
 * no predecessor of its own. Memoized across the whole call so a diamond's shared ancestor
 * is only walked once.
 *
 * `inProgress` guards a cycle that should be impossible (`wouldCycle` refuses one at link
 * time): a predecessor still being visited on the current path is treated as a dead end
 * (length 0) rather than re-entered, so a cycle that somehow got drawn cannot hang this.
 */
function longestPathLength(
  links: readonly TaskLink[],
  taskId: string,
  memo: Map<string, number>,
  inProgress: Set<string>,
): number {
  const cached = memo.get(taskId);
  if (cached !== undefined) return cached;
  if (inProgress.has(taskId)) return 0;
  inProgress.add(taskId);
  let longest = 0;
  for (const predecessorId of predecessorsOf(links, taskId)) {
    const length = 1 + longestPathLength(links, predecessorId, memo, inProgress);
    if (length > longest) longest = length;
  }
  inProgress.delete(taskId);
  memo.set(taskId, longest);
  return longest;
}

/**
 * `taskId`'s position in its chain, or `null` when it has no links at all.
 *
 * `n` is 1 + the longest predecessor path reaching this card — a linear chain numbers
 * 1, 2, 3 in order, and a fork's siblings share the same number since each has the same
 * longest path back to the chain's root. `m` is the largest `n` across the whole
 * component (`chainComponent`, undirected), so every card in one chain agrees on how long
 * the chain is, whichever one of them is asking.
 */
export function chainPosition(links: readonly TaskLink[], taskId: string): ChainPosition | null {
  const component = chainComponent(links, taskId);
  if (component.size <= 1) return null;

  const memo = new Map<string, number>();
  const inProgress = new Set<string>();
  let n = 0;
  let m = 0;
  for (const id of component) {
    const position = 1 + longestPathLength(links, id, memo, inProgress);
    if (id === taskId) n = position;
    if (position > m) m = position;
  }
  return { n, m };
}
