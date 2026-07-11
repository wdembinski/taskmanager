/**
 * Performance dashboard — a Windows-Task-Manager-style view of token spend.
 *
 * The app (not any AI agent) accounts for everything that consumes the account's
 * token quota: every task agent run and the orchestrator's own "Align plan" run.
 * This view shows, for the rolling 5-hour usage window:
 *   - a live filled area chart of tokens used over time (Task Manager aesthetic),
 *   - a burn-rate speedometer (tokens/min, right now) with a trend arrow,
 *   - the window total + input/output/cache breakdown + cost,
 *   - per-project and per-task tables with each one's share of the window, and
 *   - a running-low indicator driven by Claude's own rate-limit signals.
 *
 * It follows the app's standard live-data idiom: seed via `invoke`, then stay live
 * off the `usage:sample` push plus a 1s tick (which also drives the reset countdown).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  makeStyles,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { UsageSeriesPoint, UsageSlice, UsageSummary } from '@shared/usage';
import { USAGE_WINDOW_MS } from '@shared/usage';
import { BurnRateGauge } from './BurnRateGauge';
import { TokenChart } from './TokenChart';
import { formatCountdown } from './LimitBanner';
import { formatCost, formatPct, formatTokens, niceCeil } from './usageFormat';

/** One-minute buckets across the 5-hour window (300 points) for the chart. */
const BUCKET_MS = 60_000;

/** Palette used to color the per-project/source share bars, cycled by index. */
const BAR_COLORS = [
  tokens.colorPaletteBlueForeground2,
  tokens.colorPaletteBerryForeground2,
  tokens.colorPaletteTealForeground2,
  tokens.colorPaletteMarigoldForeground2,
  tokens.colorPaletteLavenderForeground2,
  tokens.colorPalettePinkForeground2,
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, overflowY: 'auto', paddingRight: '4px' },
  header: { display: 'flex', alignItems: 'baseline', gap: '12px' },
  reset: { marginLeft: 'auto', color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  main: { display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 3fr)', gap: '16px', alignItems: 'start' },
  rail: { display: 'flex', flexDirection: 'column', gap: '8px' },
  railItem: { display: 'flex', flexDirection: 'column', gap: '4px' },
  panel: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  topRow: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px', flex: 1 },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '10px 12px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  tileValue: { fontSize: '20px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  tileLabel: { fontSize: '11px', color: tokens.colorNeutralForeground3, textTransform: 'uppercase', letterSpacing: '0.03em' },
  section: { display: 'flex', flexDirection: 'column', gap: '6px' },
  sectionTitle: { fontSize: '12px', fontWeight: 600, color: tokens.colorNeutralForeground2 },
  rowList: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', alignItems: 'center' },
  rowLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' },
  rowNums: { fontVariantNumeric: 'tabular-nums', fontSize: '12px', color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' },
  bar: { gridColumn: '1 / -1', height: '4px', borderRadius: '2px', backgroundColor: tokens.colorNeutralBackground4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: '2px' },
  empty: { color: tokens.colorNeutralForeground3, padding: '24px 0', textAlign: 'center' },
});

/** A labelled share row with a colored progress bar (used by the rail and tables). */
function ShareRow({ slice, color }: { slice: UsageSlice; color: string }): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel} title={slice.label}>
        {slice.label}
      </span>
      <span className={styles.rowNums}>
        {formatTokens(slice.tokens)} · {formatPct(slice.pct)}
      </span>
      <div className={styles.bar}>
        <div className={styles.barFill} style={{ width: `${Math.min(100, slice.pct)}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

export function Performance(): JSX.Element {
  const styles = useStyles();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [series, setSeries] = useState<UsageSeriesPoint[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // Sticky peak burn so the gauge's full-scale doesn't jump around second to second.
  const peakBurn = useRef(0);
  const [gaugeMax, setGaugeMax] = useState(1000);

  const refresh = useCallback(async () => {
    const at = Date.now();
    const [s, pts] = await Promise.all([
      window.api.invoke('usage:summary'),
      window.api.invoke('usage:series', at - USAGE_WINDOW_MS, BUCKET_MS),
    ]);
    setSummary(s);
    setSeries(pts);
    peakBurn.current = Math.max(peakBurn.current, s.burn.perMinute);
    setGaugeMax(niceCeil(Math.max(peakBurn.current * 1.15, 1000)));
  }, []);

  useEffect(() => {
    void refresh();
    // A new sample landed — refresh right away so the chart/gauge feel live.
    const off = window.api.on('usage:sample', () => void refresh());
    // A steady tick keeps the burn rate, the scrolling chart, and the reset
    // countdown current even while nothing is running.
    const id = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 1000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [refresh]);

  if (!summary) {
    return <Spinner label="Loading usage…" labelPosition="after" size="tiny" />;
  }

  const resetMs = summary.windowReset != null ? summary.windowReset - now : null;
  const b = summary.breakdown;

  return (
    <div className={styles.root}>
      {summary.runningLow !== 'ok' && (
        <MessageBar intent={summary.runningLow === 'critical' ? 'error' : 'warning'}>
          <MessageBarBody>
            <MessageBarTitle>
              {summary.runningLow === 'critical' ? 'Usage limit reached' : 'Approaching the usage limit'}
            </MessageBarTitle>{' '}
            {summary.limitStatus ? `Claude reported "${summary.limitStatus}".` : ''}{' '}
            {resetMs != null && resetMs > 0 && `Window resets in ${formatCountdown(resetMs)}.`}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.header}>
        <Text size={500} weight="semibold">
          Token usage — last 5 hours
        </Text>
        {resetMs != null && resetMs > 0 && (
          <span className={styles.reset}>window resets in {formatCountdown(resetMs)}</span>
        )}
      </div>

      <div className={styles.main}>
        {/* Left rail: share of the window by source, then by project. */}
        <div className={styles.rail}>
          <div className={styles.section}>
            <span className={styles.sectionTitle}>By source</span>
            <div className={styles.rowList}>
              {summary.bySource.length === 0 ? (
                <span className={styles.rowNums}>No usage yet</span>
              ) : (
                summary.bySource.map((s, i) => <ShareRow key={s.id} slice={s} color={BAR_COLORS[i % BAR_COLORS.length]} />)
              )}
            </div>
          </div>
          <div className={styles.section}>
            <span className={styles.sectionTitle}>By project</span>
            <div className={styles.rowList}>
              {summary.byProject.length === 0 ? (
                <span className={styles.rowNums}>No usage yet</span>
              ) : (
                summary.byProject.map((s, i) => <ShareRow key={s.id} slice={s} color={BAR_COLORS[i % BAR_COLORS.length]} />)
              )}
            </div>
          </div>
        </div>

        {/* Main panel: gauge + tiles, then the live chart, then the per-task table. */}
        <div className={styles.panel}>
          <div className={styles.topRow}>
            <BurnRateGauge burn={summary.burn} max={gaugeMax} />
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatTokens(summary.windowTotal)}</span>
                <span className={styles.tileLabel}>Tokens (5h)</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatCost(summary.costUsd)}</span>
                <span className={styles.tileLabel}>Cost (5h)</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatTokens(b.input)}</span>
                <span className={styles.tileLabel}>Input</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatTokens(b.output)}</span>
                <span className={styles.tileLabel}>Output</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatTokens(b.cacheRead)}</span>
                <span className={styles.tileLabel}>Cache read</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatTokens(b.cacheCreation)}</span>
                <span className={styles.tileLabel}>Cache write</span>
              </div>
            </div>
          </div>

          <TokenChart points={series} bucketMs={BUCKET_MS} />

          <div className={styles.section}>
            <span className={styles.sectionTitle}>By task</span>
            <div className={styles.rowList}>
              {summary.byTask.length === 0 ? (
                <div className={styles.empty}>No task usage recorded in this window yet.</div>
              ) : (
                summary.byTask.map((s, i) => <ShareRow key={s.id} slice={s} color={BAR_COLORS[i % BAR_COLORS.length]} />)
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
