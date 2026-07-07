/**
 * Custom title bar for the frameless window.
 *
 * The Electron window is borderless (`frame: false`), so this bar replaces the OS
 * title bar: it carries the app name, is the window's drag handle (via the
 * `.app-drag` region from index.css), and provides the minimize / maximize-restore
 * / close controls. The controls opt out of dragging (`.app-no-drag`) and call the
 * `window:*` IPC channels; the maximize icon follows the real window state (so it
 * stays correct after edge-snap or a double-click-drag maximize).
 */
import { useEffect, useState } from 'react';
import { makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  bar: {
    height: '32px',
    minHeight: '32px',
    display: 'flex',
    alignItems: 'stretch',
    backgroundColor: tokens.colorNeutralBackground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    userSelect: 'none',
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '12px',
    flex: 1,
    minWidth: 0,
  },
  mark: {
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    flexShrink: 0,
    background: tokens.colorBrandBackground,
  },
  name: { color: tokens.colorNeutralForeground2 },
  controls: { display: 'flex', alignItems: 'stretch' },
  btn: {
    width: '46px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    padding: 0,
    background: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'default',
    ':hover': { backgroundColor: tokens.colorNeutralBackground4 },
    ':active': { backgroundColor: tokens.colorNeutralBackground5 },
  },
  close: {
    ':hover': { backgroundColor: '#c42b1c', color: '#ffffff' },
    ':active': { backgroundColor: '#b3271a', color: '#ffffff' },
  },
});

const stroke = { stroke: 'currentColor', strokeWidth: 1, fill: 'none' } as const;

function MinimizeIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line x1="0" y1="5" x2="10" y2="5" {...stroke} />
    </svg>
  );
}

function MaximizeIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="0.5" width="9" height="9" {...stroke} />
    </svg>
  );
}

function RestoreIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="2.5" width="7" height="7" {...stroke} />
      <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" {...stroke} />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line x1="0" y1="0" x2="10" y2="10" {...stroke} />
      <line x1="10" y1="0" x2="0" y2="10" {...stroke} />
    </svg>
  );
}

export function TitleBar(): JSX.Element {
  const styles = useStyles();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.api.invoke('window:isMaximized').then(setMaximized);
    return window.api.on('window:maximizedChanged', setMaximized);
  }, []);

  return (
    <div className={mergeClasses(styles.bar, 'app-drag')}>
      <div className={styles.title}>
        <span className={styles.mark} />
        <Text size={200} weight="semibold" className={styles.name}>
          Claude Orchestrator
        </Text>
      </div>

      <div className={mergeClasses(styles.controls, 'app-no-drag')}>
        <button
          className={styles.btn}
          title="Minimize"
          aria-label="Minimize"
          onClick={() => void window.api.invoke('window:minimize')}
        >
          <MinimizeIcon />
        </button>
        <button
          className={styles.btn}
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.api.invoke('window:toggleMaximize')}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          className={mergeClasses(styles.btn, styles.close)}
          title="Close"
          aria-label="Close"
          onClick={() => void window.api.invoke('window:close')}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
