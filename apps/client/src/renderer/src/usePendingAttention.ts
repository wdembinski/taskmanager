/**
 * The inbox item parked on a task **or any of its steps**, kept current — seeded from
 * `attention:list` and updated by `attention:new` / `attention:resolved`, so a question
 * that arrives while you are reading the card appears on its own.
 *
 * It takes a list of ids because a card executing an approved plan never holds the item
 * itself: the step that is running (or has failed) does, and that item is unreachable
 * from the card unless it is looked up by the whole chain's ids. Earlier ids win, so a
 * card's own item beats a step's.
 *
 * Shared by the agent panel (which answers the item) and the detail pane's composer
 * (which must know a run is blocked on approve/deny before offering to chat at it), so
 * both read one subscription's worth of truth rather than two that can drift.
 *
 * SUPERSEDED by `useAttentionIndex` (Phase 17), which subscribes once for the whole board
 * and returns a LIST. Two things are wrong here and are fixed there: it surfaces only the
 * first item of a chain, and `attention:resolved` sets `null` without re-querying — so
 * answering one of two pending items silently swallows the other. It also ends up mounted
 * twice per selected card, holding two independent copies of the same state.
 *
 * Kept until its two callers (`TaskDetail`, `TaskAgentPanel`) are rewritten together in
 * the detail-pane phase; changing the signature now would mean touching them twice.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AttentionItem } from '@shared/attention';

export function usePendingAttention(
  taskIds: readonly (string | null | undefined)[],
): [AttentionItem | null, Dispatch<SetStateAction<AttentionItem | null>>] {
  const [item, setItem] = useState<AttentionItem | null>(null);
  // The ids as one stable value, so the subscription re-runs when the CHAIN changes and
  // not on every render of the array literal the caller passes.
  const key = taskIds.filter(Boolean).join('|');

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    if (!key) return;
    const owned = new Set(key.split('|'));
    const rank = (i: AttentionItem): number => key.split('|').indexOf(i.taskId);
    void window.api
      .invoke('attention:list')
      .then((items) => {
        if (cancelled) return;
        const mine = items.filter((i) => owned.has(i.taskId)).sort((a, b) => rank(a) - rank(b));
        setItem(mine[0] ?? null);
      })
      .catch(() => undefined);

    const offNew = window.api.on('attention:new', (incoming) => {
      if (!owned.has(incoming.taskId)) return;
      // A newer item for a task we already show replaces it; one for a task further
      // down the chain must not displace the card's own ask.
      setItem((prev) => (prev && rank(prev) < rank(incoming) ? prev : incoming));
    });
    const offResolved = window.api.on('attention:resolved', ({ id }) => {
      setItem((prev) => (prev && prev.id === id ? null : prev));
    });
    return () => {
      cancelled = true;
      offNew();
      offResolved();
    };
  }, [key]);

  return [item, setItem];
}
