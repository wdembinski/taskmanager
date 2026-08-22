/**
 * "How long does a 5-hour session take to burn through its budget?" — one bar per past
 * rolling-5-hour session (x axis), bar height = the time it took to exhaust that
 * session's token budget (y axis). `Performance` renders two of these side by side, one
 * reading {@link SessionStat.processingMs} and one {@link SessionStat.wallClockMs} — the
 * gap between the two bars for the same session IS the time not spent with Claude.
 *
 * Hand-built SVG, same idiom as `TokenChart`: fixed viewBox, `preserveAspectRatio="none"`
 * so bars stretch to the container's width. Sessions that never exhausted their budget
 * (the account's current, still-open session; or a quiet 5 hours) have nothing to plot
 * and are left out — a 0-height bar would read as "instant", the opposite of the truth.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import type { SessionStat } from '@tm/shared/usage';
import { formatDuration } from './usageFormat';

const VIEW_W = 1000;
const VIEW_H = 220;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;
/** Fraction of each bar's slot left empty as a gap to its neighbors. */
const GAP_FRAC = 0.3;
/** Only the most recent N exhausted sessions are drawn, so the bars stay legible. */
const MAX_BARS = 40;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  svg: { display: 'block', width: '100%', height: '220px' },
  caption: {
    position: 'absolute',
    top: '8px',
    left: '10px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  empty: {
    height: '220px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: '13px',
    textAlign: 'center',
    padding: '0 24px',
  },
});

export interface SessionLimitChartProps {
  stats: SessionStat[];
  /** Which of a session's two durations this instance draws. */
  metric: 'processingMs' | 'wallClockMs';
  /** Bar fill (a Fluent token). Defaults to the brand accent. */
  color?: string;
  /** Shown in place of the chart when no session has exhausted its budget yet. */
  emptyLabel: string;
}

export function SessionLimitChart({
  stats,
  metric,
  color,
  emptyLabel,
}: SessionLimitChartProps): JSX.Element {
  const styles = useStyles();
  const fill = color ?? tokens.colorBrandStroke1;
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;

  // Only sessions that actually exhausted their budget have a real time-to-exhaust to
  // plot. Pulled out into plain {index, value} pairs up front so the rest of the
  // component reads one metric, not a union of two possibly-null fields.
  const points: Array<{ index: number; value: number }> = [];
  for (const s of stats) {
    const value = s[metric];
    if (s.exhausted && value != null) points.push({ index: s.index, value });
  }
  const shown = points.slice(-MAX_BARS);

  if (shown.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>{emptyLabel}</div>
      </div>
    );
  }

  const peak = shown.reduce((m, p) => Math.max(m, p.value), 0);
  const scaleMax = Math.max(peak, 1);
  const n = shown.length;
  const slotW = VIEW_W / n;
  const barW = slotW * (1 - GAP_FRAC);

  const hLines = [0.25, 0.5, 0.75, 1].map((f) => PAD_TOP + plotH - f * plotH);

  return (
    <div className={styles.root}>
      <span className={styles.caption}>
        {shown.length < points.length ? `last ${shown.length} sessions · ` : ''}
        peak {formatDuration(peak)}
      </span>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Time to exhaust the session budget, one bar per past session"
      >
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
        {shown.map((p, i) => {
          const barH = Math.max((p.value / scaleMax) * plotH, 1);
          const x = i * slotW + (slotW - barW) / 2;
          const y = PAD_TOP + plotH - barH;
          return (
            <rect key={p.index} x={x} y={y} width={barW} height={barH} fill={fill} rx={2}>
              <title>{`Session ${p.index + 1}: ${formatDuration(p.value)}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
