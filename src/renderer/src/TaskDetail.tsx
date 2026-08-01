/**
 * TaskDetail — the right-hand pane of the My Tasks screen.
 *
 * **One pane in two halves** (the user's call, and the right one): what a card *is* is
 * context you read *while* talking to the agent working it, not an alternative tab.
 *
 *  - **The band** (top, fixed): the ticket's identity — type glyph, title, key, priority
 *    — then the agent controls, the details (status + a foldable, editable description)
 *    and the steps. A shade lighter than the pane and nothing else — no box, no radius,
 *    no rules. Capped at 50% height with its own scroll, so a long chain can never
 *    crowd out the conversation.
 *  - **The conversation** (middle): the only thing that scrolls, unframed — a box around
 *    a chat is a box around the whole pane, which says nothing.
 *  - **The bottom band** (fixed): the live-run rows and the composer, on the same shade
 *    and the same inset as the top band. Two bands with the conversation running between
 *    them — the pane is one shape read top to bottom, and the composer floating on the
 *    pane's own colour used to break that for nothing.
 *
 * The pane's surface is a step LIGHTER than the board beside it, which is what separates
 * the two halves of the screen — there is no divider between them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import type { Project, Task, TaskActivityEntry } from '@shared/model';
import type { MergeRequest } from '@shared/mergeRequest';
import type { TaskLink } from '@shared/taskChain';
import type { SessionEvent } from '@shared/session';
import { chatTarget } from '@shared/board';
import type { StatusKeyword } from '@shared/statusKeywords';
import type { PriorityDisplay } from '@shared/settings';
import { ChevronLeftRegular, CollectionsEmptyRegular } from '@fluentui/react-icons';
import { runningSubAgents } from './agentActivity';
import { stepPosition } from './board/boardColumns';
import { typeIcon } from './board/TaskCard';
import { ChatTurns } from './chat/ChatTurns';
import { Composer } from './chat/Composer';
import { foldTurns } from './chat/turns';
import { EMPTY_COMPOSER, type ComposerValue } from './chat/mentions';
import { MergeRequests } from './MergeRequests';
import { TaskChain } from './TaskChain';
import { StepBrief, TaskSteps } from './TaskSteps';
import { TaskAgentPanel } from './TaskAgentPanel';
import { TaskDetailsCell } from './TaskDetailsCell';
import { chatAvailability, REFUSAL_HINT } from './taskChat';
import { runPhase } from '@shared/board';
import type { AttentionIndex } from './useAttentionIndex';

const useStyles = makeStyles({
  // No gap: the top band is full-bleed, so spacing belongs to the rows themselves.
  // `minWidth: 0` for the same reason as `minHeight: 0`: this is a flex item, and without
  // it the pane's width would be dictated by its widest descendant instead of the fixed
  // share the shell gives it.
  root: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 },
  head: { display: 'flex', flexDirection: 'column', gap: '2px' },
  crumbRow: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '-8px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  icon: { fontSize: '16px', display: 'flex', flexShrink: 0 },
  title: { flex: 1, minWidth: 0 },
  key: { textDecoration: 'none' },
  phase: { color: tokens.colorNeutralForeground3 },
  /** Everything below the band keeps the pane's own inset. */
  inset: { padding: '0 12px' },
  /**
   * The bottom band: the live-run rows and the composer, on the SAME surface and with
   * the same 12px inset as the details band at the top. The pane is one shape read
   * top-to-bottom — two fixed bands with the conversation scrolling between them — and
   * an inset composer floating on the pane's own colour broke that symmetry for no
   * gain. Full-bleed, so the two bands' edges line up.
   */
  footBand: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground6,
    flexShrink: 0,
  },
  /**
   * Everything the card *is* — its identity, the agent controls, the details, the
   * steps — in ONE band. No borders, no radius, no rules between the sections: shade
   * and spacing carry the grouping, which is all a sidebar this narrow can afford.
   */
  cell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '12px',
    // A shade lighter than the pane, and nothing else: no box, no radius, no rule under
    // it and none between its own sections. The change of surface is the whole seam.
    backgroundColor: tokens.colorNeutralBackground6,
    // Fixed while the conversation scrolls: this half never moves, and only overflows
    // into its own scroll when a card really has that much to say.
    flexShrink: 0,
    maxHeight: '50%',
    overflowY: 'auto',
  },
  /**
   * The conversation: unframed, on the pane's own surface, and the ONLY thing that
   * scrolls — the details band above and the composer below stay put however long the
   * chat gets.
   */
  scroll: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '10px 12px',
  },
  /** The live run, pinned between the conversation and the composer. */
  runState: { display: 'flex', flexDirection: 'column', gap: '4px' },
  running: { display: 'flex', alignItems: 'center', gap: '8px' },
  runningLabel: { color: tokens.colorNeutralForeground2 },
  subAgent: { paddingLeft: '18px' },
  subAgentLabel: { color: tokens.colorNeutralForeground3 },
  empty: { color: tokens.colorNeutralForeground3 },
  /**
   * Nothing selected. A sentence in the corner of an empty pane reads like a bug —
   * a large, quiet glyph in the middle reads like a state. The sentence survives as
   * the wrapper's `aria-label`/`title`, so a screen reader still gets the words.
   */
  emptyWrap: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyIcon: {
    fontSize: '100px',
    color: tokens.colorNeutralStroke2,
    opacity: 0.6,
  },
});

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
  /** The merge requests filed under this card (empty when GitLab is off). */
  mergeRequests?: MergeRequest[];
  /** The status-note vocabulary, so a past update reads in the colour the board gave it. */
  statusKeywords?: readonly StatusKeyword[];
  /** How the board draws priority, so this pane draws it the same way. */
  priorityDisplay?: PriorityDisplay;
  /**
   * The board's single attention index. Passed in rather than subscribed to here: this
   * pane and the agent panel inside it were each mounting their own subscription, holding
   * two copies of the same state that could disagree.
   */
  attention?: AttentionIndex;
  /** Task ids the engine has a live run for, so the pane can show a spawning run. */
  liveRunTaskIds?: ReadonlySet<string>;
  /**
   * The chained predecessors this card is still waiting on (`blockedBy`) — what the agent
   * panel's **Release now** override is offered against. Empty or absent for a card that is
   * not blocked, which is the only reason the button is not there.
   */
  chainWaitingOn?: readonly Task[];
  /**
   * Every link on the board, for the **Chain** section — the card's own predecessors and
   * successors as a list, which is the keyboard's route to what the arrows do by dragging.
   *
   * The whole list rather than this card's share of it, and the board's task index with it,
   * for the same reason `MyTasks` holds both: a JIRA sync rewrites every `Task` literal, so
   * anything derived per card would have to be rebuilt here on every poll anyway.
   */
  chainLinks?: readonly TaskLink[];
  chainTasksById?: ReadonlyMap<string, Task>;
  /** Erase one link. The board owns the call, so its arrow and this pane's row agree. */
  onUnlinkChain?: (linkId: string) => void;
  /** Show another task in this pane (the breadcrumb, and opening a step). */
  onOpenTask?: (taskId: string) => void;
  /** Called after a successful manual status change so the parent list can patch. */
  onStatusChanged?: (task: Task) => void;
  /** Called after a step is added or edited, so the board can reload its cards. */
  onSubtasksChanged?: () => void;
}

/** One empty map for every pane with no chain index, rather than a new one per render. */
const NO_TASKS: ReadonlyMap<string, Task> = new Map();

export function TaskDetail({
  task,
  agentProjects = [],
  subtasks = [],
  parentTask = null,
  mergeRequests = [],
  statusKeywords,
  priorityDisplay = 'color',
  attention,
  liveRunTaskIds,
  chainWaitingOn,
  chainLinks = [],
  chainTasksById = NO_TASKS,
  onUnlinkChain,
  onOpenTask,
  onStatusChanged,
  onSubtasksChanged,
}: TaskDetailProps): JSX.Element {
  const styles = useStyles();
  const [activity, setActivity] = useState<TaskActivityEntry[]>([]);
  const [jiraComments, setJiraComments] = useState<TaskActivityEntry[]>([]);
  const [liveEvents, setLiveEvents] = useState<TaskActivityEntry[]>([]);
  // The composer's whole value: what was typed, who is named in it, and what is
  // attached. Only the JIRA path uses the last two; the other three actions read `.text`.
  const [comment, setComment] = useState<ComposerValue>(EMPTY_COMPOSER);
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
    setError(null);
    void loadActivity();
  }, [loadActivity]);

  /**
   * **Half-written messages survive switching cards.**
   *
   * The composer used to be cleared whenever the pane changed task, so glancing at another
   * card — which is most of what a board is for — threw away whatever you were partway
   * through typing, with no warning and no way back. A draft belongs to the card it was
   * written for, so it is parked under that card's id and restored when you return.
   *
   * A ref rather than state: nothing renders from the map, and putting it in state would
   * re-render the whole pane on every keystroke that saves into it.
   */
  const drafts = useRef(new Map<string, ComposerValue>());
  // Mirrors `comment` so the cleanup below can read the LATEST value. The cleanup closes
  // over the old `taskId` by construction, which is exactly the card the draft belongs to.
  const commentRef = useRef(comment);
  commentRef.current = comment;
  useEffect(() => {
    setComment((taskId && drafts.current.get(taskId)) || EMPTY_COMPOSER);
    return () => {
      if (!taskId) return;
      const draft = commentRef.current;
      // Empty drafts are deleted rather than stored: "nothing typed" and "typed and then
      // cleared" are the same state, and keeping the second would grow the map for ever.
      if (draft.text.trim() || draft.attachments.length) drafts.current.set(taskId, draft);
      else drafts.current.delete(taskId);
    };
  }, [taskId]);

  // Follow this task's live run so its transcript streams in. `session:event` only
  // carries a runId, so track which run belongs to this card: the active-runs snapshot
  // seeds it, and `task:changed` keeps it current as runs start and end.
  const runIdRef = useRef<string | null>(null);
  // Read by the subscription below, which must not be torn down and rebuilt every time a
  // prop changes identity — it would drop events in the gap.
  const reloadRef = useRef(loadActivity);
  reloadRef.current = loadActivity;
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
    // The tail of a run arrives in two waves and needs a reload for each. The engine
    // settles the task first (a `task:changed` carrying no runId) and the process only
    // then reports its closing lines and exits, announcing itself with a second such
    // event — and a run's outcome note is written straight to the DB, never streamed at
    // all. Neither wave used to land: `runIdRef` was nulled on the first event, so
    // `session:event` stopped matching, and nothing re-read the rows. The pane kept a
    // transcript that stopped mid-sentence until you clicked another card and back —
    // which is exactly this reload, done by hand.
    //
    // Reloading twice is deliberate, and the second is the one that guarantees the
    // result: a reload replaces the timeline wholesale, so a line that arrived while the
    // first was in flight (and so landed in both the fetched rows and the live buffer) is
    // de-duplicated by the second rather than shown twice.
    let phase: 'idle' | 'live' | 'settling' = 'idle';
    const offTask = window.api.on('task:changed', ({ task: changed, runId }) => {
      if (changed.id !== taskId) return;
      if (runId) {
        runIdRef.current = runId;
        phase = 'live';
        return;
      }
      // `runIdRef` is deliberately NOT cleared here: the run that just ended is still
      // emitting, and only its own id can match those events anyway.
      if (phase === 'idle') return; // no run of ours to be the end of
      phase = phase === 'live' ? 'settling' : 'idle';
      void reloadRef.current();
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
  // collapses into a single "worked with N tools" line.
  const timeline = useMemo(
    () => [...activity, ...jiraComments, ...liveEvents].sort((a, b) => a.createdAt - b.createdAt),
    [activity, jiraComments, liveEvents],
  );
  const turns = useMemo(() => foldTurns(timeline), [timeline]);

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
  const targetPending = attention?.itemsFor([target?.id])[0] ?? null;
  const chat = task ? chatAvailability(task, subtasks, targetPending) : null;
  // Everything parked on this card AND its steps — the card's own ask first, so it
  // outranks a step's.
  const panelItems = useMemo(
    () => attention?.itemsFor([task?.id, ...subtasks.map((s) => s.id)]) ?? [],
    [attention, task?.id, subtasks],
  );

  // Keep the newest turn in view as output streams (same rule as the Transcript pane).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, subAgents]);

  if (!task) {
    return (
      <div className={styles.root}>
        <div
          className={styles.emptyWrap}
          role="note"
          aria-label="Select a task to see its status and activity."
          title="Select a task to see its status and activity."
        >
          <CollectionsEmptyRegular className={styles.emptyIcon} />
        </div>
      </div>
    );
  }

  /**
   * What this card is doing, from the one shared answer — not from `status` alone, which
   * could not see a run that had spawned but was not yet persisted as `running` (the
   * "no spinner though it is clearly working" complaint) and which called a card that is
   * WAITING FOR YOU "Agent running", spinner and all.
   */
  const run = runPhase(task, subtasks, liveRunTaskIds);
  const managedByAI =
    run.phase === 'running' || run.phase === 'starting' || run.phase === 'waiting';

  async function addComment(): Promise<void> {
    if (!task || !comment.text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.invoke('task:addComment', task.id, comment.text.trim());
      setComment(EMPTY_COMPOSER);
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** File the text as the card's headline. `onStatusChanged` puts it on the board. */
  async function postStatus(): Promise<void> {
    if (!task || !comment.text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onStatusChanged?.(
        await window.api.invoke('task:setStatusNote', task.id, comment.text.trim()),
      );
      setComment(EMPTY_COMPOSER);
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addJiraComment(): Promise<void> {
    // A comment that is only files is still a comment worth posting.
    if (!task || (!comment.text.trim() && !comment.attachments.length)) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.invoke('jira:addComment', task.id, {
        // Untrimmed: the mention ranges are offsets into THIS string, so trimming here
        // would silently move every one of them. Main trims the tail only.
        text: comment.text,
        mentions: comment.mentions.map((m) => ({
          start: m.start,
          end: m.end,
          id: m.accountId,
          displayName: m.displayName,
        })),
        attachmentPaths: comment.attachments,
      });
      setComment(EMPTY_COMPOSER);
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
    if (!task || !comment.text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.invoke('task:chat', task.id, comment.text.trim());
      if (result.status === 'refused') {
        setError(REFUSAL_HINT[result.reason]);
        return;
      }
      setComment(EMPTY_COMPOSER);
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Model / permission mode for the NEXT run (a live run keeps what it started with). */
  async function setAgentOptions(options: {
    model?: ClaudeModel;
    mode?: PermissionMode;
  }): Promise<void> {
    if (!task) return;
    setError(null);
    try {
      onStatusChanged?.(await window.api.invoke('task:setAgentOptions', task.id, options));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteComment(id: number): Promise<void> {
    await window.api.invoke('task:deleteComment', id);
    await loadActivity();
  }

  const isStep = Boolean(task.parentTaskId);
  const position = isStep ? stepPosition(subtasks, task.id) : null;
  // Chatting with a card whose step is working talks to the step; say which one, since
  // otherwise the message would seem to go to the card you are looking at.
  const chatStepPosition =
    chat && chat.target.id !== task.id ? stepPosition(subtasks, chat.target.id) : null;
  const agentProject = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;

  return (
    <div className={styles.root}>
      <div className={styles.cell}>
        {/* The ticket's own identity heads the band: what this card IS, before what is
            being done about it. The type glyph is the board card's, so one symbol
            means one kind of work everywhere. */}
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
          <div className={styles.titleRow}>
            <span className={styles.icon}>{typeIcon(task)}</span>
            <Subtitle2 className={styles.title}>{task.title}</Subtitle2>
            {task.externalKey &&
              (task.externalUrl ? (
                <a
                  className={styles.key}
                  href={task.externalUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title="Open the ticket in JIRA"
                >
                  <Badge appearance="outline" color="informative">
                    {task.externalKey}
                  </Badge>
                </a>
              ) : (
                <Badge appearance="outline" color="informative">
                  {task.externalKey}
                </Badge>
              ))}
          </div>
          <Caption1 className={styles.phase}>
            {[task.externalType ?? task.type, task.externalPriority, !isStep ? task.phase : null]
              .filter(Boolean)
              .join(' · ')}
          </Caption1>
        </div>

        <TaskAgentPanel
          task={task}
          subtasks={subtasks}
          agentProjects={agentProjects}
          items={panelItems}
          running={run.spinner}
          waitingOn={chainWaitingOn}
          onOpenTask={onOpenTask}
          onTaskChanged={(updated) => {
            onStatusChanged?.(updated);
            void loadActivity();
          }}
        />
        {/* A step's brief replaces the card's details + steps — it is the whole spec. */}
        {isStep ? (
          <StepBrief
            task={task}
            onChanged={(updated) => {
              onStatusChanged?.(updated);
              onSubtasksChanged?.();
            }}
          />
        ) : (
          <>
            <TaskDetailsCell
              task={task}
              agentProjects={agentProjects}
              managedByAI={managedByAI}
              priorityDisplay={priorityDisplay}
              onTaskChanged={(updated) => onStatusChanged?.(updated)}
              onEdited={() => void loadActivity()}
            />
            <TaskSteps
              task={task}
              subtasks={subtasks}
              onOpen={(id) => onOpenTask?.(id)}
              onChanged={() => onSubtasksChanged?.()}
            />
            {/* Beside Steps, and deliberately after it: a card's own steps are the work
                inside it, and the chain is where that work sits among everything else.
                Never on a STEP's pane — a step cannot be chained at either end. */}
            <TaskChain
              task={task}
              links={chainLinks}
              tasksById={chainTasksById}
              onOpen={(id) => onOpenTask?.(id)}
              onUnlink={(linkId) => onUnlinkChain?.(linkId)}
            />
            <MergeRequests
              mergeRequests={mergeRequests}
              onMarkRead={(id) => void window.api.invoke('gitlab:markRead', id)}
              onMarkEventsSeen={(id) => void window.api.invoke('gitlab:markEventsSeen', id)}
              onRename={(id, name) =>
                void window.api.invoke('gitlab:setMergeRequestName', id, name)
              }
            />
          </>
        )}
      </div>

      {error && (
        <div className={styles.inset}>
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        </div>
      )}

      <div className={styles.scroll} ref={scrollRef}>
        {turns.length === 0 && !managedByAI ? (
          <Caption1 className={styles.empty}>
            Nothing said yet — write a note, or send the agent a message.
          </Caption1>
        ) : (
          <ChatTurns
            turns={turns}
            statusKeywords={statusKeywords}
            onDeleteNote={(id) => void deleteComment(id)}
          />
        )}
      </div>

      {/* The bottom band. The live state sits ABOVE the composer inside it, so it never
          scrolls out of sight: the agent itself, then a row per sub-agent it is still
          waiting on. */}
      <div className={styles.footBand}>
        {managedByAI && (
          <div className={styles.runState}>
            <div className={styles.running}>
              {/* The spinner turns only while something MOVES; a card waiting on you gets
                  the words without the motion, because a spinner over "Waiting for you"
                  says the opposite of what is true. */}
              {run.spinner && <Spinner size="tiny" />}
              {/* `run.label`, never a hardcoded fallback: this band only renders for
                  running/starting/waiting, and every one of those carries a label. A
                  fallback here could only ever be a claim the phase had already denied —
                  which is how "Agent running" came to sit under a card that was not. */}
              <Caption1 className={styles.runningLabel}>{run.label}</Caption1>
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

        <Composer
          task={task}
          agentProject={agentProject}
          chat={chat}
          stepCaption={
            chat?.offered && chatStepPosition !== null
              ? `Talking to step ${chatStepPosition} of ${subtasks.length} — ${chat.target.title}`
              : null
          }
          value={comment}
          onChange={setComment}
          busy={busy}
          isJira={isJira}
          onSearchPeople={(q) => window.api.invoke('jira:searchUsers', task.id, q)}
          onPickAttachments={() => window.api.invoke('jira:pickAttachments')}
          onSendChat={() => void sendChat()}
          onAddNote={() => void addComment()}
          onPostStatus={() => void postStatus()}
          onAddJiraComment={() => void addJiraComment()}
          onAgentOptions={(options) => void setAgentOptions(options)}
        />
      </div>
    </div>
  );
}
