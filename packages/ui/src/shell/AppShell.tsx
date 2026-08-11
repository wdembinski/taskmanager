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
  /** Nav rail + content, side by side under the title bar. */
  main: { display: 'flex', flex: 1, minHeight: 0 },
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
  /** Anything that must be said above every screen: an outage, a gate, a countdown. */
  banners?: ReactNode;
  /** The current screen. */
  children: ReactNode;
  status: ReactNode;
  /** See `bodyPadded` — off for a workspace screen that lays out its own insets. */
  padded?: boolean;
}

export function AppShell({
  titleBar,
  nav,
  banners,
  children,
  status,
  padded,
}: AppShellProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.shell}>
      {titleBar}

      <div className={styles.main}>
        {nav}

        <div className={styles.content}>
          <div className={styles.banners}>{banners}</div>

          <div className={padded ? `${styles.body} ${styles.bodyPadded}` : styles.body}>
            {children}
          </div>
        </div>
      </div>

      {status}
    </div>
  );
}
