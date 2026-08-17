/**
 * "Session statistics" — the Performance screen's answer to "how quickly do I actually
 * burn through a 5-hour session?", as two bar charts over the account's past sessions:
 *
 *   - processing time alone — the active work it took, gaps away from Claude excluded;
 *   - wall-clock time — the real-world time it took, idle stretches and the computer
 *     being off included.
 *
 * The gap between the two bars for the same session is exactly the time not spent with
 * Claude, which is the thing a "how fast do I run out" chart cannot show with only one
 * of the two numbers.
 *
 * Same live-data idiom as `UsageQuotaBars.useUsageQuotas`, at the same gentler cadence —
 * session history does not change fast enough to earn a per-second poll.
 */
import { useEffect, useState } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import type { SessionStat } from '@tm/shared/usage';
import { SessionLimitChart } from './SessionLimitChart';
import { useTransport } from './transport';

const REFRESH_MS = 15_000;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  charts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '16px',
  },
  block: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', color: tokens.colorNeutralForeground2 },
});

/** The account's reconstructed session history, kept live. Null until the first read lands. */
export function useSessionStats(): SessionStat[] | null {
  const transport = useTransport();
  const [stats, setStats] = useState<SessionStat[] | null>(null);

  useEffect(() => {
    const read = (): void =>
      void transport.invoke('usage:sessionStats').then(setStats, () => undefined);
    read();
    const off = transport.on('usage:sample', read);
    const id = setInterval(read, REFRESH_MS);
    return () => {
      off();
      clearInterval(id);
    };
  }, [transport]);

  return stats;
}

const NO_DATA_LABEL = 'No session has run its token budget out yet — nothing to chart.';

/** The Performance screen's pair of "time to exhaust a session" charts. */
export function SessionStatsSection({
  stats,
}: {
  stats: SessionStat[] | null;
}): JSX.Element | null {
  const styles = useStyles();
  if (!stats) return null;
  return (
    <div className={styles.root}>
      <div className={styles.charts}>
        <div className={styles.block}>
          <span className={styles.label}>Processing time to exhaust a session</span>
          <SessionLimitChart
            stats={stats}
            metric="processingMs"
            color={tokens.colorBrandStroke1}
            emptyLabel={NO_DATA_LABEL}
          />
        </div>
        <div className={styles.block}>
          <span className={styles.label}>
            Wall-clock time to exhaust a session (incl. idle / offline)
          </span>
          <SessionLimitChart
            stats={stats}
            metric="wallClockMs"
            color={tokens.colorPaletteMarigoldForeground2}
            emptyLabel={NO_DATA_LABEL}
          />
        </div>
      </div>
    </div>
  );
}
