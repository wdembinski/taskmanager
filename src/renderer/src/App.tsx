/**
 * App shell.
 *
 * A tabbed dashboard over the orchestration engine: Projects, the running Board,
 * the Attention inbox, Settings, and a hands-on Scratch run. A global usage-limit
 * banner (Phase 5) sits above the tabs; a footer (Phase 6) shows Claude readiness
 * and app info, and the top only shows a Claude message bar when something is wrong.
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
  Title2,
  tokens,
} from '@fluentui/react-components';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';
import { Attention } from './Attention';
import { Board } from './Board';
import { LimitBanner } from './LimitBanner';
import { Projects } from './Projects';
import { Settings } from './Settings';
import { SessionRunner } from './SessionRunner';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '20px',
    height: '100%',
    boxSizing: 'border-box',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', alignItems: 'baseline', gap: '12px' },
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

type TabId = 'projects' | 'board' | 'attention' | 'settings' | 'scratch';

export function App(): JSX.Element {
  const styles = useStyles();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [tab, setTab] = useState<TabId>('projects');
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
    <div className={styles.page}>
      <div className={styles.header}>
        <Title2>Claude Orchestrator</Title2>
      </div>

      {/* Surface a Claude problem prominently; when all is well the footer suffices. */}
      {claude && !claudeOk && (
        <MessageBar intent="warning">
          <MessageBarBody>{claude.message}</MessageBarBody>
        </MessageBar>
      )}

      {/* Global usage-limit gate (Phase 5): a countdown banner while work is parked. */}
      <LimitBanner />

      <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabId)}>
        <Tab value="projects">Projects</Tab>
        <Tab value="board">Board</Tab>
        <Tab value="attention">
          Attention
          {attentionCount > 0 && (
            <CounterBadge count={attentionCount} color="danger" size="small" appearance="filled" />
          )}
        </Tab>
        <Tab value="settings">Settings</Tab>
        <Tab value="scratch">Scratch run</Tab>
      </TabList>

      <div className={styles.body}>
        {tab === 'projects' ? (
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
  );
}
