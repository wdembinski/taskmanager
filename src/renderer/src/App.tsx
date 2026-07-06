/**
 * App shell (Phase 1).
 *
 * Shows a Claude-readiness banner at the top (from Phase 0) and, below it, the
 * live Session view where you can run one Claude session and watch it stream.
 *
 * The pattern to notice: this component reads request/response data via
 * `window.api.invoke(...)`, while the Session view consumes pushed events via
 * `window.api.on(...)`. Those two are the whole UI↔engine vocabulary.
 */
import { useEffect, useState } from 'react';
import {
  Caption1,
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
import { Board } from './Board';
import { Projects } from './Projects';
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
});

type TabId = 'projects' | 'board' | 'scratch';

export function App(): JSX.Element {
  const styles = useStyles();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [tab, setTab] = useState<TabId>('projects');

  useEffect(() => {
    void window.api.invoke('app:getInfo').then(setInfo);
    void window.api.invoke('claude:getStatus').then(setClaude);
  }, []);

  const claudeOk = claude?.installed && claude?.authenticated && !claude?.apiKeyDetected;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Title2>Claude Orchestrator</Title2>
        {info && (
          <Caption1 className={styles.meta}>
            v{info.version} · electron {info.electron} · node {info.node}
          </Caption1>
        )}
      </div>

      {claude ? (
        <MessageBar intent={claudeOk ? 'success' : 'warning'}>
          <MessageBarBody>{claude.message}</MessageBarBody>
        </MessageBar>
      ) : (
        <Spinner label="Checking Claude…" labelPosition="after" size="tiny" />
      )}

      <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabId)}>
        <Tab value="projects">Projects</Tab>
        <Tab value="board">Board</Tab>
        <Tab value="scratch">Scratch run</Tab>
      </TabList>

      <div className={styles.body}>
        {tab === 'projects' ? <Projects /> : tab === 'board' ? <Board /> : <SessionRunner />}
      </div>
    </div>
  );
}
