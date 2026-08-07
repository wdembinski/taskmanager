/**
 * Shared token-usage vocabulary (Performance dashboard).
 *
 * The app tracks EVERYTHING that consumes the account's token quota — every task
 * agent session and the orchestrator's own "Align plan" run — by reading the token
 * counts the `claude` CLI already reports on each turn (see the `usage` SessionEvent).
 * These numbers are computed and aggregated BY THE APP, never by an AI agent.
 *
 * A `UsageSample` is one recorded model call's consumption, attributed to its source.
 * `UsageSummary` is the rolled-up view for the current rolling 5-hour window, and
 * `UsageSeriesPoint[]` is the time-bucketed series behind the live area chart.
 */

/** Which part of the app spent the tokens. */
export type UsageSource = 'task' | 'orchestrator';

/** One recorded model call's token consumption, with attribution. */
export interface UsageSample {
  source: UsageSource;
  /** The project the tokens were spent for, or null if unknown. */
  projectId: string | null;
  /** The task the tokens were spent for; null for orchestrator/aux runs. */
  taskId: string | null;
  /** The run (session execution) the sample belongs to. */
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Convenience sum of the four token kinds. */
  totalTokens: number;
  /** Epoch ms when the sample was recorded. */
  createdAt: number;
}

/** The four token kinds, summed over a set of samples. */
export interface UsageBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** One row of a per-project or per-task breakdown, with its share of the window. */
export interface UsageSlice {
  /** projectId / taskId / source key. */
  id: string;
  /** Human label (project name, task title, or source name). */
  label: string;
  tokens: number;
  /** Percent of the window total, 0–100. */
  pct: number;
}

/** The live burn rate: how fast tokens are being spent right now. */
export interface BurnRate {
  /** Tokens per minute over the trailing burn window. */
  perMinute: number;
  /** Tokens per second over the trailing burn window (the gauge's primary reading). */
  perSecond: number;
  /** Direction vs. the immediately preceding window (for the gauge's trend arrow). */
  trend: 'up' | 'down' | 'flat';
}

/**
 * One project's usage, broken down for the drill-down tree: its own task spend and
 * its orchestrator ("Align") spend kept separate, plus a per-task list. `tokens` is
 * the project's grand total (tasks + orchestrator).
 */
export interface UsageProjectBreakdown {
  projectId: string | null;
  label: string;
  tokens: number;
  /** Percent of the range's grand total, 0–100. */
  pct: number;
  /** Tokens spent by this project's task agents. */
  taskTokens: number;
  /** Tokens spent by the orchestrator on this project's behalf (the Align run). */
  orchestratorTokens: number;
  /** Per-task rows within this project (task agent spend only), tokens desc. */
  tasks: UsageSlice[];
}

/** How close the account is to running out, for the warning indicator. */
export type RunningLow = 'ok' | 'warning' | 'critical';

/** The rolled-up usage view for the current rolling 5-hour window. */
export interface UsageSummary {
  /** Window bounds (epoch ms). The window is the trailing 5 hours. */
  windowStart: number;
  windowEnd: number;
  /** When Claude's usage window resets (epoch ms), if the CLI has told us; else null. */
  windowReset: number | null;
  /** Total tokens spent in the window (the % denominator). */
  windowTotal: number;
  breakdown: UsageBreakdown;
  byProject: UsageSlice[];
  byTask: UsageSlice[];
  bySource: UsageSlice[];
  /** Hierarchical drill-down: each project with its task + orchestrator split. */
  projects: UsageProjectBreakdown[];
  /** Total tokens spent by task agents across all projects, in the range. */
  taskTotal: number;
  /** Total tokens the orchestrator itself spent across all projects, in the range. */
  orchestratorTotal: number;
  burn: BurnRate;
  /** Last rate-limit status the CLI reported (e.g. 'allowed', 'allowed_warning'), or null. */
  limitStatus: string | null;
  /** Cost (USD) spent in the window, from the runs' `result` events. */
  costUsd: number;
  runningLow: RunningLow;
}

/** One bucket of the token-over-time series behind the area chart. */
export interface UsageSeriesPoint {
  /** Bucket start (epoch ms). */
  t: number;
  /** Total tokens spent in this bucket. */
  tokens: number;
}

/** The trailing rolling usage window: 5 hours, in ms. */
export const USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;
/** The weekly cap's window: 7 days, in ms — the other limit Claude enforces. */
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Default trailing window for the live burn-rate reading, in seconds. */
export const BURN_WINDOW_SEC = 60;

/**
 * The two windows Claude actually meters an account against, and the two the app
 * draws a bar for: the current **session** (the rolling 5 hours) and the **week**.
 */
export type UsageQuotaId = 'session' | 'weekly';

/**
 * How much of one metered window has been spent — the model behind a progress bar.
 *
 * `pct` is, whenever it can be, the number Claude's own `/usage` command reports —
 * read straight from the CLI (see `claudeUsage.ts`), the same figure the human would
 * see typing `/usage` themselves. That reading needs the CLI to be reachable and can
 * lag a few minutes behind (it is polled, not pushed), so `pctSource` says which shape
 * `pct` actually is: `'claude'` when it is that real reading, `'budget'` when the app
 * fell back to measured spend against the user's own Settings budget because no CLI
 * reading has landed yet — the shape doc 08 said a budget feature has to take when
 * there is nothing better: built on `token_usage`, never on a guess.
 */
export interface UsageQuota {
  id: UsageQuotaId;
  /** Window bounds (epoch ms). Anchored to `resetAt` when the CLI has told us one. */
  windowStart: number;
  windowEnd: number;
  /** When this window rolls over (epoch ms), if the CLI has said so; else null. */
  resetAt: number | null;
  /** Tokens spent inside the window, by this app's own sessions. */
  tokens: number;
  /** The budget `tokens` is compared against in the fallback, in tokens. 0 = none set. */
  limit: number;
  /**
   * Spend as a percent of the window. **Not clamped** in the `'budget'` fallback — a
   * window that ran past its budget says 130% rather than quietly reading full. 0 when
   * `pctSource` is `'budget'` and no budget is set.
   */
  pct: number;
  /** Whether `pct` is Claude's own reading or the local budget-spend estimate. */
  pctSource: 'claude' | 'budget';
}

/** Both metered windows, as one push/response payload. */
export interface UsageQuotas {
  session: UsageQuota;
  weekly: UsageQuota;
}

/**
 * Out-of-the-box budgets, in tokens, from the audit's own measurement rather than
 * from a plan's published limits (Claude publishes none in tokens).
 *
 * Doc 08 measured 1.82 billion tokens over 5.3 days of real work — 96% of it cache
 * reads — which is ~2.4B a week and ~72M in any 5-hour stretch. These are the next
 * round numbers up, so a heavy week lands near full rather than off the end, and both
 * are editable in Settings for an account that spends nothing like this one.
 */
export const DEFAULT_SESSION_TOKEN_BUDGET = 100_000_000;
export const DEFAULT_WEEKLY_TOKEN_BUDGET = 2_500_000_000;
