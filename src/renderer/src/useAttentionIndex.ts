/**
 * The whole inbox, kept current, indexed by task.
 *
 * Mounted ONCE (in `MyTasks`) and passed down, replacing three separate subscriptions
 * that between them caused three bugs:
 *
 *   1. **The board never subscribed to `attention:*` at all.** A card's orange ring was
 *      derived from `Task.status` plus JIRA timestamps, so an inbox item only reached the
 *      board via the side effect that the engine also flips the task to `waiting-input`.
 *      Anything raised without that flip — or restored from disk after a restart — sat
 *      there wanting you in silence.
 *   2. **`usePendingAttention` surfaced only the first item** and, on `attention:resolved`,
 *      set `null` without re-querying. Two pending items on one card meant answering the
 *      first silently swallowed the second until you reselected the card.
 *   3. **It was mounted twice per selected card** (the detail pane and the agent panel),
 *      so two round-trips and two subscriptions held independent state that could disagree.
 *
 * One subscription, one truth, and `taskIds` is what the ring and the sort order both read.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AttentionItem } from '@shared/attention';

export interface AttentionIndex {
  /** Items per task id, newest last. Only tasks with at least one item appear. */
  byTask: ReadonlyMap<string, AttentionItem[]>;
  /** Every task id the inbox is holding something for — the ring's authoritative signal. */
  taskIds: ReadonlySet<string>;
  /** Total open items, for the nav rail's badge. */
  count: number;
  /**
   * The items parked on any of `ids`, in the order the ids were given, so a card's own
   * ask outranks a step's. The replacement for `usePendingAttention`'s single item.
   */
  itemsFor: (ids: readonly (string | null | undefined)[]) => AttentionItem[];
}

export function useAttentionIndex(): AttentionIndex {
  const [items, setItems] = useState<readonly AttentionItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .invoke('attention:list')
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => undefined);

    const offNew = window.api.on('attention:new', (incoming) => {
      // Replace-or-append rather than append: the engine re-emits an item when it is
      // re-raised on the same run, and two copies would double the badge count.
      setItems((prev) => [...prev.filter((i) => i.id !== incoming.id), incoming]);
    });
    const offResolved = window.api.on('attention:resolved', ({ id }) => {
      setItems((prev) => prev.filter((i) => i.id !== id));
    });
    return () => {
      cancelled = true;
      offNew();
      offResolved();
    };
  }, []);

  return useMemo(() => {
    const byTask = new Map<string, AttentionItem[]>();
    for (const item of items) {
      const list = byTask.get(item.taskId);
      if (list) list.push(item);
      else byTask.set(item.taskId, [item]);
    }
    const taskIds = new Set(byTask.keys());
    return {
      byTask,
      taskIds,
      count: items.length,
      itemsFor: (ids) => {
        const out: AttentionItem[] = [];
        for (const id of ids) {
          if (!id) continue;
          const list = byTask.get(id);
          if (list) out.push(...list);
        }
        return out;
      },
    };
  }, [items]);
}
