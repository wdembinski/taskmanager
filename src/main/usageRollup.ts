/**
 * Pure token-usage aggregation — the app's own accounting (no AI involved).
 *
 * Given the raw `UsageSample` rows the store recorded from the CLI's per-turn token
 * counts, these functions compute the rolling-5-hour-window rollup (totals, per-task
 * and per-project shares), the time-bucketed series behind the live area chart, and
 * the instantaneous burn rate. Kept free of any database or Electron dependency so it
 * is trivially unit-testable — same discipline as `activityMerge`.
 */
import {
  BURN_WINDOW_SEC,
  type BurnRate,
  type RunningLow,
  type UsageBreakdown,
  type UsageSample,
  type UsageSlice,
  type UsageSummary,
  type UsageSeriesPoint,
  USAGE_WINDOW_MS,
} from '@shared/usage';

/** Inputs for a window rollup. Names/limit context come from the caller (store/scheduler). */
export interface RollupOptions {
  /** "Now" in epoch ms (injectable for tests). */
  now: number;
  /** Window length; defaults to the 5-hour rolling window. */
  windowMs?: number;
  /** When Claude's usage window resets (epoch ms), for display; null if unknown. */
  windowReset?: number | null;
  /** projectId → display name. */
  projectNames?: Map<string, string>;
  /** taskId → title. */
  taskTitles?: Map<string, string>;
  /** Last rate-limit status the CLI reported (e.g. 'allowed_warning'), or null. */
  limitStatus?: string | null;
  /** Whether the account-wide usage-limit gate is currently engaged. */
  limitActive?: boolean;
  /** Cost (USD) spent in the window, summed by the store. */
  windowCost?: number;
  /** Trailing window for the burn-rate reading, in seconds. */
  burnWindowSec?: number;
}

/** Sum the four token kinds across a set of samples. */
function sumBreakdown(samples: UsageSample[]): UsageBreakdown {
  const b: UsageBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const s of samples) {
    b.input += s.inputTokens;
    b.output += s.outputTokens;
    b.cacheCreation += s.cacheCreationTokens;
    b.cacheRead += s.cacheReadTokens;
  }
  return b;
}

/** Group samples into `{id,label,tokens,pct}` slices, sorted by tokens desc. */
function slice(
  samples: UsageSample[],
  keyOf: (s: UsageSample) => string | null,
  labelOf: (id: string) => string,
  total: number,
): UsageSlice[] {
  const byId = new Map<string, number>();
  for (const s of samples) {
    const id = keyOf(s);
    if (id === null) continue; // e.g. orchestrator samples have no taskId
    byId.set(id, (byId.get(id) ?? 0) + s.totalTokens);
  }
  return [...byId.entries()]
    .map(([id, tokens]) => ({ id, label: labelOf(id), tokens, pct: total > 0 ? (tokens / total) * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** Total tokens spent within the half-open interval [from, to). */
function tokensBetween(samples: UsageSample[], from: number, to: number): number {
  let sum = 0;
  for (const s of samples) {
    if (s.createdAt >= from && s.createdAt < to) sum += s.totalTokens;
  }
  return sum;
}

/**
 * The instantaneous burn rate: tokens/min over the trailing `windowSec`, with a
 * trend arrow derived by comparing that window against the one immediately before it.
 */
export function burnRate(
  samples: UsageSample[],
  now: number,
  windowSec: number = BURN_WINDOW_SEC,
): BurnRate {
  const windowMs = windowSec * 1000;
  const current = tokensBetween(samples, now - windowMs, now + 1);
  const previous = tokensBetween(samples, now - 2 * windowMs, now - windowMs);
  const perMinute = (current / windowSec) * 60;
  // A 5% band keeps the arrow from flickering on tiny fluctuations.
  const band = Math.max(previous * 0.05, 1);
  const trend: BurnRate['trend'] =
    current > previous + band ? 'up' : current < previous - band ? 'down' : 'flat';
  return { perMinute, trend };
}

/**
 * Bucket samples into a fixed-width time series for the chart. Produces a dense
 * series (zero-filled buckets) from `sinceMs` up to and including the bucket that
 * contains `now`, so the area chart scrolls smoothly even through idle gaps.
 */
export function bucketSeries(
  samples: UsageSample[],
  sinceMs: number,
  bucketMs: number,
  now: number,
): UsageSeriesPoint[] {
  if (bucketMs <= 0) return [];
  const start = Math.floor(sinceMs / bucketMs) * bucketMs;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const points = new Map<number, number>();
  for (let t = start; t <= end; t += bucketMs) points.set(t, 0);
  for (const s of samples) {
    const bucket = Math.floor(s.createdAt / bucketMs) * bucketMs;
    if (bucket < start) continue;
    points.set(bucket, (points.get(bucket) ?? 0) + s.totalTokens);
  }
  return [...points.entries()].sort((a, b) => a[0] - b[0]).map(([t, tokens]) => ({ t, tokens }));
}

/** Decide the running-low state from Claude's own signals (no manual budget in v1). */
function runningLowFrom(limitActive: boolean, limitStatus: string | null): RunningLow {
  if (limitActive) return 'critical';
  if (limitStatus && /warn|reject|blocked/i.test(limitStatus)) return 'warning';
  return 'ok';
}

/**
 * Roll a window's worth of samples into the dashboard summary. `samples` should be
 * pre-filtered to the window by the store, but we re-clip defensively so the totals,
 * shares and burn rate are always internally consistent.
 */
export function rollupWindow(samples: UsageSample[], opts: RollupOptions): UsageSummary {
  const windowMs = opts.windowMs ?? USAGE_WINDOW_MS;
  const windowStart = opts.now - windowMs;
  const inWindow = samples.filter((s) => s.createdAt >= windowStart);
  const windowTotal = inWindow.reduce((n, s) => n + s.totalTokens, 0);

  const projectNames = opts.projectNames ?? new Map<string, string>();
  const taskTitles = opts.taskTitles ?? new Map<string, string>();
  const SOURCE_LABEL: Record<string, string> = { task: 'Tasks', orchestrator: 'Orchestrator' };

  return {
    windowStart,
    windowEnd: opts.now,
    windowReset: opts.windowReset ?? null,
    windowTotal,
    breakdown: sumBreakdown(inWindow),
    byProject: slice(
      inWindow,
      (s) => s.projectId,
      (id) => projectNames.get(id) ?? 'Unknown project',
      windowTotal,
    ),
    byTask: slice(
      inWindow,
      (s) => s.taskId,
      (id) => taskTitles.get(id) ?? id.slice(0, 8),
      windowTotal,
    ),
    bySource: slice(
      inWindow,
      (s) => s.source,
      (id) => SOURCE_LABEL[id] ?? id,
      windowTotal,
    ),
    burn: burnRate(inWindow, opts.now, opts.burnWindowSec),
    limitStatus: opts.limitStatus ?? null,
    costUsd: opts.windowCost ?? 0,
    runningLow: runningLowFrom(opts.limitActive ?? false, opts.limitStatus ?? null),
  };
}
