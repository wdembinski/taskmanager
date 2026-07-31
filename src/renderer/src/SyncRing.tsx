/**
 * The status bar's sync ring — **one of them**, draining from full to empty as the next
 * refresh comes due.
 *
 * The board is a mirror of things that live elsewhere, and it used to say nothing about how
 * stale that copy was: a card five seconds out of date and one five minutes out of date
 * looked identical, so the only way to answer "is this current?" was to press Sync and watch.
 *
 * **It drains rather than fills**, which is the more legible way round: a nearly-empty ring
 * means "about to refresh", and empty means the request has gone out. A filling ring has to
 * be read against a remembered starting point to mean anything.
 *
 * One ring, not one per integration, because there is one timer behind them all — and there
 * is no version of "the board is up to date" that is true of the tickets and not of the merge
 * requests. What the services still differ in (which are on, which one's token just expired)
 * is exactly what the tooltip carries, line by line.
 *
 * Drawn as an SVG arc rather than a Fluent `ProgressBar` or a `Spinner`, because the thing
 * being shown is a *fraction of a wait* and neither of those can hold a value while also
 * reading as a clock. While a sweep is actually running the ring gives up on the value and
 * spins — that is the one moment there is no fraction to show.
 *
 * The countdown ticks on a local timer: `sync:changed` only fires when a sweep starts or
 * ends, so a ring driven purely by it would sit still between refreshes. A second's interval
 * costs nothing and needs no IPC.
 */
import { useEffect, useState } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { syncRemaining, syncTooltip, type SyncState } from '@shared/sync';

/** The ring's geometry. Small enough to sit on one line of the status bar. */
const SIZE = 13;
const STROKE = 2;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

const useStyles = makeStyles({
  item: { display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 },
  /**
   * The ring inherits the bar's own colour rather than naming one. The status bar turns
   * orange the moment something wants a human, and anything with a fixed white or blue of
   * its own would go unreadable exactly then — the same rule the update button follows.
   */
  ring: { display: 'block', flexShrink: 0, color: 'inherit' },
  /** Rotated so the arc starts at twelve o'clock and drains clockwise, like a clock face. */
  arc: { transform: 'rotate(-90deg)', transformOrigin: '50% 50%' },
  /** The track behind the arc: the same ink at low alpha, so it works on both bar fills. */
  track: { opacity: 0.3 },
  spinning: {
    animationName: { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
    transformOrigin: '50% 50%',
    // Holding still is the honest fallback: the label beside it already says "syncing".
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  /** A service somewhere in the sweep failed. Underlined, since colour is not available. */
  failed: { textDecoration: 'underline dotted' },
});

export interface SyncRingProps {
  state: SyncState | null;
}

export function SyncRing({ state }: SyncRingProps): JSX.Element | null {
  const styles = useStyles();
  const [now, setNow] = useState(() => Date.now());

  // Nothing switched on means nothing to be stale — the ring is left out rather than drawn
  // empty, because an indicator for something you have turned off is noise pretending to be
  // information.
  const active = state?.services.some((s) => s.enabled) ?? false;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!state || !active) return null;

  const failed = state.services.some((s) => s.enabled && s.error !== null);
  // A quarter-turn arc while syncing, so the spin reads as motion rather than as a value.
  const dash = state.syncing ? CIRCUMFERENCE * 0.25 : CIRCUMFERENCE * syncRemaining(state, now);

  return (
    <span
      className={mergeClasses(styles.item, failed && styles.failed)}
      title={syncTooltip(state, now)}
    >
      <svg className={styles.ring} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle
          className={styles.track}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
        />
        <circle
          className={mergeClasses(styles.arc, state.syncing && styles.spinning)}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
        />
      </svg>
      <span>Sync</span>
    </span>
  );
}
