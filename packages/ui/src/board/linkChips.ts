/**
 * The needs/unblocks chips a card wears when Off (`linkMode.ts`) has turned the gutter
 * arrows off. The facts do not go away with the drawing — a card still waits on what it
 * waits on — so this is the same two questions `blockedBy`/`successorsOf` answer, folded
 * into one call `TaskCard` can render without drawing a single pixel over the board.
 *
 * `needs`' tone reuses `chainArrows.ts`'s own three-way split (`blocked`/`releasing`) rather
 * than inventing a second one: `satisfied` is `linkSatisfied`, `releasing` is a predecessor
 * still unsatisfied but visibly running (`isRunStatus`, or a live run the caller already
 * knows of), and `waiting` is everything else. The overlay's cyan "starting next" and this
 * chip's cyan both mean the exact same thing about the exact same predecessor — two readings
 * of one fact, never two.
 */
import { isRunStatus } from '@tm/shared/board';
import type { Task } from '@tm/shared/model';
import { linkSatisfied, predecessorsOf, successorsOf, type TaskLink } from '@tm/shared/taskChain';

/** See the module doc — `releasing` is the only tone the chip spends colour on. */
export type LinkChipTone = 'releasing' | 'waiting' | 'satisfied';

/** One predecessor named on the `needs` chip. */
export interface NeedsChip {
  /** What the chip prints — the predecessor's own ticket key, or its title when it has none. */
  key: string;
  tone: LinkChipTone;
}

/** One successor named on the `unblocks` chip — no tone: what THIS card is doing is this
 *  card's own business, not a fact about the successor. */
export interface UnblocksChip {
  key: string;
}

export interface LinkChips {
  needs: NeedsChip[];
  unblocks: UnblocksChip[];
}

/** A card's ticket key when it has one, falling back to its title, and finally to its own
 *  id for a predecessor/successor this board does not have (an endpoint `tasksById` misses
 *  entirely — see `ChainStub`, the same case the overlay draws a stub for). */
function keyOf(task: Task | undefined, fallbackId: string): string {
  return task?.ticketKey || task?.externalKey || task?.title || fallbackId;
}

/**
 * The needs/unblocks chips for `taskId`, as `TaskCard` renders them.
 *
 * `runningTaskIds` is the caller's, exactly as `chainArrows.buildChainDrawing`'s own
 * `runningTaskIds` is: only the engine (or a renderer holding its live-run set) knows a
 * run that has spawned but is not yet persisted as `running`, so a predecessor just spun up
 * still reads as `releasing` rather than lagging a tick behind the overlay.
 */
export function linkChips(
  taskId: string,
  links: readonly TaskLink[],
  tasksById: ReadonlyMap<string, Task>,
  runningTaskIds: ReadonlySet<string> = new Set(),
): LinkChips {
  const needs = predecessorsOf(links, taskId).map((fromId): NeedsChip => {
    const link = links.find((l) => l.fromTaskId === fromId && l.toTaskId === taskId) as TaskLink;
    const fromTask = tasksById.get(fromId);
    const blocked = !linkSatisfied(link, fromTask);
    const sourceRunning = Boolean(
      fromTask && (isRunStatus(fromTask.status) || runningTaskIds.has(fromId)),
    );
    const tone: LinkChipTone = !blocked ? 'satisfied' : sourceRunning ? 'releasing' : 'waiting';
    return { key: keyOf(fromTask, fromId), tone };
  });

  const unblocks = successorsOf(links, taskId).map((toId): UnblocksChip => ({
    key: keyOf(tasksById.get(toId), toId),
  }));

  return { needs, unblocks };
}
