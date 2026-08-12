/**
 * Small formatting helpers for the Performance dashboard — compact token counts and
 * rates (e.g. "12.3k", "1.24M", "8.1k/min"). Pure and dependency-free so they can be
 * shared by the chart, gauge, and tables.
 */

/** Compact token count: 942 → "942", 12345 → "12.3k", 3400000 → "3.40M". */
export function formatTokens(n: number): string {
  const v = Math.round(n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

/** Tokens/min, compacted: "8.1k/min". */
export function formatRate(perMinute: number): string {
  return `${formatTokens(perMinute)}/min`;
}

/** Percent with one decimal below 10, none above: 3.2% / 45%. */
export function formatPct(pct: number): string {
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/** USD cost: "$0.0159" for small amounts, "$12.34" otherwise. */
export function formatCost(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Round up to a "nice" ceiling (1/2/5 × 10ⁿ) — for a stable gauge/axis maximum. */
export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const frac = n / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}
