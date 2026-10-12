/**
 * Daily trend chart — a rail-sized line/area chart of cost or token volume per day,
 * over the last `days` days. Same hand-built-SVG idiom as `TokenChart`/`SessionLimitChart`
 * (fixed viewBox, `preserveAspectRatio="none"`, non-scaling strokes) but shorter, since it
 * lives in a rail rather than owning the whole Performance panel.
 *
 * Daily granularity has nothing to push live — there is no `usage:sample` for a day
 * bucket, and the web transport does not reproduce that event anyway (see `Performance`'s
 * own note on `UNREPRODUCIBLE_EVENTS`) — so this polls `usage:daily` every 60s instead of
 * following a push.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import type { DailyUsagePoint } from '@tm/shared/usage';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import {
  formatTrendValue,
  trendPath,
  trendPeak,
  trendValues,
  TREND_DAYS,
  TREND_METRICS,
  viewerTzOffsetMinutes,
  type TrendMetric,
} from './dailyTrend';

/** How often the chart re-polls once it has its first page. */
const REFRESH_MS = 60_000;

const VIEW_W = 1000;
const VIEW_H = 160;
const PAD_TOP = 8;
const PAD_BOTTOM = 6;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px' },
  header: { display: 'flex', alignItems: 'center', gap: '10px' },
  title: { fontSize: '12px', fontWeight: 600, color: tokens.colorNeutralForeground2 },
  selector: { display: 'flex', gap: '4px', marginLeft: 'auto' },
  chartWrap: {
    position: 'relative',
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  svg: { display: 'block', width: '100%', height: '160px' },
  peak: {
    position: 'absolute',
    top: '6px',
    left: '8px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  captions: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
});

export interface DailyTrendChartProps {
  /** Backfill window, in days. Defaults to `TREND_DAYS`. */
  days?: number;
}

export function DailyTrendChart({ days = TREND_DAYS }: DailyTrendChartProps): JSX.Element {
  const styles = useStyles();
  // TokenChart's hard-coded gradient id would collide if this chart and TokenChart ever
  // render on the same page (e.g. the rail next to Performance) — scope it per instance.
  const gradientId = useId();
  const transport = useTransport();
  const [metric, setMetric] = useState<TrendMetric>('cost');
  const [points, setPoints] = useState<DailyUsagePoint[] | null>(null);

  const refresh = useCallback(async () => {
    const pts = await transport.invoke('usage:daily', {
      days,
      tzOffsetMinutes: viewerTzOffsetMinutes(),
    });
    setPoints(pts);
  }, [days, transport]);

  const initial = useInitialLoad(refresh);

  useEffect(() => {
    // Follow-up polls only — `useInitialLoad` owns the seed so its failure is reported.
    // This swallows errors: a backend that is briefly down would otherwise raise an
    // unhandled rejection every minute, and the seed already said so.
    const id = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (!points) {
    return <PaneLoading label="Loading trend…" error={initial.error} onRetry={initial.retry} />;
  }

  const values = trendValues(points, metric);
  const peak = trendPeak(values);
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const { line, area } = trendPath(values, VIEW_W, VIEW_H, PAD_TOP, PAD_BOTTOM);
  const stroke = tokens.colorBrandStroke1;

  const hLines = [0.25, 0.5, 0.75, 1].map((f) => PAD_TOP + plotH - f * plotH);
  const vLines = [1, 2, 3, 4, 5].map((k) => (k / 6) * VIEW_W);

  const first = points[0];
  const last = points[points.length - 1];
  const metricLabel = (TREND_METRICS.find((m) => m.id === metric)?.label ?? metric).toLowerCase();

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>Daily trend · last {days} days</span>
        <div className={styles.selector}>
          {TREND_METRICS.map((m) => (
            <Button
              key={m.id}
              size="small"
              appearance={metric === m.id ? 'primary' : 'subtle'}
              onClick={() => setMetric(m.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </div>

      <div className={styles.chartWrap}>
        <span className={styles.peak}>peak {formatTrendValue(metric, peak)} / day</span>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Daily ${metricLabel} trend over the last ${days} days`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {hLines.map((yy, i) => (
            <line
              key={`h${i}`}
              x1={0}
              y1={yy}
              x2={VIEW_W}
              y2={yy}
              stroke={tokens.colorNeutralStroke2}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {vLines.map((xx, i) => (
            <line
              key={`v${i}`}
              x1={xx}
              y1={PAD_TOP}
              x2={xx}
              y2={PAD_TOP + plotH}
              stroke={tokens.colorNeutralStroke2}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {area && <path d={area} fill={`url(#${gradientId})`} stroke="none" />}
          {line && (
            <path
              d={line}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>

      {first && last && (
        <div className={styles.captions}>
          <span>{first.date}</span>
          <span>{last.date}</span>
        </div>
      )}
    </div>
  );
}
