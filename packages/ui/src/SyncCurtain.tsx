/**
 * What the web board shows before it has enough of the mirror to render at all — see
 * `apps/web/src/board/syncGate.ts`'s `boardIsReady`.
 *
 * Deliberately NOT `PaneLoading`. That component argues for a skeleton over a spinner, and
 * it is right for the desktop's other panes: a millisecond-scale local SQLite read, where
 * guessing the shape of what's coming makes the wait feel shorter. This is a different
 * claim — a browser tab waiting on its first network round trip to the mirror, which can
 * run to several seconds on a large account — and the ticket asks for the status bar's own
 * blue behind it, not a skeleton of the board. Do not "unify" the two; they say different
 * things for different reasons.
 */
import type { JSX } from 'react';
import { Body1, Caption1, Spinner, makeStyles } from '@fluentui/react-components';
import { ACCENT } from './theme';

const useStyles = makeStyles({
  curtain: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    backgroundColor: ACCENT.statusBlue,
    color: '#ffffff',
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
});

export interface SyncCurtainProps {
  label: string;
  detail: string;
  error?: string | null;
}

export function SyncCurtain({ label, detail, error }: SyncCurtainProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.curtain}>
      {/* The label is rendered separately rather than through Spinner's own `label` prop so
          its colour is ours (white) rather than the global spinner rule's — see theme.ts's
          `useGlobalStyles`, which paints every spinner's arc and track in FLUO.cyan. */}
      <Spinner size="large" />
      <div className={styles.text}>
        <Body1>{label}</Body1>
        <Caption1>{error ?? detail}</Caption1>
      </div>
    </div>
  );
}
