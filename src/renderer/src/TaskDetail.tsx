/**
 * TaskDetail — the right-hand pane of the My Tasks screen (Phase 9).
 *
 * Shows one task's status control and its **unified activity timeline**: your
 * comments and status changes interleaved with the AI transcript (loaded from
 * `task:activity`), plus an input to add a progress note. AI events are rendered
 * with the same `eventToLines` the Board's Transcript uses, so output looks the
 * same everywhere. While a delegated run is live its events are appended as they
 * arrive, so the transcript streams instead of waiting for a reselect.
 *
 * The agent controls (assign / stop / answer a parked run) live in `TaskAgentPanel`
 * above the timeline; the ticket's own description sits between the two.
 *
 * A card's **steps** (Phase 11) live below the agent panel: the chain an approved plan
 * produced, or one written by hand. Selecting a step shows that step's own pane — its
 * brief and its transcript — with a breadcrumb back to the card it belongs to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Subtitle2,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ManualStatus, Project, Task, TaskActivityEntry } from '@shared/model';
import type { SessionEvent } from '@shared/session';
import { ChevronLeftRegular } from '@fluentui/react-icons';
import { isTranscriptNoise, runningSubAgents } from './agentActivity';
import { stepPosition } from './board/boardColumns';
import { MANUAL_STATUS_OPTIONS, STATUS_COLOR, STATUS_LABEL } from './taskStatus';
import { StepBrief, TaskSteps } from './TaskSteps';
import { TaskAgentPanel } from './TaskAgentPanel';
import { eventToLines } from './Transcript';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, flex: 1 },
  head: { display: 'flex', flexDirection: 'column', gap: '4px' },
  crumbRow: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '-8px' },
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
  jiraCommentBody: {
    borderLeft: '3px solid #F2A900',
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
  description: {
    whiteSpace: 'pre-wrap',
    maxHeight: '160px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
  },
  running: { display: 'flex', alignItems: 'center', gap: '8px' },
  runningLabel: { color: tokens.colorNeutralForeground2 },
  subAgent: { paddingLeft: '18px' },
  subAgentLabel: { color: tokens.colorNeutralForeground3 },
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
  /** The agent projects a card can be delegated to (owned by the board, fetched once). */
  agentProjects?: Project[];
  /**
   * The chain this task belongs to, in execution order: a card's own steps, or — when
   * a step is shown — its siblings, which is what makes "step 2 of 5" possible.
   */
  subtasks?: Task[];
  /** The card a shown step belongs to (null for an ordinary card). */
  parentTask?: Task | null;
  /** Show another task in this pane (the breadcrumb, and opening a step). */
  onOpenTask?: (taskId: string) => void;
  /** Called after a successful manual status change so the parent list can patch. */
  onStatusChanged?: (task: Task) => void;
  /** Called after a step is added or edited, so the board can reload its cards. */
  onSubtasksChanged?: () => void;
}

export function TaskDetail({
  task,
  agentProjects = [],
  subtasks = [],
  parentTask = null,
  onOpenTask,
  onStatusChanged,
  onSubtasksChanged,
}: TaskDetailProps): JSX.Element {
  const styles = useStyles();
  const [activity, setActivity] = useState<TaskActivityEntry[]>([]);
  const [jiraComments, setJiraComments] = useState<TaskActivityEntry[]>([]);
  const [liveEvents, setLiveEvents] = useState<TaskActivityEntry[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id ?? null;
  const isJira = task?.externalSource === 'jira';

  const loadActivity = useCallback(async () => {
    if (!taskId) {
      setActivity([]);
      setJiraComments([]);
      setLiveEvents([]);
      return;
    }
    // The reload already contains everything streamed so far (events are persisted as
    // they arrive), so drop the live buffer to avoid showing each line twice.
    setLiveEvents([]);
    setActivity(await window.api.invoke('task:activity', taskId));
    if (isJira) {
      // JIRA comments are fetched live and merged in; failures shouldn't blank the pane.
      setJiraComments(await window.api.invoke('jira:fetchComments', taskId).catch(() => []));
      // Opening the task clears its unread border.
      await window.api
        .invoke('jira:markRead', taskId)
        .then((updated) => onStatusChanged?.(updated))
        .catch(() => undefined);
    } else {
      setJiraComments([]);
    }
  }, [taskId, isJira, onStatusChanged]);

  useEffect(() => {
    setComment('');
    setError(null);
    void loadActivity();
  }, [loadActivity]);

  // Follow this task's live run so its transcript streams in. `session:event` only
  // carries a runId, so track which run belongs to this card: the active-runs snapshot
  // seeds it, and `task:changed` keeps it current as runs start and end.
  const runIdRef = useRef<string | null>(null);
  useEffect(() => {
    runIdRef.current = null;
    if (!taskId) return;
    let cancelled = false;
    void window.api
      .invoke('scheduler:activeRuns')
      .then((runs) => {
        if (!cancelled) runIdRef.current = runs.find((r) => r.taskId === taskId)?.runId ?? null;
      })
      .catch(() => undefined);
    const offTask = window.api.on('task:changed', ({ task: changed, runId }) => {
      if (changed.id === taskId) runIdRef.current = runId;
    });
    return () => {
      cancelled = true;
      offTask();
    };
  }, [taskId]);

  useEffect(() => {
    return window.api.on('session:event', ({ runId, event }) => {
      if (!runIdRef.current || runId !== runIdRef.current) return;
      // Negative ids can't collide with the persisted rows' keys.
      setLiveEvents((prev) => [
        ...prev,
        { kind: 'event', id: -(prev.length + 1), event, createdAt: Date.now() },
      ]);
    });
  }, []);

  // One chronological timeline: persisted activity + live JIRA comments + live output.
  // Debug chatter (thinking, tool calls, successful tool results) is dropped — the
  // "Agent running" indicator below stands in for all of it. See `agentActivity.ts`.
  const timeline = useMemo(
    () =>
      [...activity, ...jiraComments, ...liveEvents]
        .filter((e) => e.kind !== 'event' || !isTranscriptNoise(e.event))
        .sort((a, b) => a.createdAt - b.createdAt),
    [activity, jiraComments, liveEvents],
  );

  // Sub-agents the main agent spawned and is still waiting on, derived from the
  // UNFILTERED stream (the tool calls the timeline hides are exactly the evidence).
  const subAgents = useMemo(() => {
    const events = [...activity, ...liveEvents]
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((e) => (e.kind === 'event' ? [e.event as SessionEvent] : []));
    return runningSubAgents(events);
  }, [activity, liveEvents]);

  // Keep the newest entry in view as output streams (same rule as the Transcript pane).
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline, subAgents]);

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

  async function addJiraComment(): Promise<void> {
    if (!task || !comment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.invoke('jira:addComment', task.id, comment.trim());
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

  const isStep = Boolean(task.parentTaskId);
  const position = isStep ? stepPosition(subtasks, task.id) : null;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {parentTask && (
          <div className={styles.crumbRow}>
            <Button
              size="small"
              appearance="transparent"
              icon={<ChevronLeftRegular />}
              onClick={() => onOpenTask?.(parentTask.id)}
            >
              {parentTask.title}
            </Button>
            {position !== null && (
              <Caption1 className={styles.phase}>
                Step {position} of {subtasks.length}
              </Caption1>
            )}
          </div>
        )}
        <Subtitle2>{task.title}</Subtitle2>
        {task.phase && !isStep && <Caption1 className={styles.phase}>{task.phase}</Caption1>}
        {task.dependsOn?.length > 0 && (
          <Caption1 className={styles.phase}>Depends on: {task.dependsOn.join(', ')}</Caption1>
        )}
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

      <TaskAgentPanel
        task={task}
        agentProjects={agentProjects}
        onTaskChanged={(updated) => {
          onStatusChanged?.(updated);
          void loadActivity();
        }}
      />

      {isStep ? (
        <StepBrief
          task={task}
          onChanged={(updated) => {
            onStatusChanged?.(updated);
            onSubtasksChanged?.();
          }}
        />
      ) : (
        <TaskSteps
          task={task}
          subtasks={subtasks}
          onOpen={(id) => onOpenTask?.(id)}
          onChanged={() => onSubtasksChanged?.()}
        />
      )}

      {task.externalDescription && (
        <div className={styles.description}>{task.externalDescription}</div>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.timeline} ref={timelineRef}>
        {timeline.length === 0 && !managedByAI ? (
          <Caption1 className={styles.empty}>
            No activity yet — change the status or add a comment to start the log.
          </Caption1>
        ) : (
          timeline.map((entry) => {
            if (entry.kind === 'jira-comment') {
              return (
                <div key={`j${entry.id}`} className={styles.entry}>
                  <div className={styles.entryHead}>
                    <Text weight="semibold">💬 {entry.author} · Jira</Text>
                    <span className={styles.grow} />
                    <Caption1 className={styles.time}>{fmtTime(entry.createdAt)}</Caption1>
                  </div>
                  <div className={styles.jiraCommentBody}>{entry.body}</div>
                </div>
              );
            }
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
            // A message the human sent to the agent (Phase 12). No Delete: it was said
            // to the agent and shaped what it did — removing it would falsify the story.
            // Phase 3 of the chat feature turns this into a bubble.
            if (entry.kind === 'chat') {
              return (
                <div key={`m${entry.id}`} className={styles.entry}>
                  <div className={styles.entryHead}>
                    <Text weight="semibold">You → agent</Text>
                    <span className={styles.grow} />
                    <Caption1 className={styles.time}>{fmtTime(entry.createdAt)}</Caption1>
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

        {/* One live indicator in place of the tool-by-tool chatter: the agent itself,
            then a row per sub-agent it has spawned and is still waiting on. */}
        {managedByAI && (
          <>
            <div className={styles.running}>
              <Spinner size="tiny" />
              <Caption1 className={styles.runningLabel}>Agent running</Caption1>
            </div>
            {subAgents.map((agent) => (
              <div key={agent.toolId} className={`${styles.running} ${styles.subAgent}`}>
                <Spinner size="tiny" />
                <Caption1 className={styles.runningLabel}>Agent running</Caption1>
                {agent.label && (
                  <Caption1 className={styles.subAgentLabel}>· {agent.label}</Caption1>
                )}
              </div>
            ))}
          </>
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
          {isJira && (
            <Button
              appearance="primary"
              disabled={busy || !comment.trim()}
              onClick={() => void addJiraComment()}
            >
              Add JIRA comment
            </Button>
          )}
          <Button
            appearance={isJira ? 'secondary' : 'primary'}
            disabled={busy || !comment.trim()}
            onClick={() => void addComment()}
          >
            Add note
          </Button>
        </div>
      </div>
    </div>
  );
}
