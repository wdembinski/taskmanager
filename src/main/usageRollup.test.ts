/**
 * Unit tests for the pure token-usage aggregation. No database, no Electron —
 * just samples in, summary/series out, so the app's accounting is pinned down.
 */
import { describe, expect, it } from 'vitest';
import type { UsageSample } from '@shared/usage';
import { bucketSeries, burnRate, rollupWindow } from './usageRollup';

const MIN = 60_000;

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
      sample({ taskId: null, source: 'orchestrator', projectId: 'p1', inputTokens: 20_000, createdAt: now - 3 * MIN }),
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
      sample({ inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40, createdAt: now - MIN }),
      sample({ inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, createdAt: now - MIN }),
    ];
    const summary = rollupWindow(samples, { now });
    expect(summary.breakdown).toEqual({ input: 11, output: 22, cacheCreation: 33, cacheRead: 44 });
  });

  it('flags running-low from limit signals', () => {
    expect(rollupWindow([], { now, limitActive: true }).runningLow).toBe('critical');
    expect(rollupWindow([], { now, limitStatus: 'allowed_warning' }).runningLow).toBe('warning');
    expect(rollupWindow([], { now, limitStatus: 'allowed' }).runningLow).toBe('ok');
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
