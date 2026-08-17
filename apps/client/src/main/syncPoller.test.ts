import { MAX_SYNC_INTERVAL_MINUTES } from '@shared/settings';
import { describe, expect, it, vi } from 'vitest';
import { SyncPoller, type SyncService } from './syncPoller';
import type { Store } from './store';

function storeWith(syncIntervalMinutes: number | undefined): Store {
  return {
    getSettings: () => ({ syncIntervalMinutes }) as ReturnType<Store['getSettings']>,
  } as unknown as Store;
}

describe('SyncPoller', () => {
  it('ticks once per configured interval, not on every timer resolution', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockResolvedValue(undefined);
      const service: SyncService = { id: 'jira', isEnabled: () => true, run };
      const poller = new SyncPoller(storeWith(2), [service]);
      poller.reschedule();

      await vi.advanceTimersByTimeAsync(119_000);
      expect(run).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(run).toHaveBeenCalledTimes(2);

      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // The actual reported bug: a `syncIntervalMinutes` past what a 32-bit `setInterval` delay
  // can hold (`2**31 - 1` ms, ~35791 minutes) overflows silently, and the runtime clamps the
  // delay to ~1ms instead of erroring — so an oversized interval synced continuously instead
  // of "rarely". `reschedule` must clamp before it ever reaches `setInterval`.
  it('never fires faster than MAX_SYNC_INTERVAL_MINUTES even for a wildly oversized setting', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockResolvedValue(undefined);
      const service: SyncService = { id: 'jira', isEnabled: () => true, run };
      const poller = new SyncPoller(storeWith(999_999_999), [service]);
      poller.reschedule();

      // One tick's worth of the CAPPED interval minus a second: still nothing.
      await vi.advanceTimersByTimeAsync(MAX_SYNC_INTERVAL_MINUTES * 60_000 - 1_000);
      expect(run).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);

      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a non-finite interval as off rather than as fast as possible', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockResolvedValue(undefined);
      const service: SyncService = { id: 'jira', isEnabled: () => true, run };
      const poller = new SyncPoller(storeWith(NaN), [service]);
      poller.reschedule();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(0);

      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps a tick still in flight with the next one due', async () => {
    vi.useFakeTimers();
    try {
      let resolveRun: (() => void) | undefined;
      const run = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          }),
      );
      const service: SyncService = { id: 'jira', isEnabled: () => true, run };
      const poller = new SyncPoller(storeWith(1), [service]);
      poller.reschedule();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);

      // The next tick comes due while the first is still unresolved.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);

      resolveRun?.();
      await vi.advanceTimersByTimeAsync(0);
      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
