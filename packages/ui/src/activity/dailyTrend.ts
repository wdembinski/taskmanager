/**
 * The daily trend chart's pure series helpers — picking a metric out of a
 * `DailyUsagePoint[]`, its peak, its display formatting, and the SVG path(s) to
 * draw it. No React, no DOM, so it is testable without a browser.
 *
 * `trendValues` returns `(number | null)[]` for every metric, even though only
 * `'cost'` can actually carry a `null` (an unpriced day) — tokens are always
 * numbers (see `DailyUsagePoint`). `trendPath` treats a `null` as a gap: the
 * line breaks there and resumes with a fresh `M` at the next known point,
 * same idea as `TokenChart`'s single unbroken line but tolerant of holes.
 */
import type { DailyUsagePoint } from '@tm/shared/usage';
import { formatCost, formatTokens } from '../usageFormat';

/** Which field of a `DailyUsagePoint` the trend chart is plotting. */
export type TrendMetric = 'cost' | 'input' | 'output';

export interface TrendMetricDef {
  id: TrendMetric;
  label: string;
}

/** The metric picker's options, in display order. */
export const TREND_METRICS: readonly TrendMetricDef[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'input', label: 'Input' },
  { id: 'output', label: 'Output' },
];

/** The trend chart's default backfill window, in days. */
export const TREND_DAYS = 30;

/**
 * The viewer's own UTC offset, in minutes EAST of UTC — the sign `bucketUsageDaily`
 * expects, which is the OPPOSITE of `Date#getTimezoneOffset()`. The viewer's clock,
 * not the desktop host's, decides what day a point falls on.
 */
export function viewerTzOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

/** Pulls one metric's value out of each point, oldest first. */
export function trendValues(
  points: readonly DailyUsagePoint[],
  metric: TrendMetric,
): (number | null)[] {
  return points.map((p) => {
    switch (metric) {
      case 'cost':
        return p.costUsd;
      case 'input':
        return p.inputTokens;
      case 'output':
        return p.outputTokens;
    }
  });
}

/** Max over the non-null values, or `0` when there are none. */
export function trendPeak(values: readonly (number | null)[]): number {
  let max = 0;
  for (const v of values) {
    if (v !== null && v > max) max = v;
  }
  return max;
}

/** `'—'` for an unpriced/unknown day — never `$0.00`, which would read as a real zero. */
export function formatTrendValue(metric: TrendMetric, v: number | null): string {
  if (v === null) return '—';
  return metric === 'cost' ? formatCost(v) : formatTokens(v);
}

export interface TrendPaths {
  line: string;
  area: string;
}

/**
 * Builds the line/area SVG path strings for `values` across a `w` × `h` viewport
 * with `padTop`/`padBottom` vertical padding (mirrors `TokenChart`'s own layout).
 * A `null` value breaks the run of points into separate segments; each segment
 * starts its own `M`. Fewer than 2 values overall yields `{ line: '', area: '' }`.
 */
export function trendPath(
  values: readonly (number | null)[],
  w: number,
  h: number,
  padTop: number,
  padBottom: number,
): TrendPaths {
  const n = values.length;
  if (n < 2) return { line: '', area: '' };

  const plotH = h - padTop - padBottom;
  const scaleMax = Math.max(trendPeak(values), 1);
  const baseline = padTop + plotH;
  const x = (i: number): number => (i / (n - 1)) * w;
  const y = (v: number): number => padTop + plotH - (v / scaleMax) * plotH;

  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ x: x(i), y: y(v) });
  }
  if (current.length > 0) segments.push(current);

  const toLine = (seg: { x: number; y: number }[]): string =>
    seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  const line = segments.map(toLine).join(' ');

  const area = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const first = seg[0];
      const last = seg[seg.length - 1];
      return `${toLine(seg)} L ${last.x.toFixed(1)} ${baseline.toFixed(1)} L ${first.x.toFixed(1)} ${baseline.toFixed(1)} Z`;
    })
    .join(' ');

  return { line, area };
}
