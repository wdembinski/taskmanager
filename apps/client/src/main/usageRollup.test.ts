/**
 * Unit tests for the pure token-usage aggregation. No database, no Electron —
 * just samples in, summary/series out, so the app's accounting is pinned down.
 */
import { describe, expect, it } from 'vitest';
import { type UsageSample, USAGE_WINDOW_MS, WEEKLY_WINDOW_MS } from '@shared/usage';
import {
  bucketSeries,
  burnRate,
  rollupQuotas,
  rollupWindow,
  type TokensIn,
  usageQuota,
} from './usageRollup';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Build a usage sample with sensible defaults; totalTokens is derived if omitted. */
function sample(partial: Partial<UsageSample> & { createdAt: number }): UsageSample {
  const input = partial.inputTokens ?? 0;
  const output = partial.outputTokens ?? 0;
  const cacheCreation = partial.cacheCreationTokens ?? 0;
  const cacheRead = partial.cacheReadTokens ?? 0;
  return {
    source: partial.source ?? 'task',
    // Respect an explicit null (orchestrator rows) — `??` would swallow it.
    projectId: partial.projectId === undefined ? 'p1' : partial.projectId,
    taskId: partial.taskId === undefined ? 't1' : partial.taskId,
    runId: partial.runId ?? 'r1',
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    totalTokens: partial.totalTokens ?? input + output + cacheCreation + cacheRead,
    createdAt: partial.createdAt,
  };
}

describe('rollupWindow', () => {
  const now = 10_000_000;

  it('totals the window and computes each task/project share as a percent', () => {
    const samples = [
      sample({ taskId: 'a', projectId: 'p1', inputTokens: 30_000, createdAt: now - MIN }),
      sample({ taskId: 'b', projectId: 'p1', inputTokens: 50_000, createdAt: now - 2 * MIN }),
      sample({
        taskId: null,
        source: 'orchestrator',
        projectId: 'p1',
        inputTokens: 20_000,
        createdAt: now - 3 * MIN,
      }),
    ];
    const summary = rollupWindow(samples, {
      now,
      projectNames: new Map([['p1', 'Proj One']]),
      taskTitles: new Map([
        ['a', 'Task A'],
        ['b', 'Task B'],
      ]),
    });

    expect(summary.windowTotal).toBe(100_000);
    // By task excludes the orchestrator sample (null taskId).
    expect(summary.byTask).toEqual([
      { id: 'b', label: 'Task B', tokens: 50_000, pct: 50 },
      { id: 'a', label: 'Task A', tokens: 30_000, pct: 30 },
    ]);
    // The whole project (incl. the orchestrator run) is 100% of this single-project window.
    expect(summary.byProject).toEqual([{ id: 'p1', label: 'Proj One', tokens: 100_000, pct: 100 }]);
    // Sources split task vs orchestrator.
    expect(summary.bySource).toEqual([
      { id: 'task', label: 'Tasks', tokens: 80_000, pct: 80 },
      { id: 'orchestrator', label: 'Orchestrator', tokens: 20_000, pct: 20 },
    ]);
  });

  it('excludes samples older than the 5-hour window', () => {
    const samples = [
      sample({ inputTokens: 100, createdAt: now - MIN }),
      sample({ inputTokens: 999, createdAt: now - 6 * 60 * MIN }), // 6h ago — out of window
    ];
    const summary = rollupWindow(samples, { now });
    expect(summary.windowTotal).toBe(100);
  });

  it('sums the input/output/cache breakdown', () => {
    const samples = [
      sample({
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
        createdAt: now - MIN,
      }),
      sample({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        createdAt: now - MIN,
      }),
    ];
    const summary = rollupWindow(samples, { now });
    expect(summary.breakdown).toEqual({ input: 11, output: 22, cacheCreation: 33, cacheRead: 44 });
  });

  it('flags running-low from limit signals', () => {
    expect(rollupWindow([], { now, limitActive: true }).runningLow).toBe('critical');
    expect(rollupWindow([], { now, limitStatus: 'allowed_warning' }).runningLow).toBe('warning');
    expect(rollupWindow([], { now, limitStatus: 'allowed' }).runningLow).toBe('ok');
  });

  it('builds a project → task drill-down with the orchestrator kept separate', () => {
    const samples = [
      sample({ projectId: 'p1', taskId: 'a', inputTokens: 40_000, createdAt: now - MIN }),
      sample({ projectId: 'p1', taskId: 'b', inputTokens: 10_000, createdAt: now - MIN }),
      // Orchestrator (Align) spend for p1 — no taskId.
      sample({
        projectId: 'p1',
        taskId: null,
        source: 'orchestrator',
        inputTokens: 20_000,
        createdAt: now - MIN,
      }),
      sample({ projectId: 'p2', taskId: 'c', inputTokens: 30_000, createdAt: now - MIN }),
    ];
    const summary = rollupWindow(samples, {
      now,
      projectNames: new Map([
        ['p1', 'Alpha'],
        ['p2', 'Beta'],
      ]),
      taskTitles: new Map([['a', 'Task A']]),
    });

    expect(summary.taskTotal).toBe(80_000);
    expect(summary.orchestratorTotal).toBe(20_000);

    const alpha = summary.projects.find((p) => p.projectId === 'p1');
    expect(alpha).toMatchObject({
      label: 'Alpha',
      tokens: 70_000,
      taskTokens: 50_000,
      orchestratorTokens: 20_000,
    });
    // Tasks sorted desc; unknown title falls back to the id prefix.
    expect(alpha?.tasks).toEqual([
      { id: 'a', label: 'Task A', tokens: 40_000, pct: 40 },
      { id: 'b', label: 'b', tokens: 10_000, pct: 10 },
    ]);
    // Projects sorted by total desc (Alpha 70k before Beta 30k).
    expect(summary.projects.map((p) => p.projectId)).toEqual(['p1', 'p2']);
  });

  it('respects an explicit windowStart (e.g. all-time = 0)', () => {
    const realNow = 1_700_000_000_000; // a real epoch so a 10h-old sample stays positive
    const samples = [
      sample({ inputTokens: 100, createdAt: realNow - MIN }),
      sample({ inputTokens: 999, createdAt: realNow - 10 * 60 * MIN }), // ~10h ago
    ];
    // Default 5h window excludes the old one…
    expect(rollupWindow(samples, { now: realNow }).windowTotal).toBe(100);
    // …but windowStart: 0 (all-time) includes everything.
    expect(rollupWindow(samples, { now: realNow, windowStart: 0 }).windowTotal).toBe(1099);
  });

  it('handles an empty window without dividing by zero', () => {
    const summary = rollupWindow([], { now });
    expect(summary.windowTotal).toBe(0);
    expect(summary.byTask).toEqual([]);
    expect(summary.burn.perMinute).toBe(0);
  });
});

describe('burnRate', () => {
  const now = 10_000_000;

  it('measures tokens/min over the trailing window and reports the trend', () => {
    const samples = [
      // 6000 tokens in the last 60s → 6000 tokens/min.
      sample({ inputTokens: 6000, createdAt: now - 30_000 }),
      // 1000 tokens in the prior 60s window.
      sample({ inputTokens: 1000, createdAt: now - 90_000 }),
    ];
    const burn = burnRate(samples, now, 60);
    expect(burn.perMinute).toBe(6000);
    expect(burn.perSecond).toBe(100);
    expect(burn.trend).toBe('up');
  });

  it('is zero when nothing was spent recently', () => {
    const burn = burnRate([sample({ inputTokens: 500, createdAt: now - 10 * MIN })], now, 60);
    expect(burn.perMinute).toBe(0);
    expect(burn.trend).toBe('flat');
  });
});

describe('bucketSeries', () => {
  const now = 10 * MIN;

  it('buckets samples into fixed windows and zero-fills gaps up to now', () => {
    const since = now - 3 * MIN;
    const samples = [
      sample({ inputTokens: 100, createdAt: now - 3 * MIN + 5_000 }),
      sample({ inputTokens: 50, createdAt: now - 3 * MIN + 10_000 }),
      sample({ inputTokens: 200, createdAt: now - MIN + 1_000 }),
    ];
    const series = bucketSeries(samples, since, MIN, now);
    // Buckets from since..now inclusive at 1-min width → 4 buckets.
    expect(series).toHaveLength(4);
    expect(series[0].tokens).toBe(150); // first two samples share the earliest bucket
    expect(series[2].tokens).toBe(200);
    expect(series[3].tokens).toBe(0); // current (empty) bucket keeps the chart scrolling
  });
});

describe('usageQuota', () => {
  const now = 100 * HOUR;
  /** A `tokensIn` that records what window it was asked about and answers a fixed number. */
  function reader(tokens: number): { fn: TokensIn; calls: Array<[number, number]> } {
    const calls: Array<[number, number]> = [];
    return {
      fn: (from, to) => {
        calls.push([from, to]);
        return tokens;
      },
      calls,
    };
  }

  it('measures spend against the budget as a percent', () => {
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt: null,
      limit: 200,
      tokensIn: reader(50).fn,
    });
    expect(quota.tokens).toBe(50);
    expect(quota.pct).toBe(25);
    expect(quota.limit).toBe(200);
  });

  it('trails "now" when the CLI has never reported a reset', () => {
    const { fn, calls } = reader(0);
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt: null,
      limit: 100,
      tokensIn: fn,
    });
    expect(quota.windowStart).toBe(now - USAGE_WINDOW_MS);
    expect(quota.windowEnd).toBe(now);
    expect(quota.resetAt).toBeNull();
    expect(calls[0][0]).toBe(now - USAGE_WINDOW_MS);
  });

  it('anchors the window to a known reset, and never sums past now', () => {
    const resetAt = now + HOUR; // 4 hours in, 1 to go
    const { fn, calls } = reader(0);
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt,
      limit: 100,
      tokensIn: fn,
    });
    expect(quota.windowStart).toBe(resetAt - USAGE_WINDOW_MS);
    expect(quota.windowEnd).toBe(resetAt);
    expect(quota.resetAt).toBe(resetAt);
    // The window ends in the future; the SUM must stop at the present moment.
    expect(calls[0][1]).toBe(now + 1);
  });

  it('falls back to the trailing window when the reset has already passed', () => {
    // A stale signal from before the last rollover must not pin the window in the past.
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt: now - HOUR,
      limit: 100,
      tokensIn: reader(10).fn,
    });
    expect(quota.windowEnd).toBe(now);
    expect(quota.resetAt).toBeNull();
  });

  it('reports over-budget honestly rather than clamping at 100%', () => {
    const quota = usageQuota({
      id: 'weekly',
      now,
      windowMs: WEEKLY_WINDOW_MS,
      resetAt: null,
      limit: 100,
      tokensIn: reader(130).fn,
    });
    expect(quota.pct).toBe(130);
  });

  it('is 0% (not NaN) when no budget is set', () => {
    const quota = usageQuota({
      id: 'weekly',
      now,
      windowMs: WEEKLY_WINDOW_MS,
      resetAt: null,
      limit: 0,
      tokensIn: reader(500).fn,
    });
    expect(quota.pct).toBe(0);
    expect(quota.tokens).toBe(500);
  });

  it('reports the budget estimate as the pct source when no Claude reading is given', () => {
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt: null,
      limit: 200,
      tokensIn: reader(50).fn,
    });
    expect(quota.pctSource).toBe('budget');
  });

  it("prefers Claude's own reading over the budget estimate, but still reports the app's own spend", () => {
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt: null,
      limit: 200,
      tokensIn: reader(50).fn, // would be 25% by the budget estimate
      claudePct: 19,
    });
    expect(quota.pct).toBe(19);
    expect(quota.pctSource).toBe('claude');
    expect(quota.tokens).toBe(50);
    expect(quota.limit).toBe(200);
  });

  it('trusts a Claude reading of 0 rather than falling back to the budget estimate', () => {
    const quota = usageQuota({
      id: 'session',
      now,
      windowMs: USAGE_WINDOW_MS,
      resetAt: null,
      limit: 200,
      tokensIn: reader(50).fn,
      claudePct: 0,
    });
    expect(quota.pct).toBe(0);
    expect(quota.pctSource).toBe('claude');
  });
});

describe('rollupQuotas', () => {
  const now = 100 * HOUR;

  it('measures the two windows separately, each against its own budget', () => {
    const quotas = rollupQuotas({
      now,
      sessionLimit: 1000,
      weeklyLimit: 10_000,
      // Answer by window width, so each bar is provably reading its own range.
      tokensIn: (from, to) => (to - from > USAGE_WINDOW_MS + 1 ? 2500 : 400),
    });
    expect(quotas.session.pct).toBe(40);
    expect(quotas.weekly.pct).toBe(25);
    expect(quotas.session.windowStart).toBe(now - USAGE_WINDOW_MS);
    expect(quotas.weekly.windowStart).toBe(now - WEEKLY_WINDOW_MS);
  });

  it('anchors only the window the reported reset belongs to', () => {
    const resetAt = now + HOUR;
    const quotas = rollupQuotas({
      now,
      sessionLimit: 100,
      weeklyLimit: 100,
      sessionReset: resetAt,
      weeklyReset: null,
      tokensIn: () => 0,
    });
    expect(quotas.session.windowEnd).toBe(resetAt);
    expect(quotas.weekly.windowEnd).toBe(now);
  });

  it("passes Claude's own reading to each window independently", () => {
    const quotas = rollupQuotas({
      now,
      sessionLimit: 1000,
      weeklyLimit: 10_000,
      tokensIn: () => 400, // would read as a nonzero % from the budget estimate too
      claudeUsage: { sessionPct: 19, weeklyPct: 3 },
    });
    expect(quotas.session.pct).toBe(19);
    expect(quotas.session.pctSource).toBe('claude');
    expect(quotas.weekly.pct).toBe(3);
    expect(quotas.weekly.pctSource).toBe('claude');
  });

  it('falls back to the budget estimate for a window the CLI reading left null', () => {
    const quotas = rollupQuotas({
      now,
      sessionLimit: 1000,
      weeklyLimit: 10_000,
      tokensIn: (from, to) => (to - from > USAGE_WINDOW_MS + 1 ? 2500 : 400),
      claudeUsage: { sessionPct: 19, weeklyPct: null },
    });
    expect(quotas.session.pctSource).toBe('claude');
    expect(quotas.weekly.pctSource).toBe('budget');
    expect(quotas.weekly.pct).toBe(25);
  });
});
