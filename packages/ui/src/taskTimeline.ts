/**
 * The task detail pane's conversation, kept as a pure state machine — so the race that
 * put task B's chat under task A's title can be tested at all.
 *
 * `TaskDetail` fetches a card's activity, then (for a ticketed card) its ticket comments,
 * across two separate `await`s. Switching cards fast enough starts a second load before
 * the first has settled, and the two answers are not guaranteed to land in request order.
 * There is no DOM test harness anywhere in this workspace (no jsdom, no testing-library),
 * so the only way to prove the race is actually closed is to pull the state transitions
 * out of the component and test them as plain functions — the same shape as `taskChat.ts`
 * and `agentActivity.ts`.
 *
 * `applied` is the sequence number of the newest load this state has accepted anything
 * from. Every transition below refuses to touch `activity`/`ticketComments`/`loading`
 * unless its own `(taskId, seq)` is still the frontier — an older `seq`, or a `seq` for a
 * card this state has moved on from, is a no-op returning the SAME state object.
 */
import type { TaskActivityEntry } from '@tm/shared/model';

export interface TimelineState {
  /** The card this state belongs to, or null when nothing is selected. */
  taskId: string | null;
  /** The newest load sequence number this state has accepted anything from. */
  applied: number;
  activity: readonly TaskActivityEntry[];
  ticketComments: readonly TaskActivityEntry[];
  /** True from the moment a load starts until its ticket-comments answer lands. */
  loading: boolean;
}

export const EMPTY_TIMELINE: TimelineState = {
  taskId: null,
  applied: 0,
  activity: [],
  ticketComments: [],
  loading: false,
};

/** Whether an answer carrying `(taskId, seq)` is still the frontier `state` accepts. */
export function timelineAccepts(state: TimelineState, taskId: string | null, seq: number): boolean {
  return taskId === state.taskId && seq >= state.applied;
}

/**
 * A load began. Always becomes the new frontier — a `seq` older than what is already
 * applied is the only thing this refuses, which cannot happen through normal use since
 * callers mint `seq` from one ever-increasing counter.
 *
 * Switching cards (`taskId` differs) blanks the timeline so the new card starts from
 * nothing; reloading the SAME card (a poll, `session:gap`, a merge landing) keeps
 * whatever is already on screen — the four reload paths must not blank a timeline that
 * is already correct.
 */
export function timelineLoadStarted(
  state: TimelineState,
  taskId: string | null,
  seq: number,
): TimelineState {
  if (seq < state.applied) return state;
  const sameTask = taskId === state.taskId;
  return {
    taskId,
    applied: seq,
    activity: sameTask ? state.activity : [],
    ticketComments: sameTask ? state.ticketComments : [],
    loading: true,
  };
}

/** The first await (a card's own activity) answered. Loading stays on for the tail. */
export function timelineActivityArrived(
  state: TimelineState,
  taskId: string | null,
  seq: number,
  activity: readonly TaskActivityEntry[],
): TimelineState {
  if (!timelineAccepts(state, taskId, seq)) return state;
  return { ...state, activity };
}

/** The second await (the linked ticket's comments) answered — the load is done. */
export function timelineCommentsArrived(
  state: TimelineState,
  taskId: string | null,
  seq: number,
  ticketComments: readonly TaskActivityEntry[],
): TimelineState {
  if (!timelineAccepts(state, taskId, seq)) return state;
  return { ...state, ticketComments, loading: false };
}
