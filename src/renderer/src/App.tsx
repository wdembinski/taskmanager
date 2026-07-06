/**
 * App shell (Phase 0).
 *
 * This is deliberately minimal: its purpose is to PROVE the whole stack is wired
 * end-to-end — React renders, Fluent UI styles apply, and the UI can talk to the
 * Node engine over IPC. It does that by asking the engine two questions on
 * mount ("what version am I?" and "is Claude ready?") and displaying the answers.
 *
 * Later phases replace this body with the real dashboard (project list, task
 * board, session view, attention inbox), but the pattern shown here —
 * `window.api.invoke(...)` inside a `useEffect` — is exactly how every screen
 * will read data from the engine.
 */
import { useEffect, useState } from 'react';
import {
  Body1,
  Caption1,
  Card,
  CardHeader,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle1,
  Title2,
  tokens,
} from '@fluentui/react-components';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '24px',
    height: '100%',
    boxSizing: 'border-box',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  cards: { display: 'flex', flexWrap: 'wrap', gap: '16px' },
  card: { width: '360px' },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
});

export function App(): JSX.Element {
  const styles = useStyles();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);

  // On mount, ask the engine for app info and Claude readiness. These calls
  // cross the IPC bridge to the handlers registered in src/main/ipc.ts.
  useEffect(() => {
    void window.api.invoke('app:getInfo').then(setInfo);
    void window.api.invoke('claude:getStatus').then(setClaude);
  }, []);

  const claudeOk = claude?.installed && claude?.authenticated && !claude?.apiKeyDetected;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Title2>Claude Orchestrator</Title2>
        <Body1>Run Claude across your projects, around the clock.</Body1>
      </div>

      {claude ? (
        <MessageBar intent={claudeOk ? 'success' : 'warning'}>
          <MessageBarBody>{claude.message}</MessageBarBody>
        </MessageBar>
      ) : (
        <Spinner label="Checking Claude…" labelPosition="after" size="tiny" />
      )}

      <div className={styles.cards}>
        <Card className={styles.card}>
          <CardHeader
            header={<Subtitle1>Claude CLI</Subtitle1>}
            description={<Caption1>The engine this app orchestrates</Caption1>}
          />
          {claude ? (
            <Body1 className={styles.mono}>
              installed: {String(claude.installed)}
              {claude.version ? ` (v${claude.version})` : ''}
              <br />
              logged in: {String(claude.authenticated)}
              <br />
              API key set: {String(claude.apiKeyDetected)}
            </Body1>
          ) : (
            <Spinner size="tiny" />
          )}
        </Card>

        <Card className={styles.card}>
          <CardHeader
            header={<Subtitle1>Runtime</Subtitle1>}
            description={<Caption1>Versions of the app shell</Caption1>}
          />
          {info ? (
            <Body1 className={styles.mono}>
              app: v{info.version}
              <br />
              electron: {info.electron}
              <br />
              node: {info.node} · chrome: {info.chrome}
              <br />
              platform: {info.platform}
            </Body1>
          ) : (
            <Spinner size="tiny" />
          )}
        </Card>
      </div>

      <Caption1>
        Phase 0 scaffold — this screen confirms React, Fluent UI, and IPC all work. The real
        dashboard arrives in the next phases.
      </Caption1>
    </div>
  );
}
