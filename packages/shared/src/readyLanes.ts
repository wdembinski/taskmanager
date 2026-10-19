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
import { isRunStatus, restingStatus } from './board';
import type { MergeRequest } from './mergeRequest';
import type { Task } from './model';
import { priorityRank } from './priority';
import { blockedBy, chainDecline, incomingLinks, type TaskLink } from './taskChain';
import { parseTicketKey } from './ticketKey';

/** A project's lanes when nobody has set them. `0` means unlimited. */
export const DEFAULT_READY_LANES = 3;

/** One project's answer. `ready` and `queued` never overlap, and neither holds a step. */
export interface LanePlan {
  /** Candidates that fit in a free lane — what the board marks ready, and the engine starts. */
  ready: Set<string>;
  /** Candidates whose turn has come but for which no lane is free. */
  queued: Set<string>;
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

/**
 * Whether this card holds a lane: a live run on it or on one of its steps, a run status it
 * still wears, or a review that has an open PR behind it. `liveSteps` is the set of parents
 * whose steps are running.
 */
function holdsLane(
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
  const liveSteps = new Set<string>();
  for (const t of byId.values()) {
    if (t.parentTaskId && (running.has(t.id) || isRunStatus(t.status))) {
      liveSteps.add(t.parentTaskId);
    }
  }

  let occupied = 0;
  const candidates: Task[] = [];
  for (const task of cards) {
    if (task.parentTaskId) continue;
    if (holdsLane(task, running, liveSteps, openPrs)) {
      occupied++;
      continue;
    }
    if (incomingLinks(links, task.id).length === 0) continue;
    if (blockedBy(task, links, byId).length > 0) continue;
    if (chainDecline(task, running.has(task.id)) !== null) continue;
    candidates.push(task);
  }

  candidates.sort(compareLaneOrder);
  const free = cap === 0 ? candidates.length : Math.max(0, cap - occupied);
  return {
    ready: new Set(candidates.slice(0, free).map((t) => t.id)),
    queued: new Set(candidates.slice(free).map((t) => t.id)),
    occupied,
    cap,
  };
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
