/**
 * Scratch run (Phase 1, refactored in Phase 3, made plural in Phase 17).
 *
 * A hands-on panel for running Claude sessions and watching them live: a prompt, a
 * working directory, a model and a permission mode, started in the engine and streamed
 * back into a transcript.
 *
 * **Several at once.** It used to hold exactly one run — pressing Run replaced whatever
 * was on screen, and the button was disabled while a session was live, so comparing two
 * prompts meant running one, copying the output somewhere else, and running the other.
 * Each run is now a card of its own, newest first, with its own transcript, status and
 * Stop. Nothing is ever displaced by the next run.
 *
 * The scrolling transcript itself is the shared `<Transcript>`; each card keeps its own
 * derived status/cost, tracked by observing the same events via `onEvent`.
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
import { ChevronDownRegular, ChevronRightRegular, DeleteRegular } from '@fluentui/react-icons';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode, SessionEvent, SessionStatus } from '@shared/session';
import { Transcript } from './Transcript';
import { MONO } from '@ui/theme';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, flex: 1 },
  form: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' },
  grow: { flex: 1, minWidth: '280px' },
  narrow: { width: '160px' },
  controls: { display: 'flex', gap: '8px' },
  meta: { color: tokens.colorNeutralForeground3 },
  /** The run cards, newest first. This is the only part of the screen that scrolls. */
  runs: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    overflowY: 'auto',
    minHeight: 0,
    flex: 1,
    paddingRight: '4px',
  },
  run: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    flexShrink: 0,
    overflow: 'hidden',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    textAlign: 'left',
    width: '100%',
  },
  chevron: { display: 'flex', color: tokens.colorNeutralForeground3, flexShrink: 0 },
  /** The prompt, clipped to one line — the whole thing is in the transcript below. */
  promptPreview: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    color: tokens.colorNeutralForeground2,
  },
  /**
   * A bounded transcript. Without a cap, one chatty run pushes every other card off the
   * screen — which is the single-run problem again, wearing a different hat.
   */
  body: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '320px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '8px 10px',
    // `hidden` alone loses to `display: flex` above — the attribute's UA rule is
    // `display: none`, and any explicit `display` in a class beats it.
    '&[hidden]': { display: 'none' },
  },
  empty: { color: tokens.colorNeutralForeground4, padding: '12px 2px' },
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

/** One scratch run: what it was asked, and what has come back so far. */
interface ScratchRun {
  runId: string;
  prompt: string;
  model: ClaudeModel;
  mode: PermissionMode;
  status: SessionStatus;
  sessionId: string | null;
  costUsd: number | null;
  /** Collapsed cards keep their subscription — see the note in the card below. */
  open: boolean;
}

function isLive(status: SessionStatus): boolean {
  return status === 'starting' || status === 'running';
}

/**
 * One run's card.
 *
 * A component of its own so each run owns its `onEvent` identity: a single shared
 * callback would have every transcript writing into the same state, which is exactly the
 * bug that made one run at a time the only safe option.
 */
function RunCard({
  run,
  onPatch,
  onStop,
  onForget,
}: {
  run: ScratchRun;
  onPatch: (runId: string, change: Partial<ScratchRun>) => void;
  onStop: (runId: string) => void;
  onForget: (runId: string) => void;
}): JSX.Element {
  const styles = useStyles();

  const onEvent = useCallback(
    (event: SessionEvent): void => {
      switch (event.kind) {
        case 'started':
          onPatch(run.runId, { sessionId: event.sessionId, status: 'running' });
          break;
        case 'result':
          onPatch(run.runId, {
            costUsd: event.costUsd,
            status: event.success ? 'completed' : 'failed',
          });
          break;
        case 'exited':
          // Never overwrite a terminal status: `result` is the authoritative outcome and
          // `exited` always follows it.
          if (isLive(run.status)) onPatch(run.runId, { status: 'failed' });
          break;
      }
    },
    [onPatch, run.runId, run.status],
  );

  const badge = statusBadge(run.status);
  return (
    <div className={styles.run}>
      <button
        type="button"
        className={styles.head}
        onClick={() => onPatch(run.runId, { open: !run.open })}
        aria-expanded={run.open}
      >
        <span className={styles.chevron}>
          {run.open ? <ChevronDownRegular /> : <ChevronRightRegular />}
        </span>
        <Badge appearance="filled" color={badge.color}>
          {badge.label}
        </Badge>
        <Caption1 className={styles.promptPreview} title={run.prompt}>
          {run.prompt}
        </Caption1>
        <Caption1 className={styles.meta}>{run.model}</Caption1>
        {run.costUsd != null && (
          <Caption1 className={styles.meta}>${run.costUsd.toFixed(4)}</Caption1>
        )}
        {isLive(run.status) ? (
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onStop(run.runId);
            }}
          >
            Stop
          </Button>
        ) : (
          <Button
            size="small"
            appearance="subtle"
            icon={<DeleteRegular />}
            title="Remove this run from the list"
            aria-label="Remove this run from the list"
            onClick={(e) => {
              e.stopPropagation();
              onForget(run.runId);
            }}
          />
        )}
      </button>

      {/* HIDDEN, not unmounted, when collapsed.
          `Transcript` only replays persisted history for a `taskId`, and a scratch run has
          none — its output exists solely in the subscription this component holds. So
          unmounting a collapsed card would silently throw away everything that run had
          said, and collapsing to tidy the screen would destroy the thing you were tidying
          around. The cost is a live subscription per card, which is what the Stop and the
          status badge need anyway. */}
      <div className={styles.body} hidden={!run.open}>
        <Transcript runId={run.runId} onEvent={onEvent} emptyHint="No output yet…" />
      </div>
    </div>
  );
}

export function SessionRunner(): JSX.Element {
  const styles = useStyles();
  const [prompt, setPrompt] = useState('Reply with exactly the word: pong');
  const [cwd, setCwd] = useState('C:\\Repositories\\task-manager');
  const [model, setModel] = useState<ClaudeModel>('haiku');
  const [mode, setMode] = useState<PermissionMode>('plan');
  const [runs, setRuns] = useState<ScratchRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const patchRun = useCallback((runId: string, change: Partial<ScratchRun>): void => {
    setRuns((prev) => prev.map((r) => (r.runId === runId ? { ...r, ...change } : r)));
  }, []);

  const stopRun = useCallback((runId: string): void => {
    void window.api
      .invoke('session:stop', runId)
      .then(() =>
        setRuns((prev) => prev.map((r) => (r.runId === runId ? { ...r, status: 'stopped' } : r))),
      )
      .catch(() => undefined);
  }, []);

  const forgetRun = useCallback((runId: string): void => {
    setRuns((prev) => prev.filter((r) => r.runId !== runId));
  }, []);

  async function run(): Promise<void> {
    setError(null);
    try {
      const { runId } = await window.api.invoke('session:start', {
        prompt,
        cwd,
        model,
        permissionMode: mode,
      });
      // Newest first, and the only card left open: a new run is the one you are watching,
      // and collapsing the rest keeps the screen readable however many you have started.
      setRuns((prev) => [
        {
          runId,
          prompt,
          model,
          mode,
          status: 'starting',
          sessionId: null,
          costUsd: null,
          open: true,
        },
        ...prev.map((r) => ({ ...r, open: false })),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={styles.root}>
      <Subtitle2>Scratch runs</Subtitle2>

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
            value={PERMISSION_MODE_LABELS[mode]}
            selectedOptions={[mode]}
            onOptionSelect={(_e, d) => setMode(d.optionValue as PermissionMode)}
          >
            {MODES.map((m) => (
              <Option key={m} value={m}>
                {PERMISSION_MODE_LABELS[m]}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <div className={styles.controls}>
          {/* Never disabled: starting another run alongside a live one is the point. */}
          <Button appearance="primary" onClick={() => void run()}>
            Run
          </Button>
        </div>
      </div>

      {error && <Caption1 className={styles.meta}>{error}</Caption1>}

      <div className={styles.runs}>
        {runs.length === 0 ? (
          <Caption1 className={styles.empty}>No runs yet — press Run.</Caption1>
        ) : (
          runs.map((r) => (
            <RunCard
              key={r.runId}
              run={r}
              onPatch={patchRun}
              onStop={stopRun}
              onForget={forgetRun}
            />
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
