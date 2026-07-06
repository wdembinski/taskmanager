/**
 * Session view (Phase 1).
 *
 * A hands-on panel to run ONE Claude session and watch it live. You give it a
 * prompt, a working directory, a model, and a permission mode; it starts a
 * session in the engine and streams the events back into a transcript.
 *
 * This is the manual, single-session precursor to the automated task board.
 * The important pattern here is how the UI consumes engine-pushed events:
 * `window.api.on('session:event', …)` inside a `useEffect`, filtered by the
 * `runId` we got back from `session:start`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Body1,
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, flex: 1 },
  form: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' },
  grow: { flex: 1, minWidth: '280px' },
  narrow: { width: '160px' },
  controls: { display: 'flex', gap: '8px' },
  transcript: {
    flex: 1,
    minHeight: '200px',
    overflowY: 'auto',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.5',
  },
  line: { marginBottom: '2px' },
  meta: { color: tokens.colorNeutralForeground3 },
  assistant: { color: tokens.colorNeutralForeground1 },
  tool: { color: tokens.colorPaletteBlueForeground2 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  err: { color: tokens.colorPaletteRedForeground1 },
  statusRow: { display: 'flex', gap: '12px', alignItems: 'center' },
});

/** One rendered transcript line, with a style class chosen by kind. */
interface Line {
  cls: 'meta' | 'assistant' | 'tool' | 'warn' | 'err';
  text: string;
}

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
  const [lines, setLines] = useState<Line[]>([]);

  // The runId of the session we started, kept in a ref so the event listener
  // (registered once) always sees the latest value without re-subscribing.
  const runIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const append = useCallback((line: Line) => {
    setLines((prev) => [...prev, line]);
  }, []);

  // Auto-scroll the transcript to the bottom as new lines arrive.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Subscribe ONCE to engine events; route only those for our current run.
  useEffect(() => {
    return window.api.on('session:event', ({ runId, event }) => {
      if (runId !== runIdRef.current) return;
      applyEvent(event);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyEvent(event: SessionEvent): void {
    switch (event.kind) {
      case 'started':
        setSessionId(event.sessionId);
        setStatus('running');
        append({
          cls: 'meta',
          text: `▶ session ${event.sessionId} · ${event.model} · ${event.permissionMode}`,
        });
        break;
      case 'thinking':
        append({ cls: 'meta', text: `  ·thinking· ${truncate(event.text)}` });
        break;
      case 'assistant':
        append({ cls: 'assistant', text: event.text });
        break;
      case 'tool-use':
        append({ cls: 'tool', text: `  ⚙ ${event.name}` });
        break;
      case 'tool-result':
        append({ cls: 'tool', text: `  ⚙ result${event.isError ? ' (error)' : ''}` });
        break;
      case 'rate-limit':
        if (event.status !== 'allowed') {
          const when = event.resetsAt
            ? new Date(event.resetsAt * 1000).toLocaleTimeString()
            : 'unknown';
          append({ cls: 'warn', text: `⏳ usage limit (${event.rateLimitType}) — resets ${when}` });
        }
        break;
      case 'result':
        setCost(event.costUsd);
        setStatus(event.success ? 'completed' : 'failed');
        append({
          cls: event.success ? 'meta' : 'err',
          text: `■ ${event.terminalReason ?? event.stopReason ?? 'done'}${event.costUsd != null ? ` · $${event.costUsd.toFixed(4)}` : ''}`,
        });
        break;
      case 'stderr':
        append({ cls: 'err', text: event.text.trimEnd() });
        break;
      case 'exited':
        // If we never saw a result, the run ended abnormally.
        setStatus((s) =>
          s === 'completed' || s === 'failed' ? s : s === 'stopped' ? s : 'failed',
        );
        break;
    }
  }

  async function run(): Promise<void> {
    setLines([]);
    setSessionId(null);
    setCost(null);
    setStatus('starting');
    const { runId } = await window.api.invoke('session:start', {
      prompt,
      cwd,
      model,
      permissionMode: mode,
    });
    runIdRef.current = runId;
  }

  async function stop(): Promise<void> {
    if (runIdRef.current) {
      await window.api.invoke('session:stop', runIdRef.current);
      setStatus('stopped');
      append({ cls: 'warn', text: '■ stopped by user' });
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

      <div ref={transcriptRef} className={styles.transcript}>
        {lines.length === 0 ? (
          <Body1 className={styles.meta}>No output yet — press Run.</Body1>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`${styles.line} ${styles[line.cls]}`}>
              {line.text}
            </div>
          ))
        )}
      </div>

      <Caption1 className={styles.meta}>
        Tip: keep “Permission mode” on <strong>plan</strong> while experimenting — Claude will read
        and plan but won’t change files. Switch to <strong>acceptEdits</strong> to let it work.
      </Caption1>
    </div>
  );
}

/** Shorten long thinking snippets so the transcript stays readable. */
function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
