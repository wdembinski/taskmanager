/**
 * The status bar's sync rings — one per tracker, each draining from full to empty as its
 * next poll comes due.
 *
 * The board is a mirror of things that live elsewhere, and it used to say nothing at all
 * about how stale that mirror was: a card five seconds old and a card five minutes old
 * looked identical, so the only way to answer "is this current?" was to press Sync and
 * watch. A ring per service answers it from across the room.
 *
 * **It drains rather than fills**, which is the way round it was asked for and the more
 * legible one: a nearly-empty ring means "about to refresh", and empty means the request has
 * gone out. A filling ring would have to be read against a remembered starting point to mean
 * anything.
 *
 * Drawn as an SVG arc rather than a Fluent `ProgressBar` or a spinner, because the thing
 * being shown is a *fraction of a wait*, and neither of those can hold a value while also
 * reading as a clock. While a sync is actually in flight the ring gives up on the value and
 * spins — that is the one moment there is no fraction to show.
 *
 * The countdown ticks on a local timer. `sync:changed` only fires when a sync starts or
 * ends, so a ring driven purely by it would sit still between polls; a second's interval
 * costs nothing and needs no IPC.
 */
import { useEffect, useState } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { syncRemaining, syncTooltip, type ServiceSyncState } from '@shared/sync';

/** The ring's geometry. Small enough to sit on one line of the status bar. */
const SIZE = 13;
const STROKE = 2;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

const useStyles = makeStyles({
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  item: { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
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
  label: { flexShrink: 0 },
  /** A service whose last attempt failed. Near-black, legible on both bar fills. */
  failed: { textDecoration: 'underline dotted' },
});

/** One tracker's ring. Exported for the status bar only; nothing else should need it. */
function SyncRing({ state, now }: { state: ServiceSyncState; now: number }): JSX.Element {
  const styles = useStyles();
  const remaining = syncRemaining(state, now);
  // A quarter-turn arc while syncing, so the spin reads as motion rather than as a value.
  const dash = state.syncing ? CIRCUMFERENCE * 0.25 : CIRCUMFERENCE * remaining;

  return (
    <span className={styles.item} title={syncTooltip(state, now)}>
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
      <span className={mergeClasses(styles.label, state.error !== null && styles.failed)}>
        {state.label}
      </span>
    </span>
  );
}

export interface SyncRingsProps {
  states: readonly ServiceSyncState[];
}

export function SyncRings({ states }: SyncRingsProps): JSX.Element | null {
  const styles = useStyles();
  const [now, setNow] = useState(() => Date.now());

  // A disabled integration is left out entirely rather than shown as a dead ring: an
  // indicator for something you have switched off is noise pretending to be information.
  const shown = states.filter((s) => s.enabled);

  useEffect(() => {
    if (shown.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown.length]);

  if (shown.length === 0) return null;
  return (
    <span className={styles.row}>
      {shown.map((state) => (
        <SyncRing key={state.id} state={state} now={now} />
      ))}
    </span>
  );
}
