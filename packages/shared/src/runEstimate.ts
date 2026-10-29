/**
 * The Start dialog's estimate line (F28.1, mockup v11-4): `$6–12 · 7–9 sessions · ~40 min`.
 *
 * Built from what this app's past sessions actually cost, never from a price list — a guess
 * dressed as a figure is worse than no line at all, so no history means no estimate.
 *
 * Pure, and here rather than in the dialog, so the arithmetic is testable without a renderer.
 */

/** What past sessions cost, summarised by whoever reads the history. */
export interface RunEstimateStats {
  /** How many past sessions the figures below come from. 0 = no history. */
  sessionCount: number;
  /** A cheap and a dear session in USD — e.g. the 25th and 75th percentiles. */
  costPerSessionUsd: { low: number; high: number };
  /** How long one session typically runs, in minutes. */
  minutesPerSession: number;
}

/** The three parts of the estimate line, joined by ` · ` in the dialog. */
export interface RunEstimate {
  /** `$6–12` */
  cost: string;
  /** `7–9 sessions` */
  sessions: string;
  /** `~40 min` */
  duration: string;
}

/**
 * Sessions beyond the plan and one per step a run may take: the final review, and one round
 * of fixes it sends back. The upper end of the range, not a cap.
 */
const EXTRA_SESSIONS = 2;

/**
 * The estimate for a run of `stepCount` steps, or `null` when there is nothing to base it on
 * (no stats, no past sessions, or figures that are not finite).
 *
 * - Sessions: one plan plus one per step, up to {@link EXTRA_SESSIONS} more.
 * - Cost: the fewest sessions at the cheap rate, to the most at the dear rate, in whole
 *   dollars (rounded outward, so the range never claims more precision than it has).
 * - Duration: the fewest sessions back to back, to the nearest 5 minutes.
 */
export function estimateRun(
  stats: RunEstimateStats | null | undefined,
  stepCount: number,
): RunEstimate | null {
  if (!stats || stats.sessionCount <= 0) return null;
  const { low, high } = stats.costPerSessionUsd;
  if (![low, high, stats.minutesPerSession, stepCount].every(Number.isFinite)) return null;

  const fewest = 1 + Math.max(0, Math.round(stepCount));
  const most = fewest + EXTRA_SESSIONS;
  const costLow = Math.floor(fewest * Math.max(0, Math.min(low, high)));
  const costHigh = Math.max(costLow, Math.ceil(most * Math.max(0, low, high)));
  const minutes = fewest * Math.max(0, stats.minutesPerSession);
  const roundedMinutes =
    minutes < 5 ? Math.max(1, Math.round(minutes)) : Math.round(minutes / 5) * 5;

  return {
    cost: costLow === costHigh ? `$${costLow}` : `$${costLow}–${costHigh}`,
    sessions: `${fewest}–${most} sessions`,
    duration: `~${roundedMinutes} min`,
  };
}

/** One finished session as the history read returns it. */
export interface RunSample {
  /** What the session cost; a row without a cost never reaches here. */
  costUsd: number;
  /** Start to finish in ms; `null` when its start was not recorded. */
  durationMs: number | null;
}

/** The value at fraction `q` (0–1) of an ascending list, by nearest rank. */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/**
 * Summarises past sessions into {@link RunEstimateStats}: the 25th and 75th percentile cost,
 * and the median duration of the sessions whose start is known. `null` when there are no
 * sessions to go on — the dialog then shows no estimate rather than a made-up one.
 */
export function summariseRunSamples(samples: readonly RunSample[]): RunEstimateStats | null {
  const costs = samples
    .map((s) => s.costUsd)
    .filter((c) => Number.isFinite(c) && c >= 0)
    .sort((a, b) => a - b);
  if (costs.length === 0) return null;
  const minutes = samples
    .map((s) => s.durationMs)
    .filter((ms): ms is number => ms !== null && Number.isFinite(ms) && ms >= 0)
    .map((ms) => ms / 60_000)
    .sort((a, b) => a - b);
  return {
    sessionCount: costs.length,
    costPerSessionUsd: { low: quantile(costs, 0.25), high: quantile(costs, 0.75) },
    minutesPerSession: minutes.length > 0 ? quantile(minutes, 0.5) : 0,
  };
}
