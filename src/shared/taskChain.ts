/**
 * The **chain of execution** — "do this one after that one", drawn between cards.
 *
 * A board says what there is to do; it has never said what ORDER it has to happen in.
 * Two cards that touch the same file, or one that cannot start until another's branch
 * has landed, look exactly like two independent cards, and the only place that ordering
 * lived was in the head of whoever set the work up. A link is that knowledge written
 * down: an arrow from one card to another, plus the **gate** that says what "after"
 * means for this particular pair.
 *
 * Pure — no React, no DB, no Electron — so the engine (which releases the next card)
 * and the board (which draws the arrows and greys out what is waiting) answer every
 * question from the same functions and cannot disagree about whether a card is ready.
 * The same reasoning as `@shared/board`.
 *
 * Deliberately NOT `Task.dependsOn`: that is a plan project's `@needs:` clause, matched
 * by TITLE within one project's parsed plan and re-derived from the file on every sync.
 * These are edges between arbitrary cards, drawn by a human, that survive a re-sync.
 */
import { isRunStatus, restingStatus } from './board';
import type { Task, TaskStatus } from './model';

/**
 * What "after" means for one link.
 *
 * - `after-merge` — the strict one, and the default: the predecessor's work must have
 *   **landed** (see {@link Task.landedAt}). Use it when the successor would otherwise
 *   build on code that is still under review and might yet change.
 * - `stacked`  — the loose one: the predecessor has stopped WORKING, and there is a
 *   branch to stack the next card on top of. Use it for a chain you want to keep moving
 *   while review happens, accepting that the base may still be rewritten under you.
 */
export type LinkGate = 'after-merge' | 'stacked';

/** Every gate, in the order the picker offers them (strictest first). */
export const LINK_GATES = ['after-merge', 'stacked'] as const satisfies readonly LinkGate[];

/** How each gate reads on screen — a phrase that completes "runs …". */
export const LINK_GATE_LABEL: Record<LinkGate, string> = {
  'after-merge': 'after the branch merges',
  stacked: 'stacked on the branch',
};

/** The same gate as a PICKER's label — a noun phrase, where {@link LINK_GATE_LABEL} is a clause. */
export const LINK_GATE_TITLE: Record<LinkGate, string> = {
  'after-merge': 'After merge',
  stacked: 'Stacked on this branch',
};

/**
 * The one line under each choice.
 *
 * Both gates are a trade, and neither name says which way: "stacked" sounds like a
 * technique rather than like a risk accepted. So each choice says what you GET and what
 * you give up, in the order you care about them.
 */
export const LINK_GATE_HELP: Record<LinkGate, string> = {
  'after-merge':
    'Waits for the branch to land, so this card starts from code that is settled. The safe one.',
  stacked:
    'Starts as soon as the other card stops working — sooner, but its branch may still be rewritten underneath.',
};

/** Narrow an unvalidated string (an IPC argument, a DB column) to a gate. */
export function isLinkGate(value: unknown): value is LinkGate {
  return value === 'after-merge' || value === 'stacked';
}

/** One directed edge: `toTaskId` runs after `fromTaskId`, subject to `gate`. */
export interface TaskLink {
  /** Stable app-assigned id (UUID) — what the unlink / change-gate calls address. */
  id: string;
  /** The card that has to happen first. */
  fromTaskId: string;
  /** The card that waits. */
  toTaskId: string;
  gate: LinkGate;
  createdAt: number;
}

/** The two fields a link cares about, so a caller need not assemble a whole `Task`. */
export type LinkEnd = Pick<Task, 'id' | 'parentTaskId'>;

/**
 * Why a proposed link was refused. `null` from {@link canLink} means it is allowed.
 *
 * Enumerated rather than returned as a boolean because every one of these needs a
 * different sentence: "that would be a loop" and "you cannot chain a step" are refusals
 * for opposite reasons, and a drag that just silently snaps back teaches nobody anything.
 */
export type LinkRefusal = 'missing' | 'self' | 'step' | 'duplicate' | 'cycle';

/** The refusal in words — the drag's tooltip and the handler's rejection message. */
export const LINK_REFUSAL_MESSAGE: Record<LinkRefusal, string> = {
  missing: 'one of those cards no longer exists',
  self: 'a card cannot wait for itself',
  step: 'steps of a plan already run in order — chain their cards instead',
  duplicate: 'those cards are already linked',
  cycle: 'that would make a loop, and a loop can never start',
};

/**
 * What drawing a link came to.
 *
 * A refusal comes back as DATA rather than as a rejected promise: "those two are already
 * linked" and "that would be a loop" are things the human should be told, not errors, and
 * the board has to say which one it was. Same shape as `ChatSendResult`.
 */
export type LinkResult =
  { status: 'ok'; links: TaskLink[] } | { status: 'refused'; reason: LinkRefusal };

/** The links INTO a task — the ones saying something must happen before it. */
export function incomingLinks(links: readonly TaskLink[], taskId: string): TaskLink[] {
  return links.filter((l) => l.toTaskId === taskId);
}

/** The links OUT OF a task — what it releases when its own work is done. */
export function outgoingLinks(links: readonly TaskLink[], taskId: string): TaskLink[] {
  return links.filter((l) => l.fromTaskId === taskId);
}

/** The ids this task is waiting on. */
export function predecessorsOf(links: readonly TaskLink[], taskId: string): string[] {
  return incomingLinks(links, taskId).map((l) => l.fromTaskId);
}

/** The ids waiting on this task — who the runner asks about when this one lands. */
export function successorsOf(links: readonly TaskLink[], taskId: string): string[] {
  return outgoingLinks(links, taskId).map((l) => l.toTaskId);
}

/**
 * Whether adding `from → to` would close a loop.
 *
 * Walks FORWARD from `to`: if the chain already leads back to `from`, then the new edge
 * completes a circle in which every card waits for another card that is waiting for it.
 * Such a chain can never start, and nothing downstream would ever say so — the card would
 * simply sit there looking merely un-started. So the edge is refused at the moment it is
 * drawn, in both the renderer (for live feedback) and the handler (for correctness).
 *
 * `from === to` is the degenerate loop and is reported here too, so a caller that skips
 * {@link canLink} still cannot create one.
 */
export function wouldCycle(links: readonly TaskLink[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([to]);
  const queue = [to];
  while (queue.length) {
    const at = queue.pop() as string;
    for (const next of successorsOf(links, at)) {
      if (next === from) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Whether `from → to` may be drawn, and why not when it may not.
 *
 * A **step** is refused at either end on purpose: the steps of an approved plan already
 * run strictly in `order`, one at a time, in the parent's worktree — their order IS a
 * chain, and a second, contradictory one over the top of it could only ever mean the two
 * disagree. Chain the parent cards; the steps come along with them.
 */
export function canLink(
  links: readonly TaskLink[],
  from: LinkEnd | undefined,
  to: LinkEnd | undefined,
): LinkRefusal | null {
  if (!from || !to) return 'missing';
  if (from.id === to.id) return 'self';
  if (from.parentTaskId || to.parentTaskId) return 'step';
  if (links.some((l) => l.fromTaskId === from.id && l.toTaskId === to.id)) return 'duplicate';
  if (wouldCycle(links, from.id, to.id)) return 'cycle';
  return null;
}

/**
 * Every card reachable from `taskId` by following links in EITHER direction — the whole
 * chain it belongs to, including itself.
 *
 * Undirected on purpose: focus mode's question is "show me this piece of work and
 * everything it is entangled with", which includes the card two hops upstream and the
 * sibling that branches off it. A card with no links is a component of one, so focusing
 * an unlinked card shows exactly that card rather than an empty board.
 */
export function chainComponent(links: readonly TaskLink[], taskId: string): Set<string> {
  const seen = new Set<string>([taskId]);
  const queue = [taskId];
  while (queue.length) {
    const at = queue.pop() as string;
    for (const l of links) {
      const other = l.fromTaskId === at ? l.toTaskId : l.toTaskId === at ? l.fromTaskId : null;
      if (other === null || seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return seen;
}

/**
 * The statuses that mean a card's work is WRITTEN — there is something on a branch to
 * stack the next card on. `done` and `in-review` only: a card still in To Do or In
 * Progress has, as far as the board knows, nothing to build on yet.
 */
const WORK_WRITTEN: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['in-review', 'done']);

/**
 * Whether one link's condition is met, given the card it waits on.
 *
 * `after-merge` asks one question — has this landed (`landedAt`) — and that is deliberately
 * a stored fact rather than one inferred from the card's column or its MR's state: a card
 * dragged back out of Done, or an MR list that has not been polled yet, must not
 * un-release a chain that already started.
 *
 * `stacked` asks whether there is a branch to stack on and whether anything is still
 * rewriting it. A live run never satisfies it, however far along it looks. Otherwise the
 * work counts as written when the card reached in-review/done, or — the escape hatch for
 * a run that stopped or failed part-way — when the card has actually run (`sessionId`) and
 * has a branch of its own. That last case is genuinely useful and genuinely risky, which
 * is exactly why `after-merge` is the default gate.
 *
 * An unknown predecessor is NOT satisfied. It should be impossible (the link rows cascade
 * away with their cards), and if it ever happens the safe reading is "keep waiting".
 */
export function linkSatisfied(link: TaskLink, fromTask: Task | undefined): boolean {
  if (!fromTask) return false;
  if (link.gate === 'after-merge') return fromTask.landedAt != null;
  if (isRunStatus(fromTask.status)) return false;
  if (WORK_WRITTEN.has(restingStatus(fromTask))) return true;
  return Boolean(fromTask.sessionId && fromTask.agentBranch);
}

/**
 * Whether every link into this card is satisfied — an **AND-join**.
 *
 * A card fed by three arrows waits for all three. The alternative (release on the first
 * one) would start work whose whole reason for waiting was the other two, and a diamond —
 * A splits into B and C, both feeding D — is the commonest shape a chain takes.
 *
 * Vacuously true for a card with no incoming links, which is every card on the board
 * until somebody draws one: this function never holds back work nobody chained.
 */
export function readyToRelease(
  task: Pick<Task, 'id'>,
  links: readonly TaskLink[],
  byId: ReadonlyMap<string, Task>,
): boolean {
  return readyToReleaseGiven(task, links, byId, null);
}

/**
 * The same AND-join as {@link readyToRelease}, with ONE predecessor taken as satisfied
 * whatever the board currently says about it.
 *
 * The engine releases at the instant it watched a predecessor finish, and at that instant
 * the board has not caught up: a `stacked` release fires from the handler that settles a
 * run, several lines before that handler writes the card's new status, so asking
 * {@link linkSatisfied} about it would answer "still running" about a run we have just seen
 * end. Rather than re-deriving the card's imminent state — which is how the engine and the
 * board come to disagree — the caller names the one card it has first-hand knowledge of.
 *
 * Every OTHER link into the successor is judged normally, so a diamond still waits for its
 * other arm. `null` asserts nothing and is exactly {@link readyToRelease}.
 */
export function readyToReleaseGiven(
  task: Pick<Task, 'id'>,
  links: readonly TaskLink[],
  byId: ReadonlyMap<string, Task>,
  satisfiedId: string | null,
): boolean {
  return incomingLinks(links, task.id).every(
    (l) => l.fromTaskId === satisfiedId || linkSatisfied(l, byId.get(l.fromTaskId)),
  );
}

/**
 * The predecessors this card is still waiting on — what its chip names, so "waiting on"
 * says WHOM rather than merely that it is waiting.
 *
 * Empty exactly when {@link readyToRelease} is true, save for the impossible case of a
 * link whose predecessor is missing: that still blocks (see {@link linkSatisfied}) but
 * cannot be named.
 */
export function blockedBy(
  task: Pick<Task, 'id'>,
  links: readonly TaskLink[],
  byId: ReadonlyMap<string, Task>,
): Task[] {
  const waiting: Task[] = [];
  for (const link of incomingLinks(links, task.id)) {
    const from = byId.get(link.fromTaskId);
    if (from && !linkSatisfied(link, from)) waiting.push(from);
  }
  return waiting;
}
