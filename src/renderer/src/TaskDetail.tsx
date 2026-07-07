/**
 * TaskDetail — the right-hand pane of the My Tasks screen (Phase 9).
 *
 * Shows one task's status control and its **unified activity timeline**: your
 * comments and status changes interleaved with the AI transcript (loaded from
 * `task:activity`), plus an input to add a progress note. AI events are rendered
 * with the same `eventToLines` the Board's Transcript uses, so output looks the
 * same everywhere.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Subtitle2,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ManualStatus, Task, TaskActivityEntry } from '@shared/model';
import { MANUAL_STATUS_OPTIONS, STATUS_COLOR, STATUS_LABEL } from './taskStatus';
import { eventToLines } from './Transcript';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, flex: 1 },
  head: { display: 'flex', flexDirection: 'column', gap: '4px' },
  phase: { color: tokens.colorNeutralForeground3 },
  statusRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  grow: { flex: 1 },
  timeline: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  entry: { display: 'flex', flexDirection: 'column', gap: '2px' },
  entryHead: { display: 'flex', alignItems: 'center', gap: '8px' },
  time: { color: tokens.colorNeutralForeground3, fontSize: '11px' },
  comment: { whiteSpace: 'pre-wrap' },
  commentBody: {
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    paddingLeft: '8px',
    whiteSpace: 'pre-wrap',
  },
  eventLines: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.5',
  },
  meta: { color: tokens.colorNeutralForeground3 },
  assistant: { color: tokens.colorNeutralForeground1 },
  tool: { color: tokens.colorPaletteBlueForeground2 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  err: { color: tokens.colorPaletteRedForeground1 },
  composer: { display: 'flex', flexDirection: 'column', gap: '6px' },
  composerRow: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  empty: { color: tokens.colorNeutralForeground3 },
});

/** Format an epoch-ms timestamp compactly (e.g. "Jul 7, 14:05"). */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface TaskDetailProps {
  task: Task | null;
  /** Called after a successful manual status change so the parent list can patch. */
  onStatusChanged?: (task: Task) => void;
}

export function TaskDetail({ task, onStatusChanged }: TaskDetailProps): JSX.Element {
  const styles = useStyles();
  const [activity, setActivity] = useState<TaskActivityEntry[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id ?? null;

  const loadActivity = useCallback(async () => {
    if (!taskId) {
      setActivity([]);
      return;
    }
    setActivity(await window.api.invoke('task:activity', taskId));
  }, [taskId]);

  useEffect(() => {
    setComment('');
    setError(null);
    void loadActivity();
  }, [loadActivity]);

  const lineClass: Record<string, string> = {
    meta: styles.meta,
    assistant: styles.assistant,
    tool: styles.tool,
    warn: styles.warn,
    err: styles.err,
  };

  if (!task) {
    return (
      <div className={styles.root}>
        <Body1 className={styles.empty}>Select a task to see its status and activity.</Body1>
      </div>
    );
  }

  const managedByAI = task.status === 'running' || task.status === 'waiting-input';

  async function setStatus(next: ManualStatus): Promise<void> {
    if (!task || next === task.status) return;
    setError(null);
    try {
      const updated = await window.api.invoke('task:setStatus', task.id, next);
      onStatusChanged?.(updated);
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function addComment(): Promise<void> {
    if (!task || !comment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.invoke('task:addComment', task.id, comment.trim());
      setComment('');
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteComment(id: number): Promise<void> {
    await window.api.invoke('task:deleteComment', id);
    await loadActivity();
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <Subtitle2>{task.title}</Subtitle2>
        {task.phase && <Caption1 className={styles.phase}>{task.phase}</Caption1>}
      </div>

      <div className={styles.statusRow}>
        <Text>Status</Text>
        <Dropdown
          value={STATUS_LABEL[task.status]}
          selectedOptions={[task.status]}
          disabled={managedByAI}
          onOptionSelect={(_e, d) => {
            if (d.optionValue) void setStatus(d.optionValue as ManualStatus);
          }}
        >
          {MANUAL_STATUS_OPTIONS.map((o) => (
            <Option key={o.value} value={o.value}>
              {o.label}
            </Option>
          ))}
        </Dropdown>
        {managedByAI && (
          <Caption1 className={styles.meta}>Stop the session to change status.</Caption1>
        )}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.timeline}>
        {activity.length === 0 ? (
          <Caption1 className={styles.empty}>
            No activity yet — change the status or add a comment to start the log.
          </Caption1>
        ) : (
          activity.map((entry) => {
            if (entry.kind === 'comment') {
              return (
                <div key={`c${entry.id}`} className={styles.entry}>
                  <div className={styles.entryHead}>
                    <Text weight="semibold">💬 You</Text>
                    <span className={styles.grow} />
                    <Caption1 className={styles.time}>{fmtTime(entry.createdAt)}</Caption1>
                    <Button
                      size="small"
                      appearance="transparent"
                      onClick={() => void deleteComment(entry.id)}
                    >
                      Delete
                    </Button>
                  </div>
                  <div className={styles.commentBody}>{entry.body}</div>
                </div>
              );
            }
            if (entry.kind === 'status') {
              return (
                <div key={`s${entry.id}`} className={`${styles.entry} ${styles.entryHead}`}>
                  <Text className={styles.meta}>Status →</Text>
                  <Badge appearance="tint" color={STATUS_COLOR[entry.to]}>
                    {STATUS_LABEL[entry.to]}
                  </Badge>
                  <span className={styles.grow} />
                  <Caption1 className={styles.time}>{fmtTime(entry.createdAt)}</Caption1>
                </div>
              );
            }
            // AI transcript event
            return (
              <div key={`e${entry.id}`} className={styles.eventLines}>
                {eventToLines(entry.event).map((line, i) => (
                  <div key={i} className={lineClass[line.cls]}>
                    {line.text}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      <div className={styles.composer}>
        <Textarea
          value={comment}
          onChange={(_e, d) => setComment(d.value)}
          placeholder="Add a progress note… (context for when you come back)"
          resize="vertical"
        />
        <div className={styles.composerRow}>
          <Button
            appearance="primary"
            disabled={busy || !comment.trim()}
            onClick={() => void addComment()}
          >
            Add comment
          </Button>
        </div>
      </div>
    </div>
  );
}
