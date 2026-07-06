/**
 * Session view (Phase 1, refactored in Phase 3).
 *
 * A hands-on panel to run ONE Claude session and watch it live. You give it a
 * prompt, a working directory, a model, and a permission mode; it starts a
 * session in the engine and streams the events back into a transcript.
 *
 * The scrolling transcript itself now lives in the shared `<Transcript>` (also
 * used by the Board). This component keeps the form plus the derived status/cost,
 * which it tracks by observing the same events via the transcript's `onEvent`.
 */
import { useCallback, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Field,
  makeStyles,
  Option,
  Subtitle2,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import type { ClaudeModel, PermissionMode, SessionEvent, SessionStatus } from '@shared/session';
import { Transcript } from './Transcript';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, flex: 1 },
  form: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' },
  grow: { flex: 1, minWidth: '280px' },
  narrow: { width: '160px' },
  controls: { display: 'flex', gap: '8px' },
  meta: { color: tokens.colorNeutralForeground3 },
  statusRow: { display: 'flex', gap: '12px', alignItems: 'center' },
});

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

function statusBadge(status: SessionStatus): {
  color: 'informative' | 'success' | 'danger' | 'warning';
  label: string;
} {
  switch (status) {
    case 'starting':
      return { color: 'informative', label: 'starting' };
    case 'running':
      return { color: 'informative', label: 'running' };
    case 'completed':
      return { color: 'success', label: 'completed' };
    case 'failed':
      return { color: 'danger', label: 'failed' };
    case 'stopped':
      return { color: 'warning', label: 'stopped' };
  }
}

export function SessionRunner(): JSX.Element {
  const styles = useStyles();
  const [prompt, setPrompt] = useState('Reply with exactly the word: pong');
  const [cwd, setCwd] = useState('C:\\Repositories\\task-manager');
  const [model, setModel] = useState<ClaudeModel>('haiku');
  const [mode, setMode] = useState<PermissionMode>('plan');

  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  // Track the derived status/cost from the same event stream the transcript renders.
  const onEvent = useCallback((event: SessionEvent): void => {
    switch (event.kind) {
      case 'started':
        setSessionId(event.sessionId);
        setStatus('running');
        break;
      case 'result':
        setCost(event.costUsd);
        setStatus(event.success ? 'completed' : 'failed');
        break;
      case 'exited':
        setStatus((s) => (s === 'completed' || s === 'failed' || s === 'stopped' ? s : 'failed'));
        break;
    }
  }, []);

  async function run(): Promise<void> {
    setSessionId(null);
    setCost(null);
    setStatus('starting');
    setRunId(null);
    const { runId: id } = await window.api.invoke('session:start', {
      prompt,
      cwd,
      model,
      permissionMode: mode,
    });
    setRunId(id);
  }

  async function stop(): Promise<void> {
    if (runId) {
      await window.api.invoke('session:stop', runId);
      setStatus('stopped');
    }
  }

  const running = status === 'starting' || status === 'running';

  return (
    <div className={styles.root}>
      <Subtitle2>Run a session</Subtitle2>

      <div className={styles.form}>
        <Field label="Prompt" className={styles.grow}>
          <Textarea value={prompt} onChange={(_e, d) => setPrompt(d.value)} resize="vertical" />
        </Field>
        <Field label="Working directory" className={styles.grow}>
          <Textarea value={cwd} onChange={(_e, d) => setCwd(d.value)} resize="none" />
        </Field>
        <Field label="Model" className={styles.narrow}>
          <Dropdown
            value={model}
            selectedOptions={[model]}
            onOptionSelect={(_e, d) => setModel(d.optionValue as ClaudeModel)}
          >
            {MODELS.map((m) => (
              <Option key={m} value={m}>
                {m}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Permission mode" className={styles.narrow}>
          <Dropdown
            value={mode}
            selectedOptions={[mode]}
            onOptionSelect={(_e, d) => setMode(d.optionValue as PermissionMode)}
          >
            {MODES.map((m) => (
              <Option key={m} value={m}>
                {m}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <div className={styles.controls}>
          <Button appearance="primary" onClick={run} disabled={running}>
            Run
          </Button>
          <Button onClick={stop} disabled={!running}>
            Stop
          </Button>
        </div>
      </div>

      <div className={styles.statusRow}>
        {status && (
          <Badge appearance="filled" color={statusBadge(status).color}>
            {statusBadge(status).label}
          </Badge>
        )}
        {sessionId && <Caption1 className={styles.meta}>session {sessionId}</Caption1>}
        {cost != null && <Caption1 className={styles.meta}>cost ${cost.toFixed(4)}</Caption1>}
      </div>

      <Transcript runId={runId} onEvent={onEvent} emptyHint="No output yet — press Run." />

      <Caption1 className={styles.meta}>
        Tip: keep “Permission mode” on <strong>plan</strong> while experimenting — Claude will read
        and plan but won’t change files. Switch to <strong>acceptEdits</strong> to let it work.
      </Caption1>
    </div>
  );
}
