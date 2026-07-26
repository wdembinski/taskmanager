/**
 * The inbox item parked on ONE task, kept current — seeded from `attention:list` and
 * updated by `attention:new` / `attention:resolved`, so a question that arrives while
 * you are reading the card appears on its own.
 *
 * Shared by the agent panel (which answers the item) and the detail pane's composer
 * (which must know a run is blocked on approve/deny before offering to chat at it), so
 * both read one subscription's worth of truth rather than two that can drift.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AttentionItem } from '@shared/attention';

export function usePendingAttention(
  taskId: string | null,
): [AttentionItem | null, Dispatch<SetStateAction<AttentionItem | null>>] {
  const [item, setItem] = useState<AttentionItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    if (!taskId) return;
    void window.api
      .invoke('attention:list')
      .then((items) => {
        if (!cancelled) setItem(items.find((i) => i.taskId === taskId) ?? null);
      })
      .catch(() => undefined);

    const offNew = window.api.on('attention:new', (incoming) => {
      if (incoming.taskId === taskId) setItem(incoming);
    });
    const offResolved = window.api.on('attention:resolved', ({ id }) => {
      setItem((prev) => (prev && prev.id === id ? null : prev));
    });
    return () => {
      cancelled = true;
      offNew();
      offResolved();
    };
  }, [taskId]);

  return [item, setItem];
}
