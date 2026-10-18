/**
 * The frame every host draws its screens inside: an optional title bar flush at the top, a
 * nav rail down the left, a banner strip above the content, and a status bar running the
 * full width at the bottom.
 *
 * Slots rather than props, because the frame is the only part the two hosts agree on. The
 * one difference worth naming is `titleBar`: the desktop runs in a frameless window and has
 * to draw its own (drag region + min/max/close), and a browser tab has no frame to draw —
 * so it is optional, and its absence *is* the web's whole structural difference from the
 * desktop shell.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  /** Nav rail + content, side by side under the title bar. `position: relative` so
   *  `scrim` can cover exactly this band — never the title bar or status bar above/below it. */
  main: { display: 'flex', flex: 1, minHeight: 0, position: 'relative' },
  /**
   * The command palette's backdrop, drawn here rather than by Fluent's own `Dialog` so it
   * never covers the title bar or status bar (the mockup dims the sidebar too, which is
   * inside this band). `zIndex` only needs to clear this shell's own content — Fluent's
   * dialog portal mounts at `document.body`, above everything in this tree regardless of
   * what z-index it is given here.
   */
  scrim: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'var(--tm-scrim)',
    zIndex: 1,
    animationName: { from: { opacity: 0 }, to: { opacity: 1 } },
    animationDuration: tokens.durationFaster,
    animationTimingFunction: 'ease-out',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  /** No padding: each screen owns its own insets, so a pane can run to the window edge. */
  content: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    boxSizing: 'border-box',
  },
  /**
   * The banners are the only things that need breathing room of their own — and when
   * none is showing (the normal case) the row collapses, so no screen pays for it.
   */
  banners: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px 12px 0',
    '&:empty': { display: 'none' },
  },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
  /**
   * A screen that is a *document* wants a margin. A two-panel workspace whose right pane
   * runs to the window's edges gets none and lays out its own insets.
   */
  bodyPadded: { padding: '12px 16px' },
});

export interface AppShellProps {
  /** The desktop's frameless-window title bar. Absent in a browser — see the header. */
  titleBar?: ReactNode;
  nav: ReactNode;
  /** The tree of milestones/epics/tickets plus the fixed views around it (F13.11), between
   *  the rail and the content. Omitted entirely rather than rendered empty where a host has
   *  not wired `useSidebarData` into a screen — `CompactShell`'s phone layout has no room for
   *  one at all. */
  sidebar?: ReactNode;
  /** Anything that must be said above every screen: an outage, a gate, a countdown. */
  banners?: ReactNode;
  /** The current screen. */
  children: ReactNode;
  status: ReactNode;
  /** See `bodyPadded` — off for a workspace screen that lays out its own insets. */
  padded?: boolean;
  /** Draws the content-only scrim over `main` (rail + sidebar + content) — on while the
   *  command palette is open, so it dims everything but the title bar and status bar. */
  dimmed?: boolean;
}

export function AppShell({
  titleBar,
  nav,
  sidebar,
  banners,
  children,
  status,
  padded,
  dimmed,
}: AppShellProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.shell}>
      {titleBar}

      <div className={styles.main}>
        {nav}
        {sidebar}

        <div className={styles.content}>
          <div className={styles.banners}>{banners}</div>

          <div className={padded ? `${styles.body} ${styles.bodyPadded}` : styles.body}>
            {children}
          </div>
        </div>

        {dimmed && <div aria-hidden className={styles.scrim} />}
      </div>

      {status}
    </div>
  );
}
