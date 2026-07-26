/**
 * TaskDetail — the right-hand pane of the My Tasks screen.
 *
 * Since Phase 12 the pane is a **conversation**, not a log. Two tabs:
 *
 *  - **Chat** — the card's story as turns (`chat/turns.ts`): what you said to the agent,
 *    what it answered (markdown, with code in its own panel), the ticket's comment
 *    thread, and your own notes. A run's tool work folds into one muted line; the live
 *    "Agent running" rows sit **above** the composer rather than in the scroll, so the
 *    state of the run is always visible. One composer, pinned at the bottom: Enter
 *    sends to the agent, and the note / ticket-comment actions live in its overflow so
 *    Chat has one obvious action.
 *  - **Details** — the status control, the card's steps, its ticket description and the
 *    status-change history. Everything the conversation is not.
 *
 * The agent controls (assign / stop / answer a parked run) stay in `TaskAgentPanel` at
 * the top of Chat: answering a question the agent asked is part of the conversation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Subtitle2,
  Tab,
  TabList,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ManualStatus, Project, Task, TaskActivityEntry } from '@shared/model';
import type { SessionEvent } from '@shared/session';
import { chatTarget } from '@shared/board';
import { ChevronLeftRegular, MoreHorizontalRegular, SendRegular } from '@fluentui/react-icons';
import { runningSubAgents } from './agentActivity';
import { stepPosition } from './board/boardColumns';
import { ChatTurns } from './chat/ChatTurns';
import { foldTurns } from './chat/turns';
import { MANUAL_STATUS_OPTIONS, STATUS_COLOR, STATUS_LABEL } from './taskStatus';
import { StepBrief, TaskSteps } from './TaskSteps';
import { TaskAgentPanel } from './TaskAgentPanel';
import { chatAvailability, REFUSAL_HINT } from './taskChat';
import { usePendingAttention } from './usePendingAttention';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: 1 },
  head: { display: 'flex', flexDirection: 'column', gap: '4px' },
  crumbRow: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '-8px' },
  phase: { color: tokens.colorNeutralForeground3 },
  statusRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  grow: { flex: 1 },
  /** The tab's body: scrolls as one, so the composer stays put. */
  pane: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: 1 },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  entry: { display: 'flex', alignItems: 'center', gap: '8px' },
  time: { color: tokens.colorNeutralForeground3, fontSize: '11px' },
  meta: { color: tokens.colorNeutralForeground3 },
  description: {
    whiteSpace: 'pre-wrap',
    maxHeight: '220px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
  },
  /** The live run, pinned between the conversation and the composer. */
  runState: { display: 'flex', flexDirection: 'column', gap: '4px' },
  running: { display: 'flex', alignItems: 'center', gap: '8px' },
  runningLabel: { color: tokens.colorNeutralForeground2 },
  subAgent: { paddingLeft: '18px' },
  subAgentLabel: { color: tokens.colorNeutralForeground3 },
  composer: { display: 'flex', flexDirection: 'column', gap: '6px' },
  composerRow: { display: 'flex', alignItems: 'flex-end', gap: '8px' },
  composerHint: { color: tokens.colorNeutralForeground3 },
  /** Why the chat button is off — stated, not hidden in a tooltip on a dead button. */
  composerBlocked: { color: tokens.colorPaletteYellowForeground1 },
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
  const [tab, setTab] = useState<'chat' | 'details'>('chat');
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

  // One chronological story: persisted activity + live JIRA comments + live output.
  // Nothing is filtered here — `foldTurns` decides what the conversation shows and what
  // collapses, and the Details tab reads the status changes out of the same list.
  const timeline = useMemo(
    () => [...activity, ...jiraComments, ...liveEvents].sort((a, b) => a.createdAt - b.createdAt),
    [activity, jiraComments, liveEvents],
  );
  const turns = useMemo(() => foldTurns(timeline), [timeline]);
  const statusEntries = useMemo(
    () =>
      timeline.filter(
        (e): e is Extract<TaskActivityEntry, { kind: 'status' }> => e.kind === 'status',
      ),
    [timeline],
  );

  // Sub-agents the main agent spawned and is still waiting on, derived from the
  // UNFILTERED stream (the tool calls the conversation folds are exactly the evidence).
  const subAgents = useMemo(() => {
    const events = [...activity, ...liveEvents]
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((e) => (e.kind === 'event' ? [e.event as SessionEvent] : []));
    return runningSubAgents(events);
  }, [activity, liveEvents]);

  // Who a typed message would reach and whether it can be sent (Phase 12). The target
  // may be a live STEP — a card executing an approved plan holds no session of its own —
  // so the inbox item that decides "blocked on approve/deny" is the target's, not the
  // card's.
  const target = task ? chatTarget(task, subtasks) : null;
  const [targetPending] = usePendingAttention([target?.id]);
  const chat = task ? chatAvailability(task, subtasks, targetPending) : null;

  // Keep the newest turn in view as output streams (same rule as the Transcript pane).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, subAgents, tab]);

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

  /**
   * Say it to the agent (Phase 12). A live run hears it at once; an idle card with a
   * session behind it is resumed, which starts a real run — hence no optimistic clear
   * until the main process says it was delivered. A refusal is a normal answer, not an
   * exception, so it becomes a message rather than a stack trace.
   */
  async function sendChat(): Promise<void> {
    if (!task || !comment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.invoke('task:chat', task.id, comment.trim());
      if (result.status === 'refused') {
        setError(REFUSAL_HINT[result.reason]);
        return;
      }
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

  /** The composer's primary action: talk to the agent when there is one to talk to. */
  const primary = chat?.offered && chat.can ? sendChat : addComment;

  const isStep = Boolean(task.parentTaskId);
  const position = isStep ? stepPosition(subtasks, task.id) : null;
  // Chatting with a card whose step is working talks to the step; say which one, since
  // otherwise the message would seem to go to the card you are looking at.
  const chatStepPosition =
    chat && chat.target.id !== task.id ? stepPosition(subtasks, chat.target.id) : null;

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
      </div>

      <TabList
        selectedValue={tab}
        onTabSelect={(_e, d) => setTab(d.value as 'chat' | 'details')}
        size="small"
      >
        <Tab value="chat">Chat</Tab>
        <Tab value="details">Details</Tab>
      </TabList>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {tab === 'chat' ? (
        <div className={styles.pane}>
          <TaskAgentPanel
            task={task}
            subtasks={subtasks}
            agentProjects={agentProjects}
            onOpenTask={onOpenTask}
            onTaskChanged={(updated) => {
              onStatusChanged?.(updated);
              void loadActivity();
            }}
          />

          <div className={styles.scroll} ref={scrollRef}>
            {turns.length === 0 && !managedByAI ? (
              <Caption1 className={styles.empty}>
                Nothing said yet — write a note, or send the agent a message.
              </Caption1>
            ) : (
              <ChatTurns turns={turns} onDeleteNote={(id) => void deleteComment(id)} />
            )}
          </div>

          {/* The live state sits ABOVE the composer, so it never scrolls out of sight:
              the agent itself, then a row per sub-agent it is still waiting on. */}
          {managedByAI && (
            <div className={styles.runState}>
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
            </div>
          )}

          <div className={styles.composer}>
            {chat?.offered && chatStepPosition !== null && (
              <Caption1 className={styles.composerHint}>
                Talking to step {chatStepPosition} of {subtasks.length} — {chat.target.title}
              </Caption1>
            )}
            {chat?.offered && !chat.can && (
              <Caption1 className={styles.composerBlocked}>{chat.hint}</Caption1>
            )}
            <div className={styles.composerRow}>
              <Textarea
                className={styles.grow}
                value={comment}
                onChange={(_e, d) => setComment(d.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter is a newline — the CLI's own contract.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!busy && comment.trim()) void primary();
                  }
                }}
                placeholder={
                  chat?.offered
                    ? 'Message the agent…  (Enter sends, Shift+Enter for a new line)'
                    : 'Add a progress note…  (context for when you come back)'
                }
                resize="vertical"
              />
              <Button
                appearance="primary"
                icon={<SendRegular />}
                title={chat?.offered ? chat.hint : 'Save a note on this card'}
                disabled={busy || !comment.trim() || (chat?.offered === true && !chat.can)}
                onClick={() => void primary()}
              >
                {chat?.offered && chat.can ? 'Send' : 'Add note'}
              </Button>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button
                    appearance="subtle"
                    icon={<MoreHorizontalRegular />}
                    title="Other places this text can go"
                  />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem disabled={busy || !comment.trim()} onClick={() => void addComment()}>
                      Save as a note
                    </MenuItem>
                    {isJira && (
                      <MenuItem
                        disabled={busy || !comment.trim()}
                        onClick={() => void addJiraComment()}
                      >
                        Comment on the ticket
                      </MenuItem>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.pane}>
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

          {task.dependsOn?.length > 0 && (
            <Caption1 className={styles.phase}>Depends on: {task.dependsOn.join(', ')}</Caption1>
          )}

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

          <div className={styles.scroll}>
            {statusEntries.length === 0 ? (
              <Caption1 className={styles.empty}>No status changes yet.</Caption1>
            ) : (
              statusEntries.map((entry) => (
                <div key={`s${entry.id}`} className={styles.entry}>
                  <Text className={styles.meta}>Status →</Text>
                  <Badge appearance="tint" color={STATUS_COLOR[entry.to]}>
                    {STATUS_LABEL[entry.to]}
                  </Badge>
                  <span className={styles.grow} />
                  <Caption1 className={styles.time}>{fmtTime(entry.createdAt)}</Caption1>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
