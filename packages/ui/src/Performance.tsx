/**
 * Performance dashboard — a Windows-Task-Manager-style view of token spend.
 *
 * The app (not any AI agent) accounts for everything that consumes the account's
 * token quota: every task agent run and the orchestrator's own "Align plan" run.
 * This view shows, for a selectable range (5h / 24h / 7d / all-time):
 *   - a live per-second area chart + burn-rate speedometer (always "now"),
 *   - the range total + input/output/cache breakdown + cost,
 *   - the Tasks-vs-Orchestrator split, and
 *   - a project → task drill-down with each project's orchestrator (Align) spend
 *     kept on its own line,
 * plus a running-low indicator driven by Claude's own rate-limit signals.
 *
 * It follows the app's standard live-data idiom: seed via `invoke`, then stay live
 * off the `usage:sample` push plus a 1s tick (which also drives the reset countdown).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  makeStyles,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type {
  UsageProjectBreakdown,
  UsageSeriesPoint,
  UsageSlice,
  UsageSummary,
} from '@tm/shared/usage';
import { BurnRateGauge } from './BurnRateGauge';
import { PaneLoading } from './PaneLoading';
import { useTransport } from './transport';
import { useInitialLoad } from './useInitialLoad';
import { TokenChart } from './TokenChart';
import { formatCountdown } from './countdown';
import { UsageQuotaBars, useUsageQuotas } from './UsageQuotaBars';
import { SessionStatsSection, useSessionStats } from './SessionStatsSection';
import { formatCost, formatPct, formatTokens, niceCeil } from './usageFormat';

/**
 * The live chart is a per-second, short rolling window (Windows Task Manager style):
 * one-second buckets across the last few minutes, so it visibly scrolls every second.
 * The tiles and drill-down below summarize the selected range instead.
 */
const BUCKET_MS = 1000;
const CHART_WINDOW_MS = 120_000; // last 2 minutes, at 1-second resolution

/** Selectable ranges for the totals/breakdown. `ms: 0` means all-time. */
type RangeId = '5h' | '24h' | '7d' | 'all';
const RANGES: Array<{ id: RangeId; label: string; ms: number }> = [
  { id: '5h', label: '5h', ms: 5 * 60 * 60 * 1000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', ms: 0 },
];

/** Palette used to color the per-task/source share bars, cycled by index. */
const BAR_COLORS = [
  tokens.colorPaletteBlueForeground2,
  tokens.colorPaletteBerryForeground2,
  tokens.colorPaletteTealForeground2,
  tokens.colorPaletteLavenderForeground2,
  tokens.colorPalettePinkForeground2,
  tokens.colorPaletteSeafoamForeground2,
];
/** The orchestrator's own spend always uses this color so it's easy to spot. */
const ORCH_COLOR = tokens.colorPaletteMarigoldForeground2;

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '4px',
  },
  header: { display: 'flex', alignItems: 'center', gap: '10px' },
  reset: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  selector: { display: 'flex', gap: '4px', marginLeft: 'auto' },
  main: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 3fr)',
    gap: '16px',
    alignItems: 'start',
    // The rail's own 220px minimum already overflows a phone: at 360px it leaves the
    // panel beside it ~130px. Stack instead of squeezing a column that can't shrink.
    '@media (max-width: 599px)': {
      gridTemplateColumns: '1fr',
    },
  },
  rail: { display: 'flex', flexDirection: 'column', gap: '8px' },
  panel: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  topRow: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' },
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: '10px',
    flex: 1,
  },
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
  tileLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
  section: { display: 'flex', flexDirection: 'column', gap: '6px' },
  sectionTitle: { fontSize: '12px', fontWeight: 600, color: tokens.colorNeutralForeground2 },
  rowList: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', alignItems: 'center' },
  rowLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '13px',
  },
  rowNums: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  bar: {
    gridColumn: '1 / -1',
    height: '4px',
    borderRadius: '2px',
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: '2px' },
  empty: { color: tokens.colorNeutralForeground3, padding: '24px 0', textAlign: 'center' },
  // Drill-down tree
  project: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  projectHead: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    gap: '4px 8px',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
    color: 'inherit',
    width: '100%',
  },
  chevron: { display: 'flex', alignItems: 'center', color: tokens.colorNeutralForeground3 },
  projectName: {
    fontSize: '13px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  children: { display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '22px' },
  childEmpty: { fontSize: '12px', color: tokens.colorNeutralForeground3, paddingLeft: '22px' },
});

/** A labelled share row with a colored progress bar (used by the rail and tree). */
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
        <div
          className={styles.barFill}
          style={{ width: `${Math.min(100, slice.pct)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/** One project in the drill-down: header (total + share) that expands to its tasks + orchestrator. */
function ProjectBlock({
  project,
  color,
  expanded,
  onToggle,
}: {
  project: UsageProjectBreakdown;
  color: string;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const styles = useStyles();
  const hasChildren = project.tasks.length > 0 || project.orchestratorTokens > 0;
  return (
    <div className={styles.project}>
      <button className={styles.projectHead} onClick={onToggle} aria-expanded={expanded}>
        <span className={styles.chevron}>
          {hasChildren ? (
            expanded ? (
              <ChevronDownRegular />
            ) : (
              <ChevronRightRegular />
            )
          ) : (
            <span style={{ width: 16 }} />
          )}
        </span>
        <span className={styles.projectName} title={project.label}>
          {project.label}
        </span>
        <span className={styles.rowNums}>
          {formatTokens(project.tokens)} · {formatPct(project.pct)}
        </span>
        <div className={styles.bar}>
          <div
            className={styles.barFill}
            style={{ width: `${Math.min(100, project.pct)}%`, backgroundColor: color }}
          />
        </div>
      </button>
      {expanded &&
        (hasChildren ? (
          <div className={styles.children}>
            {project.tasks.map((t, i) => (
              <ShareRow key={t.id} slice={t} color={BAR_COLORS[i % BAR_COLORS.length]} />
            ))}
            {project.orchestratorTokens > 0 && (
              <ShareRow
                slice={{
                  id: `${project.projectId ?? 'none'}-orch`,
                  label: 'Orchestrator (Align)',
                  tokens: project.orchestratorTokens,
                  pct: project.tokens > 0 ? (project.orchestratorTokens / project.tokens) * 100 : 0,
                }}
                color={ORCH_COLOR}
              />
            )}
          </div>
        ) : (
          <span className={styles.childEmpty}>No per-task detail.</span>
        ))}
    </div>
  );
}

export function Performance(): JSX.Element {
  const styles = useStyles();
  const [range, setRange] = useState<RangeId>('5h');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [series, setSeries] = useState<UsageSeriesPoint[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const transport = useTransport();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The two metered windows. Their own live reading, on their own cadence: they are
  // fixed windows and deliberately ignore the range selector below them.
  const quotas = useUsageQuotas();
  const sessionStats = useSessionStats();
  // Sticky peak burn so the gauge's full-scale doesn't jump around second to second.
  const peakBurn = useRef(0);
  const [gaugeMax, setGaugeMax] = useState(50);

  const refresh = useCallback(async () => {
    const at = Date.now();
    const rangeMs = RANGES.find((r) => r.id === range)?.ms ?? 0;
    const sinceMs = rangeMs > 0 ? at - rangeMs : 0; // 0 = all-time
    const [s, pts] = await Promise.all([
      transport.invoke('usage:summary', sinceMs),
      transport.invoke('usage:series', at - CHART_WINDOW_MS, BUCKET_MS),
    ]);
    setSummary(s);
    setSeries(pts);
    // Gauge scale tracks the per-second peak (sticky) so the needle stays comparable.
    peakBurn.current = Math.max(peakBurn.current, s.burn.perSecond);
    setGaugeMax(niceCeil(Math.max(peakBurn.current * 1.15, 50)));
  }, [range, transport]);

  const initial = useInitialLoad(refresh);

  useEffect(() => {
    // Follow-up refreshes only — `useInitialLoad` owns the seed so its failure is
    // reported. These swallow errors: once a second, a backend that is down would
    // otherwise raise an unhandled rejection per tick, and the seed already said so.
    const again = (): void => void refresh().catch(() => undefined);
    // A new sample landed — refresh right away so the chart/gauge feel live.
    // Desktop only: a browser's `PolledEventBus` does not reproduce `usage:sample` (see
    // its `UNREPRODUCIBLE_EVENTS`), so there the one-second tick below drives the redraw
    // and the per-second gauge is as live as the poll allows rather than as live as the CLI.
    const off = transport.on('usage:sample', again);
    // A steady tick keeps the burn rate, the scrolling chart, and the reset
    // countdown current even while nothing is running.
    const id = setInterval(() => {
      setNow(Date.now());
      again();
    }, 1000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [refresh, transport]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!summary) {
    return <PaneLoading label="Loading usage…" error={initial.error} onRetry={initial.retry} />;
  }

  const resetMs = summary.windowReset != null ? summary.windowReset - now : null;
  const b = summary.breakdown;
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? '';

  return (
    <div className={styles.root}>
      {summary.runningLow !== 'ok' && (
        <MessageBar intent={summary.runningLow === 'critical' ? 'error' : 'warning'}>
          <MessageBarBody>
            <MessageBarTitle>
              {summary.runningLow === 'critical'
                ? 'Usage limit reached'
                : 'Approaching the usage limit'}
            </MessageBarTitle>{' '}
            {summary.limitStatus ? `Claude reported "${summary.limitStatus}".` : ''}{' '}
            {resetMs != null && resetMs > 0 && `Window resets in ${formatCountdown(resetMs)}.`}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.header}>
        <Text size={500} weight="semibold">
          Token usage
        </Text>
        {range === '5h' && resetMs != null && resetMs > 0 && (
          <span className={styles.reset}>· window resets in {formatCountdown(resetMs)}</span>
        )}
        <div className={styles.selector}>
          {RANGES.map((r) => (
            <Button
              key={r.id}
              size="small"
              appearance={range === r.id ? 'primary' : 'subtle'}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {/* How much of each metered window is gone. Above everything else because it is the
          one question the screen answers that has a ceiling — the totals below say what
          was spent, these two say how much of the allowance that was. They do NOT follow
          the range selector: a session is 5 hours and a week is 7 days regardless. */}
      {quotas && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>Usage against budget</span>
          <UsageQuotaBars quotas={quotas} />
        </div>
      )}

      <div className={styles.main}>
        {/* Left rail: the Tasks-vs-Orchestrator split (orchestrator called out on its own). */}
        <div className={styles.rail}>
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Tasks vs orchestrator</span>
            <div className={styles.rowList}>
              {summary.bySource.length === 0 ? (
                <span className={styles.rowNums}>No usage yet</span>
              ) : (
                summary.bySource.map((s) => (
                  <ShareRow
                    key={s.id}
                    slice={s}
                    color={s.id === 'orchestrator' ? ORCH_COLOR : BAR_COLORS[0]}
                  />
                ))
              )}
            </div>
          </div>
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Totals ({rangeLabel})</span>
            <div className={styles.rowList}>
              <ShareRow
                slice={{
                  id: 'tasks',
                  label: 'Task agents',
                  tokens: summary.taskTotal,
                  pct:
                    summary.windowTotal > 0 ? (summary.taskTotal / summary.windowTotal) * 100 : 0,
                }}
                color={BAR_COLORS[0]}
              />
              <ShareRow
                slice={{
                  id: 'orch',
                  label: 'Orchestrator',
                  tokens: summary.orchestratorTotal,
                  pct:
                    summary.windowTotal > 0
                      ? (summary.orchestratorTotal / summary.windowTotal) * 100
                      : 0,
                }}
                color={ORCH_COLOR}
              />
            </div>
          </div>
        </div>

        {/* Main panel: gauge + tiles, then the live chart, then the project drill-down. */}
        <div className={styles.panel}>
          <div className={styles.topRow}>
            <BurnRateGauge burn={summary.burn} max={gaugeMax} />
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatTokens(summary.windowTotal)}</span>
                <span className={styles.tileLabel}>Tokens ({rangeLabel})</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileValue}>{formatCost(summary.costUsd)}</span>
                <span className={styles.tileLabel}>Cost ({rangeLabel})</span>
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

          <div className={styles.section}>
            <span className={styles.sectionTitle}>Live · last 2 min · tokens/sec</span>
            <TokenChart points={series} bucketMs={BUCKET_MS} />
          </div>

          {sessionStats && (
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Session statistics</span>
              <SessionStatsSection stats={sessionStats} />
            </div>
          )}

          <div className={styles.section}>
            <span className={styles.sectionTitle}>By project → task ({rangeLabel})</span>
            {summary.projects.length === 0 ? (
              <div className={styles.empty}>No usage recorded in this range yet.</div>
            ) : (
              summary.projects.map((p, i) => {
                const key = p.projectId ?? 'none';
                return (
                  <ProjectBlock
                    key={key}
                    project={p}
                    color={BAR_COLORS[i % BAR_COLORS.length]}
                    expanded={!collapsed.has(key)}
                    onToggle={() => toggle(key)}
                  />
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
