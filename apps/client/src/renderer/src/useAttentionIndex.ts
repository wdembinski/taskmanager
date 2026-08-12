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
 *
 * `AttentionIndex` itself lives in `@tm/ui` (`attentionIndex.ts`) — `TaskDetail` takes one
 * as a prop, so the type has to be visible on that side of the package boundary too. This
 * hook is the only thing that BUILDS one, and it stays here: it talks to `window.api`
 * directly, which is exactly the thing `@tm/ui` components no longer do.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AttentionItem } from '@shared/attention';
import { buildAttentionIndex, type AttentionIndex } from '@ui/attentionIndex';

export type { AttentionIndex };

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

  // The index itself is built in `@tm/ui` — apps/web builds the same one from the same
  // list, over the relay rather than over `window.api`, and two copies of "how a card's
  // ring is decided" is precisely what would drift.
  return useMemo(() => buildAttentionIndex(items), [items]);
}
