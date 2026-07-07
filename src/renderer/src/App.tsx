/**
 * App shell.
 *
 * A frameless window: a custom <TitleBar> (window drag handle + min/max/close)
 * sits flush at the very top, and below it a padded content region hosts the
 * tabbed dashboard — Projects, the running Board, the Attention inbox, Settings,
 * and a hands-on Scratch run. A global usage-limit banner (Phase 5) sits above
 * the tabs; a footer (Phase 6) shows Claude readiness and app info, and the top
 * only shows a Claude message bar when something is wrong.
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
} from '@fluentui/react-components';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';
import { Attention } from './Attention';
import { Board } from './Board';
import { LimitBanner } from './LimitBanner';
import { MyTasks } from './MyTasks';
import { Projects } from './Projects';
import { Settings } from './Settings';
import { SessionRunner } from './SessionRunner';
import { TitleBar } from './TitleBar';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '12px 20px 16px',
    flex: 1,
    minHeight: 0,
    boxSizing: 'border-box',
  },
  meta: { color: tokens.colorNeutralForeground3 },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingTop: '8px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
  },
  dot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  ok: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  bad: { backgroundColor: tokens.colorPaletteRedBackground3 },
  grow: { flex: 1 },
});

type TabId = 'mytasks' | 'projects' | 'board' | 'attention' | 'settings' | 'scratch';

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

      <div className={styles.content}>
        {/* Surface a Claude problem prominently; when all is well the footer suffices. */}
        {claude && !claudeOk && (
          <MessageBar intent="warning">
            <MessageBarBody>{claude.message}</MessageBarBody>
          </MessageBar>
        )}

        {/* Global usage-limit gate (Phase 5): a countdown banner while work is parked. */}
        <LimitBanner />

        <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabId)}>
          <Tab value="mytasks">My Tasks</Tab>
          <Tab value="projects">Projects</Tab>
          <Tab value="board">Board</Tab>
          <Tab value="attention">
            Attention
            {attentionCount > 0 && (
              <CounterBadge
                count={attentionCount}
                color="danger"
                size="small"
                appearance="filled"
              />
            )}
          </Tab>
          <Tab value="settings">Settings</Tab>
          <Tab value="scratch">Scratch run</Tab>
        </TabList>

        <div className={styles.body}>
          {tab === 'mytasks' ? (
            <MyTasks />
          ) : tab === 'projects' ? (
            <Projects />
          ) : tab === 'board' ? (
            <Board />
          ) : tab === 'attention' ? (
            <Attention />
          ) : tab === 'settings' ? (
            <Settings />
          ) : (
            <SessionRunner />
          )}
        </div>

        {/* Footer: Claude readiness + app info (folds in the Phase 0 status banner). */}
        <div className={styles.footer}>
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
          <span className={styles.grow} />
          {info && (
            <Caption1 className={styles.meta}>
              v{info.version} · electron {info.electron} · node {info.node}
            </Caption1>
          )}
        </div>
      </div>
    </div>
  );
}
