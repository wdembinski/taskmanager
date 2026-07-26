/**
 * TaskAgentPanel — the "Agent" section of the My Tasks detail pane.
 *
 * Everything a human does with a delegated card lives here: assign it to an agent
 * project (or reassign it, which restarts the run with fresh settings), stop the
 * agent, and — while a run is parked — **answer it inline**, without a detour to the
 * Attention inbox. The pending item is read from `attention:list` filtered to this
 * task and kept current over `attention:new` / `attention:resolved`, so a question
 * that arrives while you're reading the card appears on its own.
 *
 * Model and permission mode are shown read-only: both are captured when the run
 * starts, so changing them means reassigning (the button says so).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Field,
  MessageBar,
  MessageBarBody,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AgentsRegular } from '@fluentui/react-icons';
import type { AttentionAnswer, AttentionItem } from '@shared/attention';
import type { Project, Task } from '@shared/model';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import { AssignAgentDialog } from './AssignAgentDialog';

const ASK_ORANGE = '#F2A900';

const useStyles = makeStyles({
  box: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  // Double-size and white, matching the board card's delegation glyph.
  icon: { fontSize: '36px', display: 'flex', color: '#ffffff' },
  grow: { flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  ask: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `2px solid ${ASK_ORANGE}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  prompt: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    maxHeight: '160px',
    overflowY: 'auto',
  },
  choices: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  answerRow: { display: 'flex', alignItems: 'flex-end', gap: '8px' },
});

export interface TaskAgentPanelProps {
  task: Task;
  /** Every agent project (`agentProject:list`), owned by the board so it's fetched once. */
  agentProjects: Project[];
  /** Called with the updated task after an assign/stop so the board can patch the card. */
  onTaskChanged: (task: Task) => void;
}

export function TaskAgentPanel({
  task,
  agentProjects,
  onTaskChanged,
}: TaskAgentPanelProps): JSX.Element {
  const styles = useStyles();
  const [assignOpen, setAssignOpen] = useState(false);
  const [item, setItem] = useState<AttentionItem | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task.id;
  const live = task.status === 'running' || task.status === 'waiting-input';
  // A limit-parked card has no process to kill, but Stop still unparks it so it
  // doesn't silently resume when the limit lifts.
  const stoppable = live || task.status === 'blocked-by-limit';
  const assigned = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;

  // This task's pending ask, seeded from the inbox and kept live by its events.
  useEffect(() => {
    let cancelled = false;
    setReply('');
    void window.api
      .invoke('attention:list')
      .then((items) => {
        if (!cancelled) setItem(items.find((i) => i.taskId === taskId) ?? null);
      })
      .catch(() => undefined);

    const offNew = window.api.on('attention:new', (incoming) => {
      if (incoming.taskId === taskId) setItem(incoming);
    });
    const offResolved = window.api.on('attention:resolved', ({ id }) => {
      setItem((prev) => (prev && prev.id === id ? null : prev));
    });
    return () => {
      cancelled = true;
      offNew();
      offResolved();
    };
  }, [taskId]);

  const answer = useCallback(
    async (a: AttentionAnswer): Promise<void> => {
      if (!item) return;
      setBusy(true);
      setError(null);
      try {
        await window.api.invoke('attention:answer', item.id, a);
        setItem(null); // the engine also emits `attention:resolved`; clear now for snappiness
        setReply('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [item],
  );

  async function stop(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onTaskChanged(await window.api.invoke('task:stopAgent', taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.box}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <AgentsRegular />
        </span>
        <Text weight="semibold">Agent</Text>
        {assigned ? (
          <Badge appearance="tint" color="informative">
            {assigned.name}
          </Badge>
        ) : task.agentProjectId ? (
          <Badge appearance="tint" color="danger">
            project removed
          </Badge>
        ) : (
          <Caption1 className={styles.hint}>Not assigned</Caption1>
        )}
        <span className={styles.grow} />
        {stoppable && (
          <Button size="small" disabled={busy} onClick={() => void stop()}>
            Stop
          </Button>
        )}
        <Button
          size="small"
          appearance={task.agentProjectId ? 'secondary' : 'primary'}
          disabled={live}
          title={live ? 'Stop the agent before reassigning this card.' : undefined}
          onClick={() => setAssignOpen(true)}
        >
          {task.agentProjectId ? 'Reassign…' : 'Assign to an agent…'}
        </Button>
      </div>

      {task.agentProjectId && (
        <Caption1 className={styles.hint}>
          {task.agentModel ?? assigned?.defaultModel ?? 'project default'} ·{' '}
          {PERMISSION_MODE_LABELS[task.agentMode ?? assigned?.defaultPermissionMode ?? 'acceptEdits']}
          {assigned ? ` · ${assigned.path}` : ''}
        </Caption1>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {item && (
        <div className={styles.ask}>
          <div className={styles.head}>
            <Text weight="semibold">
              {item.kind === 'permission'
                ? 'The agent needs permission'
                : item.kind === 'merge-conflict'
                  ? 'Merge conflict — resolve it in the worktree'
                  : 'The agent has a question'}
            </Text>
          </div>
          <div className={styles.prompt}>{item.prompt}</div>
          {item.reason && <Caption1 className={styles.hint}>Held because it {item.reason}.</Caption1>}
          {item.worktreePath && (
            <Caption1 className={styles.hint} title={item.worktreePath}>
              Worktree: {item.worktreePath}
            </Caption1>
          )}

          {item.kind === 'permission' || item.kind === 'merge-conflict' ? (
            <div className={styles.answerRow}>
              <Field className={styles.grow} label="Optional note to the agent">
                <Textarea
                  value={reply}
                  resize="vertical"
                  onChange={(_e, d) => setReply(d.value)}
                  placeholder="Add guidance (optional)…"
                />
              </Field>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={() =>
                  void answer({ decision: 'approve', note: reply.trim() || undefined })
                }
              >
                {item.kind === 'merge-conflict' ? 'Resolved — finish merge' : 'Approve'}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void answer({ decision: 'deny', note: reply.trim() || undefined })}
              >
                {item.kind === 'merge-conflict' ? 'Abandon' : 'Deny'}
              </Button>
            </div>
          ) : (
            <>
              {item.options.length > 0 && (
                <div className={styles.choices}>
                  {item.options.map((option) => (
                    <Button
                      key={option}
                      appearance={option === item.options[0] ? 'primary' : 'secondary'}
                      disabled={busy}
                      onClick={() =>
                        void answer({
                          decision: 'reply',
                          text: option,
                          note: reply.trim() || undefined,
                        })
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <div className={styles.answerRow}>
                <Field
                  className={styles.grow}
                  label={item.options.length > 0 ? 'Or answer in your own words' : 'Your answer'}
                >
                  <Textarea
                    value={reply}
                    resize="vertical"
                    onChange={(_e, d) => setReply(d.value)}
                    placeholder="Type your reply…"
                  />
                </Field>
                <Button
                  appearance="primary"
                  disabled={busy || reply.trim().length === 0}
                  onClick={() => void answer({ decision: 'reply', text: reply.trim() })}
                >
                  Send
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <AssignAgentDialog
        open={assignOpen}
        task={task}
        agentProjects={agentProjects}
        onClose={() => setAssignOpen(false)}
        onAssigned={onTaskChanged}
      />
    </div>
  );
}
