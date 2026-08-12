/**
 * The live token-over-time area chart — styled after the Windows Task Manager
 * "Performance" tab: a filled area under a bright line, on a faint grid, that
 * scrolls as time advances. Hand-built SVG (no charting dependency).
 *
 * The chart stretches to its container width via a fixed `viewBox` with
 * `preserveAspectRatio="none"`; strokes use `vector-effect="non-scaling-stroke"`
 * so the line stays crisp and un-stretched at any width.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import type { UsageSeriesPoint } from '@tm/shared/usage';
import { formatTokens } from './usageFormat';

const VIEW_W = 1000;
const VIEW_H = 280;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  svg: { display: 'block', width: '100%', height: '280px' },
  peak: {
    position: 'absolute',
    top: '8px',
    left: '10px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
});

export interface TokenChartProps {
  points: UsageSeriesPoint[];
  /** Line/fill accent (a Fluent token). Defaults to the brand accent. */
  color?: string;
  /** Bucket width in ms, used to label the time span. */
  bucketMs?: number;
}

export function TokenChart({ points, color, bucketMs }: TokenChartProps): JSX.Element {
  const styles = useStyles();
  const stroke = color ?? tokens.colorBrandStroke1;
  const perUnit = bucketMs === 1000 ? 'tok/s' : 'tok/bucket';
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;

  const peak = points.reduce((m, p) => Math.max(m, p.tokens), 0);
  const scaleMax = Math.max(peak, 1);
  const n = points.length;

  // Map a point to SVG coordinates. With <2 points there's nothing to draw.
  const x = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * VIEW_W);
  const y = (v: number): number => PAD_TOP + plotH - (v / scaleMax) * plotH;

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.tokens).toFixed(1)}`)
    .join(' ');
  const area = n > 1 ? `${line} L ${VIEW_W} ${PAD_TOP + plotH} L 0 ${PAD_TOP + plotH} Z` : '';

  // Four horizontal grid lines, plus vertical grid every 1/6 of the span.
  const hLines = [0.25, 0.5, 0.75, 1].map((f) => PAD_TOP + plotH - f * plotH);
  const vLines = [1, 2, 3, 4, 5].map((k) => (k / 6) * VIEW_W);

  return (
    <div className={styles.root}>
      <span className={styles.peak}>
        peak {formatTokens(peak)} {perUnit}
      </span>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Tokens used over time"
      >
        <defs>
          <linearGradient id="tokenFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Grid */}
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
        {/* Area + line */}
        {area && <path d={area} fill="url(#tokenFill)" stroke="none" />}
        {n > 1 && (
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
  );
}
