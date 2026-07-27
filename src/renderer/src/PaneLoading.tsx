/**
 * What a screen shows before its data arrives — a spinner, or the reason it never did.
 *
 * Pairs with `useInitialLoad`: screens that used to render a bare `<Spinner>` while
 * their state was null now render this, so a failed load explains itself and offers a
 * way out instead of spinning forever.
 */
import type { JSX } from 'react';
import {
  Body1,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  failed: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '760px',
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface PaneLoadingProps {
  /** Shown beside the spinner, e.g. "Loading tasks…". */
  label: string;
  /** Non-null once the load failed. */
  error: string | null;
  /** Re-runs the load (from `useInitialLoad`). */
  onRetry: () => void;
}

export function PaneLoading({ label, error, onRetry }: PaneLoadingProps): JSX.Element {
  const styles = useStyles();

  if (!error) {
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
