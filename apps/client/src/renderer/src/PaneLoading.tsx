/**
 * What a screen shows before its data arrives — a skeleton of the shape that is coming,
 * or the reason it never did.
 *
 * Pairs with `useInitialLoad`: screens that used to render a bare `<Spinner>` while their
 * state was null render this, so a failed load explains itself and offers a way out
 * instead of spinning forever.
 *
 * A skeleton rather than a spinner because the two say different things. A spinner says
 * "wait"; a skeleton says "wait, and here is what you are waiting for" — the window stops
 * changing shape when the data lands, which is what makes a load feel quick even when it
 * is not. `shape` picks the layout: the board's columns of cards, or a stack of rows.
 * There is still a spinner for the screens whose shape is not worth predicting.
 */
import type { JSX } from 'react';
import {
  Body1,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  /** Columns of cards, matching the Kanban grid the real board lays out. */
  board: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    paddingTop: '4px',
  },
  column: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  /** One placeholder card. The heights are the real card's, so nothing jumps on arrival. */
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rows: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  failed: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '760px',
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface PaneLoadingProps {
  /** Shown beside the spinner, e.g. "Loading tasks…". Also the skeleton's accessible name. */
  label: string;
  /** Non-null once the load failed. */
  error: string | null;
  /** Re-runs the load (from `useInitialLoad`). */
  onRetry: () => void;
  /**
   * The shape being waited for. Omitted keeps the spinner, which is right for a screen
   * whose layout depends on what arrives — guessing wrong is worse than not guessing.
   */
  shape?: 'board' | 'rows';
}

export function PaneLoading({ label, error, onRetry, shape }: PaneLoadingProps): JSX.Element {
  const styles = useStyles();

  if (!error) {
    if (shape === 'board') {
      return (
        <Skeleton aria-label={label} className={styles.board}>
          {[0, 1, 2].map((col) => (
            <div key={col} className={styles.column}>
              {/* Fewer cards in later columns, the way a real board thins out to the
                  right — an even grid reads as a table, not as a board. */}
              {Array.from({ length: 3 - col }, (_unused, i) => (
                <div key={i} className={styles.card}>
                  <SkeletonItem size={16} />
                  <SkeletonItem size={12} style={{ width: '60%' }} />
                </div>
              ))}
            </div>
          ))}
        </Skeleton>
      );
    }
    if (shape === 'rows') {
      return (
        <Skeleton aria-label={label} className={styles.rows}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={styles.row}>
              <SkeletonItem size={16} />
              <SkeletonItem size={12} style={{ width: '70%' }} />
            </div>
          ))}
        </Skeleton>
      );
    }
    return <Spinner label={label} labelPosition="after" size="tiny" />;
  }

  return (
    <div className={styles.failed}>
      <MessageBar intent="error">
        <MessageBarBody>{error}</MessageBarBody>
        <MessageBarActions>
          <Button size="small" appearance="primary" onClick={onRetry}>
            Retry
          </Button>
        </MessageBarActions>
      </MessageBar>
      {/* "No handler registered" is the signature of an engine that failed to start —
          naming it here saves the user from having to run the app from a terminal. */}
      {error.includes('No handler registered') && (
        <Body1 className={styles.hint}>
          The app&apos;s backend did not start, so nothing can load. Restart the app — if it keeps
          happening, the error dialog on startup and the log file it names will say why.
        </Body1>
      )}
    </div>
  );
}
