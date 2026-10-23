/**
 * **Ready lanes** — how many of a project's cards the board calls *ready* at once.
 *
 * The owner starts every card the board marks ready, all of them, in parallel. That is the
 * point of the chip, and it stops working the day nine cards wear it together: the runs
 * collide on the same files and nobody can follow what is happening. So a project has a
 * number of **lanes** (see {@link DEFAULT_READY_LANES}), the cards already holding one count
 * against it, and only as many of the remaining candidates as there are free lanes are
 * `ready`. The rest are `queued` — their turn has come, but there is no lane for them yet.
 *
 * Pure — no React, no DB, no Electron — so the desktop board, the web board and the chain
 * engine's auto-start all answer from this one function and cannot disagree about which
 * cards are ready. The same reasoning as `@shared/taskChain`, whose gates it reuses rather
 * than restating: a candidate is exactly a card the board's chain chip would call ready.
 *
 * What it deliberately does NOT do is widen "ready". A card nobody chained gets no chip and
 * is never auto-started today, so it is never a candidate here either — a lane cap that
 * suddenly put unchained cards up for release would change what the word means.
 */
import { holdAgainst, isActiveHolder, liveStepParents, type FileHold } from './fileOverlap';
import type { MergeRequest } from './mergeRequest';
import type { Task } from './model';
import { priorityRank } from './priority';
import { blockedBy, chainDecline, incomingLinks, stepsTaken, type TaskLink } from './taskChain';
import { parseTicketKey } from './ticketKey';

/** A project's lanes when nobody has set them. `0` means unlimited. */
export const DEFAULT_READY_LANES = 3;

/**
 * One project's answer. `ready`, `queued` and `fileHeld` never overlap, and none holds a step.
 */
export interface LanePlan {
  /** Candidates that fit in a free lane — what the board marks ready, and the engine starts. */
  ready: Set<string>;
  /** Candidates whose turn has come but for which no lane is free. */
  queued: Set<string>;
  /**
   * Candidates whose files overlap an active card's, or an earlier `ready` candidate's — keyed
   * by candidate, naming the card it waits for. A held card takes no lane: it is neither
   * ready nor queued, so it never pushes another card out of a lane it cannot use.
   */
  fileHeld: Map<string, FileHold>;
  /** Top-level cards already holding a lane. May exceed `cap`. */
  occupied: number;
  /** The cap this plan was drawn against. `0` = unlimited. */
  cap: number;
}

/**
 * The ids of the cards with an **open** pull/merge request — a card in review with one
 * still holds its lane, because its branch may yet come back for another run.
 *
 * Matched on both `taskId` (what the sync last attributed the MR to) and `openedForTaskId`
 * (the card whose button opened it), since either can be the one that is set.
 */
export function openPrTaskIds(
  mrs: readonly Pick<MergeRequest, 'taskId' | 'openedForTaskId' | 'state'>[],
): Set<string> {
  const ids = new Set<string>();
  for (const mr of mrs) {
    if (mr.state !== 'opened') continue;
    if (mr.taskId) ids.add(mr.taskId);
    if (mr.openedForTaskId) ids.add(mr.openedForTaskId);
  }
  return ids;
}

/** The ordinal in a card's key, or null when it has no parseable one. */
function ticketNumber(task: Task): number | null {
  const key = task.ticketKey || task.externalKey;
  return key ? (parseTicketKey(key)?.ticketNumber ?? null) : null;
}

/**
 * The order candidates take lanes in: priority (most urgent first), then ticket number
 * (numerically — TM-9 before TM-10; a card with no number after every numbered one), then
 * the card's insertion `order`, then `id` so the answer never depends on input order.
 */
export function compareLaneOrder(a: Task, b: Task): number {
  const byPriority = priorityRank(b.externalPriority) - priorityRank(a.externalPriority);
  if (byPriority !== 0) return byPriority;

  const na = ticketNumber(a);
  const nb = ticketNumber(b);
  if (na !== nb) {
    if (na == null) return 1;
    if (nb == null) return -1;
    return na - nb;
  }

  if (a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The plan for one project's cards, with `byId` able to see predecessors anywhere. */
function planLanes(
  cards: readonly Task[],
  links: readonly TaskLink[],
  byId: ReadonlyMap<string, Task>,
  running: ReadonlySet<string>,
  cap: number,
  openPrs: ReadonlySet<string>,
): LanePlan {
  // A running step holds its parent's lane, whichever project the step was filed under.
  const liveSteps = liveStepParents(byId.values(), running);

  let occupied = 0;
  const holders: Task[] = [];
  const candidates: Task[] = [];
  for (const task of cards) {
    if (task.parentTaskId) continue;
    if (isActiveHolder(task, running, liveSteps, openPrs)) {
      occupied++;
      holders.push(task);
      continue;
    }
    if (incomingLinks(links, task.id).length === 0) continue;
    if (blockedBy(task, links, byId).length > 0) continue;
    if (chainDecline(task, running.has(task.id)) !== null) continue;
    // Its steps are finished, under way or parked: there is no step to start, so it must not
    // take a lane.
    if (stepsTaken(task, byId.values(), (id) => running.has(id))) continue;
    candidates.push(task);
  }

  candidates.sort(compareLaneOrder);
  // A candidate is held when its files overlap an active card's, or a candidate that went
  // ahead of it into a lane — of two overlapping candidates the first by lane order runs and
  // the second waits for it. Lanes are then handed out over what is left; a queued
  // candidate holds nothing, since it is not about to run either.
  const free = cap === 0 ? Infinity : Math.max(0, cap - occupied);
  const ready: Task[] = [];
  const queued = new Set<string>();
  const fileHeld = new Map<string, FileHold>();
  for (const task of candidates) {
    const hold = holdAgainst(task, holders) ?? holdAgainst(task, ready);
    if (hold) fileHeld.set(task.id, hold);
    else if (ready.length < free) ready.push(task);
    else queued.add(task.id);
  }
  return { ready: new Set(ready.map((t) => t.id)), queued, fileHeld, occupied, cap };
}

/**
 * One project's lanes.
 *
 * `cards` must be every card of the project — the ones holding a lane and their steps as
 * well as the candidates — or the occupied count comes out short. A predecessor that is not
 * in `cards` reads as unsatisfied (see `linkSatisfied`), so for chains that cross projects
 * use {@link readyLanesByProject}, which sees every card.
 *
 * `running` is the set of live-run ids: the engine's `inFlight`, or the board's live-run set.
 */
export function readyLanes(
  cards: readonly Task[],
  links: readonly TaskLink[],
  running: ReadonlySet<string>,
  cap: number,
  openPrTaskIds: ReadonlySet<string> = new Set(),
): LanePlan {
  const byId = new Map(cards.map((t) => [t.id, t]));
  return planLanes(cards, links, byId, running, cap, openPrTaskIds);
}

/**
 * Every project's lanes, grouped by `task.projectId` — the project a card is filed under,
 * whose settings hold its cap. Projects do not share lanes.
 */
export function readyLanesByProject(
  cards: readonly Task[],
  links: readonly TaskLink[],
  running: ReadonlySet<string>,
  capOf: (projectId: string) => number,
  openPrTaskIds: ReadonlySet<string> = new Set(),
): Map<string, LanePlan> {
  const byId = new Map(cards.map((t) => [t.id, t]));
  const byProject = new Map<string, Task[]>();
  for (const t of cards) {
    if (t.parentTaskId) continue;
    const group = byProject.get(t.projectId);
    if (group) group.push(t);
    else byProject.set(t.projectId, [t]);
  }

  const plans = new Map<string, LanePlan>();
  for (const [projectId, group] of byProject) {
    plans.set(projectId, planLanes(group, links, byId, running, capOf(projectId), openPrTaskIds));
  }
  return plans;
}
