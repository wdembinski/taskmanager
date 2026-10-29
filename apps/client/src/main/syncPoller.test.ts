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

  it('pauses only the backed-off service, leaving the others on their normal interval', async () => {
    vi.useFakeTimers();
    try {
      const resetAt = Date.now() + 5 * 60_000;
      const jiraRun = vi.fn().mockResolvedValue(undefined);
      const githubRun = vi.fn().mockResolvedValue(undefined);
      const gitlabRun = vi
        .fn()
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValue(undefined);
      const services: SyncService[] = [
        { id: 'jira', isEnabled: () => true, run: jiraRun },
        { id: 'github', isEnabled: () => true, run: githubRun },
        {
          id: 'gitlab',
          isEnabled: () => true,
          run: gitlabRun,
          backoffUntil: () => resetAt,
        },
      ];
      const poller = new SyncPoller(storeWith(1), services);
      poller.reschedule();

      // First tick: all three are due; gitlab rejects and records its back-off.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(jiraRun).toHaveBeenCalledTimes(1);
      expect(githubRun).toHaveBeenCalledTimes(1);
      expect(gitlabRun).toHaveBeenCalledTimes(1);

      // Next few ticks, still inside the back-off window: jira/github keep running every
      // interval, gitlab is skipped.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(jiraRun).toHaveBeenCalledTimes(4);
      expect(githubRun).toHaveBeenCalledTimes(4);
      expect(gitlabRun).toHaveBeenCalledTimes(1);

      // One more tick lands exactly on the reset: gitlab is swept again (and this time
      // succeeds).
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gitlabRun).toHaveBeenCalledTimes(2);

      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a service that never settles does not stop the others running on later ticks', async () => {
    vi.useFakeTimers();
    try {
      const jiraRun = vi.fn().mockResolvedValue(undefined);
      const githubRun = vi.fn().mockResolvedValue(undefined);
      const gitlabRun = vi.fn(() => new Promise<void>(() => {})); // never settles
      const services: SyncService[] = [
        { id: 'jira', isEnabled: () => true, run: jiraRun },
        { id: 'github', isEnabled: () => true, run: githubRun },
        { id: 'gitlab', isEnabled: () => true, run: gitlabRun },
      ];
      const poller = new SyncPoller(storeWith(1), services);
      poller.reschedule();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(jiraRun).toHaveBeenCalledTimes(1);
      expect(githubRun).toHaveBeenCalledTimes(1);
      expect(gitlabRun).toHaveBeenCalledTimes(1);

      // jira/github keep being swept on the following ticks; gitlab is never re-entered
      // since it is still "in flight".
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(jiraRun).toHaveBeenCalledTimes(3);
      expect(githubRun).toHaveBeenCalledTimes(3);
      expect(gitlabRun).toHaveBeenCalledTimes(1);

      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries on the next tick when backoffUntil returns null', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockRejectedValue(new Error('transient'));
      const service: SyncService = {
        id: 'gitlab',
        isEnabled: () => true,
        run,
        backoffUntil: () => null,
      };
      const poller = new SyncPoller(storeWith(1), [service]);
      poller.reschedule();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(2);

      poller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
