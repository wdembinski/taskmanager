/**
 * The burn-rate "speedometer": a semicircular gauge whose needle points at the
 * current tokens-per-minute spend, with green→amber→red zones so you can see at a
 * glance whether you're burning tokens fast. Hand-built SVG.
 *
 * The gauge `max` is supplied by the caller and kept sticky (never shrinks within a
 * session) so the needle position stays comparable over time.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowUpRegular, ArrowDownRegular, ArrowRightRegular } from '@fluentui/react-icons';
import type { BurnRate } from '@shared/usage';
import { formatTokens } from './usageFormat';

const CX = 100;
const CY = 100;
const R = 82;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
  svg: { width: '200px', maxWidth: '100%', height: 'auto' },
  value: {
    fontSize: '26px',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  unit: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
});

/** Point on the gauge arc for a fraction f (0 = left, 1 = right, over the top). */
function polar(r: number, f: number): [number, number] {
  const a = Math.PI * (1 - Math.min(Math.max(f, 0), 1));
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

/** SVG arc path between two fractions along the top semicircle. */
function arc(r: number, f1: number, f2: number): string {
  const [x1, y1] = polar(r, f1);
  const [x2, y2] = polar(r, f2);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export interface BurnRateGaugeProps {
  burn: BurnRate;
  /** Full-scale value (tokens/sec) the right end of the gauge represents. */
  max: number;
}

export function BurnRateGauge({ burn, max }: BurnRateGaugeProps): JSX.Element {
  const styles = useStyles();
  const f = max > 0 ? burn.perSecond / max : 0;
  const [nx, ny] = polar(R * 0.82, f);
  const TrendIcon =
    burn.trend === 'up' ? ArrowUpRegular : burn.trend === 'down' ? ArrowDownRegular : ArrowRightRegular;

  return (
    <div className={styles.root}>
      <svg className={styles.svg} viewBox="0 0 200 116" role="img" aria-label="Token burn rate">
        {/* Zones: green (calm) → amber → red (burning fast) */}
        <path d={arc(R, 0, 0.6)} stroke={tokens.colorPaletteGreenBackground3} strokeWidth={13} fill="none" strokeLinecap="round" />
        <path d={arc(R, 0.6, 0.85)} stroke={tokens.colorPaletteYellowBackground3} strokeWidth={13} fill="none" />
        <path d={arc(R, 0.85, 1)} stroke={tokens.colorPaletteRedBackground3} strokeWidth={13} fill="none" strokeLinecap="round" />
        {/* Needle */}
        <line
          x1={CX}
          y1={CY}
          x2={nx}
          y2={ny}
          stroke={tokens.colorNeutralForeground1}
          strokeWidth={3}
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r={5} fill={tokens.colorNeutralForeground1} />
      </svg>
      <div className={styles.value}>
        <TrendIcon />
        {formatTokens(burn.perSecond)}
      </div>
      <span className={styles.unit}>tokens / sec</span>
    </div>
  );
}
