/**
 * The compact Inbox screen's (F3.3) state, kept as a pure reducer so the one thing worth
 * testing hard here — an item being resolved out from under the human, from another device
 * or another tab — can be proven without React. Same shape as `activity/feedState.ts`.
 *
 * Two different people can resolve the SAME item: the human looking at this inbox, or the
 * human on another device (or in another tab) looking at the same item at the same time.
 * `answeringId` is how a transition tells those apart — it is set for exactly as long as
 * OUR OWN `invoke` for that item is in flight, so a relayed `attention:resolved` landing for
 * that id is our own answer echoing back, not news from elsewhere. Everything else landing
 * for the open item IS news from elsewhere, and gets the `notice` that says so.
 */
import type { AttentionItem } from '@tm/shared/attention';

export interface InboxState {
  /** Null until the first `seeded`; distinguishes "still loading" from "loaded, empty". */
  items: AttentionItem[] | null;
  /** The item the detail view has open, or null when the list is showing. */
  openId: string | null;
  /** The item whose answer `invoke` is in flight, or null. See the file header. */
  answeringId: string | null;
  /** A message to show once, until `opened` or `noticeCleared` dismisses it. */
  notice: string | null;
}

/** Shown when the open item resolved somewhere other than this answer. */
export const ANSWERED_ELSEWHERE = 'Answered on another device';

export const EMPTY_INBOX_STATE: InboxState = {
  items: null,
  openId: null,
  answeringId: null,
  notice: null,
};

/**
 * Closes the open view with {@link ANSWERED_ELSEWHERE} if `openId` is no longer present in
 * `items` and isn't the item we are ourselves in the middle of answering. Shared by `resolved`
 * (one item removed) and `seeded` (the whole list replaced on reconnect) — both are "the open
 * item might not be here anymore," just reached from different directions.
 */
function closeIfOpenMissing(state: InboxState, items: readonly AttentionItem[]): InboxState {
  if (state.openId === null || state.openId === state.answeringId) return state;
  if (items.some((item) => item.id === state.openId)) return state;
  return { ...state, openId: null, notice: ANSWERED_ELSEWHERE };
}

/** The initial (or reconnected) list arrived. */
export function seeded(state: InboxState, items: readonly AttentionItem[]): InboxState {
  const nextItems = [...items];
  return closeIfOpenMissing({ ...state, items: nextItems }, nextItems);
}

/** A new item arrived over the live feed; ignored if we already have that id. */
export function arrived(state: InboxState, item: AttentionItem): InboxState {
  const items = state.items ?? [];
  if (items.some((existing) => existing.id === item.id)) return state;
  return { ...state, items: [...items, item] };
}

/**
 * An item resolved — ours or someone else's. See the file header for how `answeringId`
 * decides which: our own answer closes quietly, anything else closes with a notice (but
 * only if that item was the one open; a background resolution leaves the open view alone).
 */
export function resolved(state: InboxState, id: string): InboxState {
  const items = state.items === null ? null : state.items.filter((item) => item.id !== id);

  if (id === state.answeringId) {
    return {
      ...state,
      items,
      answeringId: null,
      openId: state.openId === id ? null : state.openId,
    };
  }
  if (id === state.openId) {
    return { ...state, items, openId: null, notice: ANSWERED_ELSEWHERE };
  }
  return { ...state, items };
}

/** The human opened an item's detail view; dismisses any stale notice. */
export function opened(state: InboxState, id: string): InboxState {
  return { ...state, openId: id, notice: null };
}

/** The human closed the detail view back to the list. */
export function closed(state: InboxState): InboxState {
  return { ...state, openId: null };
}

/** Our own answer `invoke` for `id` started. */
export function answerStarted(state: InboxState, id: string): InboxState {
  return { ...state, answeringId: id };
}

/**
 * Our own answer `invoke` for `id` succeeded: removes the item and closes it. Idempotent
 * with `resolved` already having done both if the relay message won the race.
 */
export function answerSucceeded(state: InboxState, id: string): InboxState {
  const items = state.items === null ? null : state.items.filter((item) => item.id !== id);
  return {
    ...state,
    items,
    answeringId: state.answeringId === id ? null : state.answeringId,
    openId: state.openId === id ? null : state.openId,
  };
}

/**
 * Our own answer `invoke` for `id` failed: clears `answeringId` only, keeping both the item
 * and the open view — the design never shows "answered" before the relay confirms it.
 */
export function answerFailed(state: InboxState, id: string): InboxState {
  if (state.answeringId !== id) return state;
  return { ...state, answeringId: null };
}

/** Dismisses the notice without touching anything else. */
export function noticeCleared(state: InboxState): InboxState {
  return { ...state, notice: null };
}
