/**
 * Where every chained card on the board stands — what it is still waiting for, and, once
 * it is waiting for nothing, whether the engine would actually start it.
 *
 * Extracted from the two boards that had a verbatim copy of it each (`MyTasks` and the
 * web's `BoardScreen`), which is how the desktop and the mirror stay one board. The
 * duplication was survivable while the answer was two fields; it stopped being so the
 * moment the answer had to agree with the ENGINE, because then there were three readings
 * of "can this start" and no test that could see any of them.
 *
 * Computed once for the whole board rather than per card, and only for cards with an arrow
 * INTO them: `readyToRelease` is vacuously true for everything else, so asking per card
 * would have every unchained card on the board answering a question about a feature nobody
 * used on it.
 */
import type { Task } from '@tm/shared/model';
import {
  awaitingMerge,
  blockedBy,
  chainDecline,
  type ChainDecline,
  type TaskLink,
} from '@tm/shared/taskChain';

/** Where one chained card stands. See {@link chainStates}. */
export interface ChainState {
  /**
   * The predecessors this card is still waiting on (`blockedBy`) — the cards themselves,
   * because "waiting on VIP-3" sends you somewhere and "waiting on 1 card" sends you
   * hunting for the arrow.
   */
  waitingOn: Task[];
  /**
   * The subset of {@link waitingOn} waiting on nothing but a human pressing Merge
   * (`awaitingMerge`). A subset derived from the same links in the same pass, so the chip's
   * noun and its verb can never come from two different readings of the board.
   */
  mergeHeld: Task[];
  /**
   * Every predecessor has finished **and the engine would start this card** — the window
   * between the chain opening and the card actually moving. Worth saying out loud because
   * it is exactly when a card looks abandoned: it sits in To Do like any other, and the
   * only thing that distinguishes it is that its turn has come.
   */
  ready: boolean;
  /**
   * Its turn has come and the engine would NOT start it, with the reason — `null` while
   * the card is still waiting on an arrow, and `null` again once nothing is in the way.
   *
   * The state that had nowhere to be said. A card the chain declined kept its explanation
   * on its own timeline and showed nothing at all on the board: no *waiting on* chip
   * (its arrows were satisfied) and no *ready* chip (the old predicate quietly answered
   * false), so a solid arrow led to a card that looked like every other idle one. The
   * reported symptom was a chain that "did not start", and the cause was a successor
   * nobody had assigned an agent to.
   */
  blocked: ChainDecline | null;
}

/**
 * The state of every card an arrow points at, keyed by task id.
 *
 * `inFlight` is the ids the engine has a live run reserved for — the board's own live-run
 * set. It is passed rather than inferred from `status` because a run is reserved before it
 * has borrowed the card's status, and `ChainDecline`'s first question is exactly that
 * reservation.
 */
export function chainStates(
  links: readonly TaskLink[],
  tasksById: ReadonlyMap<string, Task>,
  inFlight: ReadonlySet<string> = new Set<string>(),
): Map<string, ChainState> {
  const byTask = new Map<string, ChainState>();
  for (const id of new Set(links.map((l) => l.toTaskId))) {
    const task = tasksById.get(id);
    if (!task) continue;
    const waitingOn = blockedBy(task, links, tasksById);
    // Asked only once the arrows are satisfied: a card that is still waiting has its chip
    // already, and "waiting on VIP-3, and also unassigned" is two problems reported as one.
    const decline = waitingOn.length === 0 ? chainDecline(task, inFlight.has(id)) : null;
    byTask.set(id, {
      waitingOn,
      mergeHeld: awaitingMerge(task, links, tasksById),
      ready: waitingOn.length === 0 && decline === null,
      blocked: decline,
    });
  }
  return byTask;
}
