/**
 * App shell.
 *
 * A frameless window: a custom <TitleBar> (window drag handle + min/max/close)
 * sits flush at the very top, and under it a **vertical nav rail** on the left —
 * My Tasks, Projects, the running Board, Performance, the Attention inbox,
 * Settings, a hands-on Scratch run — beside the content region. The rail replaced
 * a horizontal tab strip, which cost every screen a band of height at the top,
 * where a board and a chat pane both want it most. A global usage-limit banner
 * (Phase 5) sits above the content; a Claude message bar appears only when
 * something is wrong; and a **status bar** runs the full width of the window at
 * the bottom — blue at rest, orange while anything is waiting on a human.
 *
 * The pattern to notice: components read request/response data via
 * `window.api.invoke(...)` and consume pushed updates via `window.api.on(...)`.
 * Those two are the whole UI↔engine vocabulary.
 */
import { useEffect, useState } from 'react';
import {
  Caption1,
  CounterBadge,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Spinner,
  Tab,
  TabList,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  AlertRegular,
  BoardRegular,
  DataTrendingRegular,
  FolderRegular,
  PlayRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';
import { Attention } from './Attention';
import { Board } from './Board';
import { LimitBanner } from './LimitBanner';
import { MyTasks } from './MyTasks';
import { Performance } from './Performance';
import { Projects } from './Projects';
import { Settings } from './Settings';
import { SessionRunner } from './SessionRunner';
import { TitleBar } from './TitleBar';

/** The editor's status-bar blue, and the app's own "this one wants you" orange. */
const STATUS_BLUE = '#007ACC';
const UNREAD_ORANGE = '#F2A900';

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
  /**
   * A vertical rail of icons rather than a row of tabs across the top: the tab strip
   * cost every screen a band of height at its most valuable point, and seven
   * destinations with familiar glyphs need no words. Each tab keeps its label as a
   * tooltip, which is also what a screen reader announces.
   */
  nav: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    // ~1.5× the width an icon-only tab takes on its own, so the rail is a deliberate
    // edge of the window rather than a thin strip of buttons.
    width: '84px',
    paddingTop: '8px',
    flexShrink: 0,
    // The same surface as the detail pane, so the window reads as content between two
    // lighter edges rather than as three unrelated panels.
    backgroundColor: tokens.colorNeutralBackground1,
    // The glyphs scale with the rail: 1.5× the 24px they started at, so the icon still
    // fills the same share of a wider tab.
    '& svg': { fontSize: '36px' },
    // The tabs fill that width; their glyphs stay centred in it.
    '& button': { justifyContent: 'center' },
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
   * neither is showing (the normal case) the row collapses, so no screen pays for it.
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
   * Every screen but My Tasks is a document and wants a margin. My Tasks is a
   * two-panel workspace whose right pane runs to the window's edges, so it gets none
   * and lays out its own insets.
   */
  bodyPadded: { padding: '12px 16px' },
  /**
   * A status bar, in the editor's sense: the full width of the window (the nav rail
   * included), one line high, and **coloured** rather than bordered. Blue is the resting
   * state; it turns the app's own "wants you" orange the moment something is waiting on
   * a human, so the signal is visible from across a room even when the Attention screen
   * is not open.
   */
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '3px 12px',
    flexShrink: 0,
    backgroundColor: STATUS_BLUE,
    color: '#ffffff',
  },
  footerAttention: { backgroundColor: UNREAD_ORANGE, color: '#1b1b1b' },
  dot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  ok: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  bad: { backgroundColor: tokens.colorPaletteRedBackground3 },
  grow: { flex: 1 },
});

type TabId =
  'mytasks' | 'projects' | 'board' | 'performance' | 'attention' | 'settings' | 'scratch';

/** The rail, in order. The label is the tooltip and the accessible name. */
const NAV: Array<{ id: TabId; label: string; icon: JSX.Element }> = [
  { id: 'mytasks', label: 'My Tasks', icon: <TaskListSquareLtrRegular /> },
  { id: 'projects', label: 'Projects', icon: <FolderRegular /> },
  { id: 'board', label: 'Board', icon: <BoardRegular /> },
  { id: 'performance', label: 'Performance', icon: <DataTrendingRegular /> },
  { id: 'attention', label: 'Attention', icon: <AlertRegular /> },
  { id: 'settings', label: 'Settings', icon: <SettingsRegular /> },
  { id: 'scratch', label: 'Scratch run', icon: <PlayRegular /> },
];

export function App(): JSX.Element {
  const styles = useStyles();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [tab, setTab] = useState<TabId>('mytasks');
  // How many tasks are waiting on a human, shown as a badge on the Attention tab.
  const [attentionCount, setAttentionCount] = useState(0);

  useEffect(() => {
    void window.api.invoke('app:getInfo').then(setInfo);
    void window.api.invoke('claude:getStatus').then(setClaude);
    void window.api.invoke('attention:list').then((items) => setAttentionCount(items.length));

    const offNew = window.api.on('attention:new', () => setAttentionCount((n) => n + 1));
    const offResolved = window.api.on('attention:resolved', () =>
      setAttentionCount((n) => Math.max(0, n - 1)),
    );
    return () => {
      offNew();
      offResolved();
    };
  }, []);

  const claudeOk = claude?.installed && claude?.authenticated && !claude?.apiKeyDetected;

  return (
    <div className={styles.shell}>
      <TitleBar />

      <div className={styles.main}>
        <TabList
          vertical
          size="large"
          className={styles.nav}
          selectedValue={tab}
          onTabSelect={(_e, d) => setTab(d.value as TabId)}
        >
          {NAV.map((item) => (
            <Tooltip key={item.id} content={item.label} relationship="label" positioning="after">
              <Tab value={item.id} icon={item.icon}>
                {/* The only label left: a count that means "someone is waiting on you". */}
                {item.id === 'attention' && attentionCount > 0 && (
                  <CounterBadge
                    count={attentionCount}
                    color="danger"
                    size="small"
                    appearance="filled"
                  />
                )}
              </Tab>
            </Tooltip>
          ))}
        </TabList>

        <div className={styles.content}>
          <div className={styles.banners}>
            {/* Surface a Claude problem prominently; when all is well the footer suffices. */}
            {claude && !claudeOk && (
              <MessageBar intent="warning">
                <MessageBarBody>{claude.message}</MessageBarBody>
              </MessageBar>
            )}

            {/* Global usage-limit gate (Phase 5): a countdown while work is parked. */}
            <LimitBanner />
          </div>

          <div className={tab === 'mytasks' ? styles.body : `${styles.body} ${styles.bodyPadded}`}>
            {tab === 'mytasks' ? (
              <MyTasks />
            ) : tab === 'projects' ? (
              <Projects />
            ) : tab === 'board' ? (
              <Board />
            ) : tab === 'performance' ? (
              <Performance />
            ) : tab === 'attention' ? (
              <Attention />
            ) : tab === 'settings' ? (
              <Settings />
            ) : (
              <SessionRunner />
            )}
          </div>
        </div>
      </div>

      {/* Status bar: Claude readiness + app info, the full width of the window. */}
      <div
        className={
          attentionCount > 0 ? `${styles.footer} ${styles.footerAttention}` : styles.footer
        }
      >
        {claude ? (
          <>
            <span className={`${styles.dot} ${claudeOk ? styles.ok : styles.bad}`} />
            <Caption1>
              {claude.installed
                ? `Claude ${claude.version ?? '?'}${claude.authenticated ? ' · logged in' : ' · not logged in'}`
                : 'Claude CLI not found'}
              {claude.apiKeyDetected && ' · ANTHROPIC_API_KEY set'}
            </Caption1>
          </>
        ) : (
          <Spinner label="Checking Claude…" labelPosition="after" size="tiny" />
        )}
        {attentionCount > 0 && <Caption1>· {attentionCount} waiting on you</Caption1>}
        <span className={styles.grow} />
        {info && (
          <Caption1>
            v{info.version} · electron {info.electron} · node {info.node}
          </Caption1>
        )}
      </div>
    </div>
  );
}
