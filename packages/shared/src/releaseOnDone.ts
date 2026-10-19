/**
 * **Releasing a chain by hand** — what to do about the cards waiting on a card that a human
 * has just called Done.
 *
 * An `after-merge` arrow is satisfied by exactly one fact, the predecessor's `landedAt`
 * ({@link linkSatisfied}), and only a merge through the app writes it. A card dragged to
 * Done by hand keeps `landedAt == null`, so everything chained after it waits forever — and
 * a human card or a gate card has no branch at all, so it never could have landed. These
 * functions decide when to ASK about that, which answer to offer first, and what the
 * "Release waiting cards" action on a Done card still has to release.
 *
 * Pure, for the reason `@shared/taskChain` is: the renderer that asks and the main process
 * that releases must agree about which cards are held.
 */
import { columnForTask, hasAgentWorked, restingStatus } from './board';
import type { MergeRequest } from './mergeRequest';
import type { Task } from './model';
import { outgoingLinks, type TaskLink } from './taskChain';

/** Who moved the card. Only a human's move asks; a tracker's sync never does. */
export type MoveOrigin = 'human' | 'sync';

/** The answer the release dialog offers first — its primary, autofocused button. */
export type ReleaseChoice = 'release' | 'keep';

/** The three fields of a merge request this decision reads. */
export type ReleaseMr = Pick<MergeRequest, 'taskId' | 'openedForTaskId' | 'state'>;

/** What the dialog shows: the cards a release would free, and which button leads. */
export interface ReleasePrompt {
  targets: Task[];
  defaultChoice: ReleaseChoice;
}

function closed(task: Task): boolean {
  const resting = restingStatus(task);
  return resting === 'done' || resting === 'cancelled';
}

/**
 * The cards an `after-merge` arrow out of `task` is still holding — the outgoing
 * `after-merge` targets that are not themselves `done`/`cancelled`. A `stacked` arrow is
 * left out: it never waited for a merge, so marking the card landed changes nothing for it.
 */
export function heldSuccessors(
  task: Pick<Task, 'id'>,
  links: readonly TaskLink[],
  byId: ReadonlyMap<string, Task>,
): Task[] {
  const held: Task[] = [];
  for (const link of outgoingLinks(links, task.id)) {
    if (link.gate !== 'after-merge') continue;
    const to = byId.get(link.toTaskId);
    if (to && !closed(to)) held.push(to);
  }
  return held;
}

/**
 * Which answer the dialog leads with.
 *
 * A merged MR filed under the card means the work HAS merged and the app only missed it:
 * release. Otherwise an open MR, or a branch the card's agent has worked on, means a merge
 * is still coming and is the thing to wait for: keep. A card with neither — a human card, a
 * gate card — has nothing that could ever land, so release.
 */
export function releaseDefault(task: Task, mergeRequests: readonly ReleaseMr[]): ReleaseChoice {
  const mine = mergeRequests.filter(
    (mr) => mr.taskId === task.id || mr.openedForTaskId === task.id,
  );
  if (mine.some((mr) => mr.state === 'merged')) return 'release';
  if (mine.some((mr) => mr.state === 'opened')) return 'keep';
  if (task.agentProjectId && hasAgentWorked(task)) return 'keep';
  return 'release';
}

/**
 * Whether moving a card from `before` to `after` asks about the cards waiting on it, and
 * what it asks — or `null` for no dialog.
 *
 * It asks only when a HUMAN moved the card from a column other than DONE into Done, the
 * card has not landed, and at least one card is still held by an `after-merge` arrow out of
 * it. A sync's move never asks: nobody is there to answer, and the tracker's Done says
 * nothing about whether the branch merged.
 */
export function releasePrompt(input: {
  origin: MoveOrigin;
  before: Task;
  after: Task;
  links: readonly TaskLink[];
  byId: ReadonlyMap<string, Task>;
  mergeRequests: readonly ReleaseMr[];
}): ReleasePrompt | null {
  const { before, after } = input;
  if (input.origin !== 'human') return null;
  if (columnForTask(before) === 'done' || restingStatus(after) !== 'done') return null;
  if (after.landedAt != null) return null;
  const targets = heldSuccessors(after, input.links, input.byId);
  if (!targets.length) return null;
  return { targets, defaultChoice: releaseDefault(after, input.mergeRequests) };
}

/**
 * What the "Release waiting cards" action on a card's panel would release — the same
 * cards, offered later: the card is Done, has not landed, and still holds somebody.
 * Empty means the action is not offered.
 */
export function releasableByHand(
  task: Task,
  links: readonly TaskLink[],
  byId: ReadonlyMap<string, Task>,
): Task[] {
  if (restingStatus(task) !== 'done' || task.landedAt != null) return [];
  return heldSuccessors(task, links, byId);
}
