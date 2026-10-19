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
 * used on it. The one exception is a card in To Do held by another card's files
 * ({@link ChainState.fileHold}): the queue pump holds it whether or not anybody chained it,
 * so it gets an otherwise idle entry that carries only the hold.
 */
import { columnForTask } from '@tm/shared/board';
import { fileHolds, type FileHold } from '@tm/shared/fileOverlap';
import type { Task } from '@tm/shared/model';
import { readyLanesByProject } from '@tm/shared/readyLanes';
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
  /**
   * Its turn has come and the engine would start it, but every one of its project's ready
   * lanes is taken (`readyLanes`). Never true alongside {@link ready}: a queued card is the
   * one the cap held back, and `ready` is false for it. Only ever set when the board passes
   * the lane inputs to {@link chainStates}.
   */
  queued: boolean;
  /**
   * The card is held because an active card in its project touches the same files
   * (`fileOverlap`) — or, for two overlapping chain candidates, because the first by lane
   * order went ahead. Never set alongside {@link ready} or {@link queued}: a held card takes
   * no lane. Only ever set when the board passes the lane inputs to {@link chainStates}.
   */
  fileHold?: ChainFileHold;
}

/** {@link ChainState.fileHold}: the card it waits for, and its own overlapping entries. */
export interface ChainFileHold extends FileHold {
  /** The holder's key as a chip shows it — its ticket key, else its title. */
  byKey: string;
}

/** A card's key as the chip names it. */
function keyOf(task: Task | undefined, fallbackId: string): string {
  return task?.ticketKey || task?.externalKey || task?.title || fallbackId;
}

/** An idle state for a card nobody chained, which only exists to carry its file hold. */
const UNCHAINED: Omit<ChainState, 'fileHold'> = {
  waitingOn: [],
  mergeHeld: [],
  ready: false,
  blocked: null,
  queued: false,
};

/**
 * What {@link chainStates} needs to cap the ready set per project — the same inputs the
 * chain engine's auto-start reads, so the chip and the release cannot disagree.
 */
export interface LaneInputs {
  /** A project's Ready lanes (`0` = unlimited). */
  capOf(projectId: string): number;
  /** Cards with an open PR (`openPrTaskIds`): a card in review with one holds its lane. */
  openPrTaskIds: ReadonlySet<string>;
  /** Every card on the board, steps included, so the occupied lanes are all counted. */
  cards: readonly Task[];
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
  lanes?: LaneInputs,
): Map<string, ChainState> {
  const byTask = new Map<string, ChainState>();
  // Without lane inputs nothing is queued, and every card the chain would start is ready.
  // With them, only the candidates the cap holds back lose `ready` — a step is never a
  // candidate, so a chained step keeps the answer it had.
  const laneQueued = new Set<string>();
  const holds = new Map<string, FileHold>();
  if (lanes) {
    const plans = readyLanesByProject(
      lanes.cards,
      links,
      inFlight,
      lanes.capOf,
      lanes.openPrTaskIds,
    );
    for (const plan of plans.values()) {
      for (const id of plan.queued) laneQueued.add(id);
      for (const [id, hold] of plan.fileHeld) holds.set(id, hold);
    }
    // Every other card sitting in To Do with files — unchained ones included, since the
    // project queue pump holds them as well (`selectNextPending`). A chain candidate's own
    // answer above wins: it also knows about the candidate that went ahead of it.
    for (const [id, hold] of fileHolds(lanes.cards, inFlight, lanes.openPrTaskIds)) {
      if (holds.has(id)) continue;
      const task = tasksById.get(id);
      if (task && columnForTask(task) === 'todo') holds.set(id, hold);
    }
  }
  const fileHoldOf = (id: string): ChainFileHold | undefined => {
    const hold = holds.get(id);
    return hold && { ...hold, byKey: keyOf(tasksById.get(hold.byTaskId), hold.byTaskId) };
  };
  for (const id of new Set(links.map((l) => l.toTaskId))) {
    const task = tasksById.get(id);
    if (!task) continue;
    const waitingOn = blockedBy(task, links, tasksById);
    // Asked only once the arrows are satisfied: a card that is still waiting has its chip
    // already, and "waiting on VIP-3, and also unassigned" is two problems reported as one.
    const decline = waitingOn.length === 0 ? chainDecline(task, inFlight.has(id)) : null;
    const startable = waitingOn.length === 0 && decline === null;
    const fileHold = fileHoldOf(id);
    const queued = startable && laneQueued.has(id);
    byTask.set(id, {
      waitingOn,
      mergeHeld: awaitingMerge(task, links, tasksById),
      // A held candidate is in neither `ready` nor `queued` (`LanePlan.fileHeld`).
      ready: startable && !queued && !fileHold,
      blocked: decline,
      queued,
      ...(fileHold && { fileHold }),
    });
  }
  // The held cards nobody chained — the chip is all they need, so everything else is idle.
  for (const id of holds.keys()) {
    if (byTask.has(id)) continue;
    const fileHold = fileHoldOf(id);
    if (fileHold) byTask.set(id, { ...UNCHAINED, fileHold });
  }
  return byTask;
}
