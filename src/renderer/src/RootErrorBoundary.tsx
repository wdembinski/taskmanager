/**
 * Last-resort UI for a renderer crash.
 *
 * Without this, a throw during render unmounts the whole tree and leaves a blank
 * window — indistinguishable from the app hanging, and impossible to report usefully.
 * It also catches stray promise rejections, which React error boundaries do not see:
 * an unawaited `window.api.invoke` that rejects would otherwise vanish into the
 * DevTools console that a packaged app never opens.
 *
 * The reload button matters: most renderer failures are transient, and a reload is
 * cheaper than quitting and reopening the app.
 */
import { Component, useEffect, useState, type ErrorInfo, type JSX, type ReactNode } from 'react';
import {
  Body1,
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { PRODUCT_NAME } from '@shared/product';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalXXL,
    height: '100%',
    boxSizing: 'border-box',
    overflowY: 'auto',
  },
  detail: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
    margin: 0,
  },
  // Overlaid rather than inserted into the tree: the app shell is a fixed-height
  // flex column, and pushing a sibling into it would shift every pane down.
  toast: {
    position: 'fixed',
    zIndex: 1000,
    top: tokens.spacingVerticalM,
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'min(720px, 90vw)',
    boxShadow: tokens.shadow16,
  },
});

function CrashScreen({ title, detail }: { title: string; detail: string }): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Subtitle2>{title}</Subtitle2>
      <MessageBar intent="error">
        <MessageBarBody>Something went wrong in the app window.</MessageBarBody>
        <MessageBarActions>
          <Button size="small" appearance="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </MessageBarActions>
      </MessageBar>
      <Body1>If this keeps happening, please report the details below.</Body1>
      <pre className={styles.detail}>{detail}</pre>
    </div>
  );
}

/**
 * Surfaces promise rejections nobody handled — a dismissible toast rather than a
 * takeover, because the app is usually still usable, just missing some data.
 */
function RejectionToast(): JSX.Element | null {
  const styles = useStyles();
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent): void => {
      const err: unknown = e.reason;
      setReason(err instanceof Error ? err.message : String(err));
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  if (!reason) return null;
  return (
    <div className={styles.toast}>
      <MessageBar intent="warning">
        <MessageBarBody>Something failed in the background: {reason}</MessageBarBody>
        <MessageBarActions>
          <Button size="small" appearance="transparent" onClick={() => setReason(null)}>
            Dismiss
          </Button>
        </MessageBarActions>
      </MessageBar>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No console exists in a packaged app, but this still helps in dev and shows up
    // if the window is opened with --remote-debugging-port.
    console.error('Renderer crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <CrashScreen
          title={`${PRODUCT_NAME} hit an error`}
          detail={this.state.error.stack ?? this.state.error.message}
        />
      );
    }
    return (
      <>
        <RejectionToast />
        {this.props.children}
      </>
    );
  }
}
