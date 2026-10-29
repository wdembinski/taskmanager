/**
 * Renderer long-task logging (F29.1).
 *
 * When main was started with `VIPPER_PERF_LOG=1` (`window.api.boot.perfLog`), `main.tsx`
 * installs a `longtask` observer before the first render, and every task Chromium reports
 * (50 ms or more) is sent to `main.log` as `perf longtask <screen> <ms>ms`. The screen is
 * whatever the shell last named through {@link setPerfScreen} — the tab, plus the open card
 * when there is one — so a freeze can be pinned to where the human was.
 *
 * DOM-free apart from the global `PerformanceObserver`, which is looked up at install time so
 * a unit test can stand a fake one in.
 */

/** One long task, as handed to the sink. `at` is the task's start, on `performance.now()`'s clock. */
export interface LongTaskEntry {
  screen: string;
  ms: number;
  at: number;
}

let currentScreen = 'boot';

/** Name the screen the next long tasks are charged to, e.g. `mytasks` or `mytasks/card`. */
export function setPerfScreen(name: string): void {
  currentScreen = name;
}

/** The screen long tasks are currently charged to. */
export function perfScreen(): string {
  return currentScreen;
}

/**
 * Start observing long tasks and hand each to `sink`. Returns a disposer that disconnects the
 * observer. A no-op (with a no-op disposer) when `enabled` is false, when there is no sink,
 * when `PerformanceObserver` does not exist, or when it does not support `longtask`.
 */
export function installLongTaskObserver({
  enabled,
  sink,
}: {
  enabled: boolean;
  sink: ((entry: LongTaskEntry) => void) | undefined;
}): () => void {
  const noop = (): void => {};
  if (!enabled || !sink) return noop;
  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
    .PerformanceObserver;
  if (!Observer || !(Observer.supportedEntryTypes ?? []).includes('longtask')) return noop;

  const observer = new Observer((list) => {
    for (const entry of list.getEntries()) {
      try {
        sink({ screen: currentScreen, ms: entry.duration, at: entry.startTime });
      } catch {
        // Logging must never break the page it is measuring.
      }
    }
  });
  try {
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    return noop;
  }
  return () => observer.disconnect();
}
