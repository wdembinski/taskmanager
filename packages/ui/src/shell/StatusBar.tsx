/**
 * The status bar, in the editor's sense: the full width of the window (the nav rail
 * included), one line high, and **coloured** rather than bordered.
 *
 * Only the bar itself is shared — its fill, its type, and the two atoms every host needs
 * (a live/dead dot and the spacer that splits left from right). What goes *in* it is each
 * host's own business: the desktop has a Claude version, sync rings and usage quotas, the
 * browser has a poll age and a Sign out. Sharing the container and not the contents is
 * what keeps this from becoming a component with one prop per item.
 */
import { makeStyles } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { ACCENT, fontPx } from '../theme';

const useStyles = makeStyles({
  /**
   * Blue is the resting state; it turns the app's own "wants you" orange the moment
   * something is waiting on a human, so the signal is visible from across a room even when
   * the Attention screen is not open.
   */
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '3px 12px',
    flexShrink: 0,
    backgroundColor: ACCENT.statusBlue,
    color: '#ffffff',
    // The bar is one line of small text on a saturated fill, which is exactly where
    // Fluent's default weight goes muddy. A touch more size and weight, stated once here
    // so every item in the bar gets it.
    fontSize: fontPx(12),
    fontWeight: 600,
  },
  /**
   * The attention fill. Near-black ink rather than white: white on this orange is ~2.2:1,
   * which is the "hard to read when it goes orange" complaint — #1b1b1b is ~8.6:1.
   */
  footerAttention: { backgroundColor: ACCENT.unread, color: ACCENT.unreadInk },
  /**
   * The live/dead dot, with a dark ring so it separates from BOTH fills it is ever drawn
   * on. The ring matters because a single colour cannot have good contrast against a
   * mid-blue and a bright orange at once.
   */
  dot: {
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    flexShrink: 0,
    boxShadow: '0 0 0 1.5px rgba(0, 0, 0, 0.45)',
  },
  // NOT `colorPaletteGreenBackground3` (#0e700e), which was the bug: ~1.6:1 against the
  // bar's blue and ~3.2:1 against its orange — invisible on both.
  ok: { backgroundColor: ACCENT.liveGreen },
  bad: { backgroundColor: ACCENT.liveRed },
  grow: { flex: 1 },
  busy: { display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 },
  /** Inherits the bar's own colour rather than naming one, for the same reason `SyncRing`
   *  does: the bar turns orange under attention, and a fixed white or blue would go
   *  unreadable exactly then. A Fluent `<Spinner>` cannot do this — it strokes from design
   *  tokens, not `currentColor`. */
  busyRing: { display: 'block', flexShrink: 0, color: 'inherit' },
  busySpin: {
    animationName: { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
    transformOrigin: '50% 50%',
    // Holding still is the honest fallback: the label beside it already says what's busy.
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
});

/** The busy ring's geometry — small enough to sit on one line of the status bar, same size
 *  as `SyncRing`'s. */
const BUSY_SIZE = 13;
const BUSY_STROKE = 2;
const BUSY_R = (BUSY_SIZE - BUSY_STROKE) / 2;
const BUSY_CIRCUMFERENCE = 2 * Math.PI * BUSY_R;

export interface StatusBarProps {
  /** True while something is waiting on a human — the whole bar goes orange. */
  attention?: boolean;
  children: ReactNode;
}

export function StatusBar({ attention, children }: StatusBarProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={attention ? `${styles.footer} ${styles.footerAttention}` : styles.footer}>
      {children}
    </div>
  );
}

/** The one indicator every host's bar starts with: is the thing we depend on alive? */
export function StatusDot({ ok }: { ok: boolean }): JSX.Element {
  const styles = useStyles();
  return <span className={`${styles.dot} ${ok ? styles.ok : styles.bad}`} />;
}

/**
 * A spinning arc replacing the dot and its caption while a host is still finding out what to
 * say — e.g. the browser tab that hasn't heard back from the server yet about whether a
 * desktop app exists. Same substitution the desktop already makes while Claude's own version
 * is still unknown (`apps/client/src/renderer/src/App.tsx`'s `Spinner label="Checking
 * Claude…"`), drawn as an SVG arc rather than Fluent's `<Spinner>` so it can inherit
 * `currentColor` — see `busyRing`'s docstring above.
 */
export function StatusBusy({ label }: { label?: string }): JSX.Element {
  const styles = useStyles();
  return (
    <span className={styles.busy}>
      <svg
        className={styles.busyRing}
        width={BUSY_SIZE}
        height={BUSY_SIZE}
        viewBox={`0 0 ${BUSY_SIZE} ${BUSY_SIZE}`}
      >
        <circle
          className={styles.busySpin}
          cx={BUSY_SIZE / 2}
          cy={BUSY_SIZE / 2}
          r={BUSY_R}
          fill="none"
          stroke="currentColor"
          strokeWidth={BUSY_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${BUSY_CIRCUMFERENCE * 0.25} ${BUSY_CIRCUMFERENCE}`}
        />
      </svg>
      {label && <span>{label}</span>}
    </span>
  );
}

/** Splits the bar into a left group (what is wrong) and a right one (ambient state). */
export function StatusSpacer(): JSX.Element {
  const styles = useStyles();
  return <span className={styles.grow} />;
}
