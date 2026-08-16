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
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';
import type { Project, Task, TaskActivityEntry } from '@tm/shared/model';
import type { MergeRequest } from '@tm/shared/mergeRequest';
import type { TaskAttachment } from '@tm/shared/attachments';
import type { TaskLink } from '@tm/shared/taskChain';
import type { SessionEvent } from '@tm/shared/session';
import { chainNeedsAttention, chatTarget } from '@tm/shared/board';
import type { StatusKeyword } from '@tm/shared/statusKeywords';
import type { PriorityDisplay } from '@tm/shared/settings';
import {
  ChevronLeftRegular,
  ChevronDownRegular,
  CollectionsEmptyRegular,
  AlertOffRegular,
} from '@fluentui/react-icons';
import { runningSubAgents } from './agentActivity';
import { stepPosition } from './board/boardColumns';
import { typeIcon } from './board/TaskCard';
import { ChatTurns } from './chat/ChatTurns';
import { Composer, type ComposerBusy } from './chat/Composer';
import { foldTurns } from './chat/turns';
import { EMPTY_COMPOSER, type ComposerValue } from './chat/mentions';
import { draftKey, useDraft } from './drafts';
import { MergeRequests } from './MergeRequests';
import { TaskChain } from './TaskChain';
import { StepBrief, TaskSteps } from './TaskSteps';
import { TaskAgentPanel } from './TaskAgentPanel';
import { TaskDetailsCell } from './TaskDetailsCell';
import { chatAvailability, REFUSAL_HINT } from './taskChat';
import { TrackerMark, shortTicketKey, trackerName, trackerOf } from './tracker';
import { runPhase } from '@tm/shared/board';
import { useTransport } from './transport';
import type { AttentionIndex } from './attentionIndex';

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
   * The read-only notice, ABOVE the band rather than below it: it qualifies everything in
   * the pane, so it has to be read before any of it. Same inset, with its own top padding
   * since nothing sits above it to provide one.
   */
  notice: { padding: '12px 12px 0' },
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
   * Wraps the scrolling conversation so the "new messages" pill (below) can be
   * positioned against it without affecting layout — the pill floats over the
   * conversation, it does not take a row of its own.
   */
  scrollWrap: { position: 'relative', flex: 1, minHeight: 0 },
  /**
   * The conversation: unframed, on the pane's own surface, and the ONLY thing that
   * scrolls — the details band above and the composer below stay put however long the
   * chat gets.
   */
  scroll: {
    height: '100%',
    overflowY: 'auto',
    padding: '10px 12px',
  },
  /**
   * Teams-style "new messages" pill: appears only once a message has landed while the
   * reader was scrolled up reading something older, so it never nags someone who is
   * already caught up. Floats over the conversation's bottom edge rather than pushing
   * the composer around.
   */
  newMessages: {
    position: 'absolute',
    bottom: '10px',
    left: '50%',
    transform: 'translateX(-50%)',
    boxShadow: tokens.shadow8,
  },
  /**
   * **Dismiss**, immediately above the State dropdown it belongs beside. Only ever drawn
   * for a card that is actually shouting, so it is not a control you have to learn — it
   * appears exactly when there is something to hush, and goes when there isn't.
   *
   * Right-aligned and subtle: this silences signals, it does not change the card, and it
   * must not compete with the state controls under it.
   */
  dismissRow: { display: 'flex', justifyContent: 'flex-end' },
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
  /**
   * The files hung off the task being shown — its slice of the board's attachment list.
   * The board holds that list whole (see `attachment:changed`), so what arrives here is
   * already narrowed to this task and the pane never has to ask.
   */
  attachments?: readonly TaskAttachment[];
  /**
   * The PARENT card's files, when a step is shown — a step's brief may cite them too, so
   * the mockup attached once to the card is nameable from every step of its plan. Empty
   * for an ordinary card, which has no parent to inherit from.
   */
  parentAttachments?: readonly TaskAttachment[];
  /** The status-note vocabulary, so a past update reads in the colour the board gave it. */
  statusKeywords?: readonly StatusKeyword[];
  /** How the board draws priority, so this pane draws it the same way. */
  priorityDisplay?: PriorityDisplay;
  /**
   * Why this pane's controls will not do anything, for a host that cannot back them — one
   * sentence, drawn as a warning bar above the card (the web app's, whose transport relays
   * only a status change and a new card; see `apps/web/src/board/httpTransport.ts`).
   *
   * A sentence rather than a `disabled` sweep because the pane degrades by prop ABSENCE
   * already — a host that passes no merge requests, no chain and no attention index simply
   * never renders those sections — and what is left looks live until it is pressed. That
   * difference, between read-only and broken, is the whole job of this prop; the refusal a
   * press earns is real, but it arrives too late to be an explanation.
   *
   * Absent on the desktop, which can do all of it.
   */
  readOnlyNotice?: string;
  /**
   * The board's single attention index. Passed in rather than subscribed to here: this
   * pane and the agent panel inside it were each mounting their own subscription, holding
   * two copies of the same state that could disagree.
   */
  attention?: AttentionIndex;
  /** Task ids the engine has a live run for, so the pane can show a spawning run. */
  liveRunTaskIds?: ReadonlySet<string>;
  /**
   * Task ids whose branch is being merged, so Merge shows a spinner instead of looking
   * like a button that did nothing — and so the timeline is re-read when the merge lands,
   * since its outcome note is written straight to the DB and never streamed.
   */
  mergingTaskIds?: ReadonlySet<string>;
  /**
   * The chained predecessors this card is still waiting on (`blockedBy`) — what the agent
   * panel's **Release now** override is offered against. Empty or absent for a card that is
   * not blocked, which is the only reason the button is not there.
   */
  chainWaitingOn?: readonly Task[];
  /**
   * The subset of {@link chainWaitingOn} waiting on nothing but a merge (`awaitingMerge`) —
   * what the agent panel offers a **Merge** button for. From the board's index, so the
   * card's chip and this pane's button can never disagree about which card that is.
   */
  chainMergeHeld?: readonly Task[];
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
  attachments = [],
  parentAttachments = [],
  statusKeywords,
  priorityDisplay = 'color',
  readOnlyNotice,
  attention,
  liveRunTaskIds,
  mergingTaskIds,
  chainWaitingOn,
  chainMergeHeld,
  chainLinks = [],
  chainTasksById = NO_TASKS,
  onUnlinkChain,
  onOpenTask,
  onStatusChanged,
  onSubtasksChanged,
}: TaskDetailProps): JSX.Element {
  const transport = useTransport();
  const styles = useStyles();
  const [activity, setActivity] = useState<TaskActivityEntry[]>([]);
  /** The linked ticket's own thread — JIRA's or GitHub's — fetched live, never stored. */
  const [ticketComments, setTicketComments] = useState<TaskActivityEntry[]>([]);
  const [liveEvents, setLiveEvents] = useState<TaskActivityEntry[]>([]);
  /**
   * Which write is in flight, so the button actually pressed is the one that answers — see
   * {@link ComposerBusy}. `'other'` covers this pane's own actions the composer knows
   * nothing about (dismissing the attention ring).
   */
  const [busy, setBusy] = useState<ComposerBusy>(null);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id ?? null;
  /**
   * WHICH tracker this card belongs to, or null for a card that is nobody's ticket.
   *
   * Every ticket call below is a pair now — `jira:fetchComments`/`github:fetchComments`, the
   * two @mention pickers, the two comment posts — so the thing the pane needs is not "is this
   * JIRA" but "whose issue is it", which is also what the composer's button and the key badge
   * above have to say. The narrowing itself lives in `./tracker` with the mark and the name,
   * because a pane that decided the tracker one way and drew it another is the bug.
   */
  const tracker = task ? trackerOf(task) : null;
  /**
   * JIRA in particular: files. Uploading one is a JIRA-only route — GitHub has no REST
   * endpoint for attaching a file to an issue at all — so the attach button belongs to one
   * tracker rather than to any ticket.
   */
  const isJira = tracker === 'jira';

  /**
   * The composer's whole value: what was typed, who is named in it, and what is attached.
   * Only the JIRA path uses the last two; the other three actions read `.text`.
   *
   * A draft, so a half-written message survives glancing at another card — the mechanism
   * this pane invented and now shares with every other editable field (`./drafts`). "Empty"
   * for a composer is no text *and* no files: a message that is only an attachment is still
   * worth coming back to.
   */
  const composer = useDraft<ComposerValue>(
    taskId === null ? null : draftKey(taskId, 'comment'),
    EMPTY_COMPOSER,
    (v) => !v.text.trim() && v.attachments.length === 0,
  );
  const comment = composer.value;

  const loadActivity = useCallback(async () => {
    if (!taskId) {
      setActivity([]);
      setTicketComments([]);
      setLiveEvents([]);
      return;
    }
    // The reload already contains everything streamed so far (events are persisted as
    // they arrive), so drop the live buffer to avoid showing each line twice.
    setLiveEvents([]);
    // The one mount read that used to have no `.catch`, which mattered the moment this
    // channel started crossing a network: a rejection was an unhandled rejection AND left the
    // previously selected card's timeline on screen under the new card's title. An empty
    // timeline is the honest answer for a card whose history could not be fetched.
    setActivity(await transport.invoke('task:activity', taskId).catch(() => []));
    if (tracker) {
      // The ticket's comments are fetched live and merged in; failures shouldn't blank the
      // pane. Which channel is the only tracker-shaped thing here — both answer with the same
      // `TaskActivityEntry[]`, in the kind that names where each comment came from.
      const channel = tracker === 'github' ? 'github:fetchComments' : 'jira:fetchComments';
      setTicketComments(await transport.invoke(channel, taskId).catch(() => []));
    } else {
      setTicketComments([]);
    }
    // Opening the task clears its unread border — for ANY tracker, and outside the branch
    // above on purpose. The border is raised by whichever sync fetched the thread, so a card
    // whose comments this pane could not show would otherwise stay orange no matter how
    // many times you opened it.
    if (tracker) {
      await transport
        .invoke(tracker === 'github' ? 'github:markRead' : 'jira:markRead', taskId)
        .then((updated) => onStatusChanged?.(updated))
        .catch(() => undefined);
    }
  }, [taskId, tracker, onStatusChanged]);

  useEffect(() => {
    setError(null);
    void loadActivity();
  }, [loadActivity]);

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
    void transport
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
    const offTask = transport.on('task:changed', ({ task: changed, runId }) => {
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
    return transport.on('session:event', ({ runId, event }) => {
      if (!runIdRef.current || runId !== runIdRef.current) return;
      // Negative ids can't collide with the persisted rows' keys.
      setLiveEvents((prev) => [
        ...prev,
        { kind: 'event', id: -(prev.length + 1), event, createdAt: Date.now() },
      ]);
    });
  }, []);

  // The live stream above admits it lost lines — so stop trusting it and re-read the record.
  //
  // Nothing on the desktop emits this: an Electron IPC push does not drop events. It is for
  // the mirrored path (apps/web), where the events cross a poll loop that can fall behind and
  // a connection that can drop. A transcript three tool calls short looks exactly like one
  // where the agent did three fewer things, which is why the hole gets its own channel rather
  // than being left invisible. `loadActivity` replaces the timeline wholesale AND clears the
  // live buffer, so a line that arrived both ways is de-duplicated by the reload.
  useEffect(() => {
    return transport.on('session:gap', ({ runId }) => {
      if (!runIdRef.current || runId !== runIdRef.current) return;
      void reloadRef.current();
    });
  }, []);

  /**
   * A merge finished — re-read the timeline so its outcome appears without clicking away
   * and back.
   *
   * Both notes a merge writes ("Merging branch…", then what happened) go straight into the
   * DB and are never streamed, and the `task:changed` the outcome carries is ignored by the
   * reload above unless a RUN was live in this pane — which, for a branch merged long after
   * its agent stopped, it never was. So the merge leaving the set is the signal, and it is
   * the only one there is.
   */
  const wasMerging = useRef(false);
  const merging = Boolean(
    taskId && (mergingTaskIds?.has(taskId) || subtasks.some((s) => mergingTaskIds?.has(s.id))),
  );
  useEffect(() => {
    if (merging) {
      wasMerging.current = true;
      // The first note is already written, so pick it up now rather than only at the end.
      void reloadRef.current();
      return;
    }
    if (!wasMerging.current) return;
    wasMerging.current = false;
    void reloadRef.current();
  }, [merging, taskId]);

  // One chronological story: persisted activity + live JIRA comments + live output.
  // Nothing is filtered here — `foldTurns` decides what the conversation shows and what
  // collapses into a single "worked with N tools" line.
  const timeline = useMemo(
    () => [...activity, ...ticketComments, ...liveEvents].sort((a, b) => a.createdAt - b.createdAt),
    [activity, ticketComments, liveEvents],
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

  // Keep the newest turn in view as output streams — but only while the reader is
  // already at the bottom. Scrolled up to read something older, a jump would yank
  // them away from it; instead the pill below offers to go there on request (Teams'
  // rule for the same problem).
  const scrollRef = useRef<HTMLDivElement>(null);
  // Updated by `onScroll` below on every user scroll; read (not subscribed to) by the
  // turns effect so scrolling itself never re-renders the pane.
  const atBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevTaskIdRef = useRef<string | null>(null);
  const prevTurnCountRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A few px of slack: "at the bottom" shouldn't require pixel-perfect scrolling.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    atBottomRef.current = atBottom;
    if (atBottom) setHasNewMessages(false);
  }, []);

  useEffect(() => {
    // Switching cards always jumps to the newest turn — there is nothing "older" to
    // protect the reader from on a pane they just opened.
    const switchedTask = prevTaskIdRef.current !== taskId;
    prevTaskIdRef.current = taskId;
    const grew = turns.length > prevTurnCountRef.current;
    prevTurnCountRef.current = turns.length;

    if (switchedTask || atBottomRef.current) {
      scrollToBottom();
    } else if (grew) {
      setHasNewMessages(true);
    }
  }, [turns, subAgents, taskId, scrollToBottom]);

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
  const run = runPhase(task, subtasks, liveRunTaskIds, mergingTaskIds);
  const managedByAI =
    run.phase === 'running' ||
    run.phase === 'starting' ||
    run.phase === 'waiting' ||
    // A merge is not the agent, but it IS the card working — and the band above the
    // composer is the one place that says so in words.
    run.phase === 'merging';

  async function addComment(): Promise<void> {
    if (!task || !comment.text.trim()) return;
    setBusy('note');
    setError(null);
    try {
      await transport.invoke('task:addComment', task.id, comment.text.trim());
      composer.reset();
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** File the text as the card's headline. `onStatusChanged` puts it on the board. */
  async function postStatus(): Promise<void> {
    if (!task || !comment.text.trim()) return;
    setBusy('status');
    setError(null);
    try {
      onStatusChanged?.(await transport.invoke('task:setStatusNote', task.id, comment.text.trim()));
      composer.reset();
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Post the composed text on the linked ticket — JIRA's issue or GitHub's, decided by the
   * card and not by the button, which is why there is one function rather than two.
   *
   * The draft that goes over the wire is identical for both: the same text, the same mention
   * ranges. What each tracker then does with it (build an ADF document, or spell the mentions
   * as `@login` in Markdown) belongs to main, where the tracker's client already lives.
   */
  async function addTicketComment(): Promise<void> {
    // A comment that is only files is still a comment worth posting.
    if (!task || !tracker || (!comment.text.trim() && !comment.attachments.length)) return;
    setBusy('ticket');
    setError(null);
    try {
      await transport.invoke(
        tracker === 'github' ? 'github:addComment' : 'jira:addComment',
        task.id,
        {
          // Untrimmed: the mention ranges are offsets into THIS string, so trimming here
          // would silently move every one of them. Main trims the tail only.
          text: comment.text,
          mentions: comment.mentions.map((m) => ({
            start: m.start,
            end: m.end,
            id: m.accountId,
            displayName: m.displayName,
          })),
          // Only ever non-empty on a JIRA card — the attach button is offered nowhere else, and
          // `github:addComment` refuses a path rather than posting the words without the file.
          attachmentPaths: comment.attachments,
        },
      );
      composer.reset();
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
    setBusy('chat');
    setError(null);
    try {
      const result = await transport.invoke('task:chat', task.id, comment.text.trim());
      if (result.status === 'refused') {
        setError(REFUSAL_HINT[result.reason]);
        return;
      }
      composer.reset();
      await loadActivity();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Model / permission mode for the NEXT run (a live run keeps what it started with).
   *
   * `model: null` is passed straight through: it hands the card back to its agent project's
   * models, which is a different answer from "don't change the model" (`undefined`).
   */
  async function setAgentOptions(options: {
    model?: ClaudeModel | null;
    mode?: PermissionMode;
  }): Promise<void> {
    if (!task) return;
    setError(null);
    try {
      onStatusChanged?.(await transport.invoke('task:setAgentOptions', task.id, options));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteComment(id: number): Promise<void> {
    await transport.invoke('task:deleteComment', id);
    await loadActivity();
  }

  /**
   * Stop this card asking. One call silences every driver of the ring at once — the inbox
   * items on the card and its steps, the ticket's unread comments, its merge requests —
   * because "I have seen it" is one decision and the human should not have to work out
   * which of the five was ringing.
   */
  async function dismissAttention(): Promise<void> {
    if (!task) return;
    setBusy('other');
    setError(null);
    try {
      onStatusChanged?.(await transport.invoke('task:dismissAttention', task.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const isStep = Boolean(task.parentTaskId);
  /**
   * Whether this card is shouting — the board's own predicate, so the button appears for
   * exactly the cards that wear the ring and never for one that does not.
   *
   * No "and it isn't done" test of its own: `chainNeedsAttention` already returns false
   * for a card the human has closed, which is the point of this round's other half. A
   * second copy of that rule here is how the two would come to disagree.
   */
  const wantsAttention = chainNeedsAttention(task, subtasks, mergeRequests, attention?.taskIds);
  const position = isStep ? stepPosition(subtasks, task.id) : null;
  // Chatting with a card whose step is working talks to the step; say which one, since
  // otherwise the message would seem to go to the card you are looking at.
  const chatStepPosition =
    chat && chat.target.id !== task.id ? stepPosition(subtasks, chat.target.id) : null;
  const agentProject = agentProjects.find((p) => p.id === task.agentProjectId) ?? null;

  return (
    <div className={styles.root}>
      {/* Only over a card: on the empty pane there is no control to qualify, and a warning
          bar hanging over a blank sidebar would be the first thing this app said. */}
      {readOnlyNotice && (
        <div className={styles.notice}>
          <MessageBar intent="warning">
            <MessageBarBody>{readOnlyNotice}</MessageBarBody>
          </MessageBar>
        </div>
      )}
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
            {/* The ticket badge, and the one place this pane names the tracker out loud.
                "Open in JIRA" over a GitHub issue sends the human to the wrong tab, and the
                key itself is printed short (`#123`) with the whole `owner/repo#123` in the
                tooltip — the same bargain the card's footer badge strikes, so the two cannot
                read as two different tickets. */}
            {task.externalKey &&
              (task.externalUrl ? (
                <a
                  className={styles.key}
                  href={task.externalUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Open ${task.externalKey} in ${trackerName(task) ?? 'the tracker'}`}
                >
                  <Badge
                    appearance="outline"
                    color="informative"
                    icon={<TrackerMark task={task} size={12} />}
                  >
                    {shortTicketKey(task)}
                  </Badge>
                </a>
              ) : (
                <Badge
                  appearance="outline"
                  color="informative"
                  icon={<TrackerMark task={task} size={12} />}
                  title={task.externalKey}
                >
                  {shortTicketKey(task)}
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
          liveRunTaskIds={liveRunTaskIds}
          merging={merging}
          waitingOn={chainWaitingOn}
          mergeHeld={chainMergeHeld}
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
            attachments={attachments}
            parentAttachments={parentAttachments}
            onChanged={(updated) => {
              onStatusChanged?.(updated);
              onSubtasksChanged?.();
            }}
          />
        ) : (
          <>
            {/* Beside the state controls, because it is the other half of the same
                sentence: closing a card hushes it automatically, and this is how you
                hush one you are NOT closing — you have read the comment, you know the
                pipeline is red, and you are getting to it. */}
            {wantsAttention && (
              <div className={styles.dismissRow}>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={busy === 'other' ? <Spinner size="tiny" /> : <AlertOffRegular />}
                  disabled={busy !== null}
                  title="Stop this card asking — clears its inbox items, unread comments and merge-request alerts"
                  onClick={() => void dismissAttention()}
                >
                  {busy === 'other' ? 'Dismissing…' : 'Dismiss'}
                </Button>
              </div>
            )}
            <TaskDetailsCell
              task={task}
              agentProjects={agentProjects}
              attachments={attachments}
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
              onMarkRead={(id) => void transport.invoke('mr:markRead', id)}
              onMarkEventsSeen={(id) => void transport.invoke('mr:markEventsSeen', id)}
              onRename={(id, name) => void transport.invoke('mr:setMergeRequestName', id, name)}
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

      <div className={styles.scrollWrap}>
        <div className={styles.scroll} ref={scrollRef} onScroll={handleScroll}>
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
        {hasNewMessages && (
          <Button
            className={styles.newMessages}
            size="small"
            shape="rounded"
            appearance="primary"
            icon={<ChevronDownRegular />}
            iconPosition="after"
            onClick={() => scrollToBottom('smooth')}
          >
            New messages
          </Button>
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
          onChange={composer.set}
          busy={busy}
          tracker={tracker}
          onSearchPeople={(q) =>
            transport.invoke(
              tracker === 'github' ? 'github:searchUsers' : 'jira:searchUsers',
              task.id,
              q,
            )
          }
          // JIRA only, and the prop's absence is what hides the attach button: GitHub has no
          // API for putting a file on an issue, so offering the picker would collect paths
          // nothing could ever upload.
          onPickAttachments={isJira ? () => transport.invoke('jira:pickAttachments') : undefined}
          onSendChat={() => void sendChat()}
          onAddNote={() => void addComment()}
          onPostStatus={() => void postStatus()}
          onAddTicketComment={() => void addTicketComment()}
          onAgentOptions={(options) => void setAgentOptions(options)}
        />
      </div>
    </div>
  );
}
