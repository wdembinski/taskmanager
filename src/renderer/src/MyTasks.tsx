/**
 * My Tasks — the standalone personal Kanban board (Phase C).
 *
 * A board independent of code-projects: it holds your JIRA-synced tickets and
 * internal ad-hoc tasks side by side. Columns are To Do / In Progress / Blocked,
 * plus a toggleable Done. Drag a card between columns to change its status; for a
 * JIRA ticket that also transitions the real issue (TO DO → IN PROGRESS, or → Done),
 * while Blocked is internal-only and never touches JIRA. The selected card's status
 * and activity timeline show in the right pane (`TaskDetail`).
 *
 * The chain of execution is drawn over the top of it: arrows between cards (`ChainOverlay`),
 * drawn by dragging a card's handle, and a **Chain** toggle in the toolbar that reduces the
 * board to the selected card's chain and nothing else — see `focusIds`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Menu,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Switch,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArchiveRegular,
  ArrowRoutingRegular,
  BranchForkRegular,
  EyeRegular,
  PanelRightContractRegular,
  PanelRightExpandRegular,
} from '@fluentui/react-icons';
import { PERSONAL_PROJECT_ID, type Project, type Task } from '@shared/model';
import {
  DEFAULT_BOARD_DISPLAY,
  type AppSettings,
  type BoardDisplaySettings,
} from '@shared/settings';
import type { IpcEvents } from '@shared/ipc';
import type { MergeRequest } from '@shared/mergeRequest';
import type { TaskAttachment } from '@shared/attachments';
import {
  LINK_REFUSAL_MESSAGE,
  awaitingMerge,
  blockedBy,
  canLink,
  chainComponent,
  type LinkGate,
  type TaskLink,
} from '@shared/taskChain';
import { AddTaskDialog } from './AddTaskDialog';
import {
  ArchivedCardsDialog,
  archivedCards,
  archivedCountLabel,
  archivedCountTitle,
} from './ArchivedCardsDialog';
import { GitGraphPane } from './GitGraphPane';
import { PaneLoading } from './PaneLoading';
import { TaskDetail } from './TaskDetail';
import { useInitialLoad } from './useInitialLoad';
import { KanbanColumn } from './board/KanbanColumn';
import { ChainOverlay } from './board/ChainOverlay';
import { ChainLinkPopover } from './board/ChainLinkPopover';
import { arrowRoute } from './board/chainArrows';
import {
  isChainLinkDrag,
  linkDropStates,
  taskIdUnder,
  type LinkDragState,
} from './board/chainDrag';
import { useCardAnchors } from './board/useCardAnchors';
import { useAttentionIndex } from './useAttentionIndex';
import { useActiveRuns } from './useActiveRuns';
import { useIntegratingTasks } from './useIntegratingTasks';
import {
  COLUMN_META,
  columnForTask,
  focusCards,
  groupSubtasks,
  isRunStatus,
  sortCards,
  statusForColumn,
  visibleColumns,
} from './board/boardColumns';
import type { BoardCard, BoardColumn } from './board/boardColumns';

const useStyles = makeStyles({
  // No gap: the detail pane's own surface runs to the board's edge, and the change of
  // shade is the seam.
  root: { display: 'flex', minHeight: 0, flex: 1 },
  board: {
    // `auto` rather than a 60% basis: with the graph pane open there are THREE panes in this
    // row, and a board that insists on 60% of the window plus the detail pane's 40% plus the
    // graph's own width adds up to more than there is — so something would be squeezed by
    // whichever flex rule happened to lose. The board simply takes what the other two leave.
    flex: '1 1 auto',
    // The screen owns its insets now that the shell adds none, and only the board side
    // needs them — the detail pane runs to the window's edges on purpose.
    padding: '12px 16px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
    minWidth: 0,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  grow: { flex: 1 },
  // The whole board scrolls as one — not each column on its own — so the columns stay
  // aligned with each other while you scroll. A grid (rather than a flex row) is what
  // makes that work: the single auto row sizes to the *tallest* column, every column
  // stretches to it (so a short column is still a full-height drop target), and this
  // container is the only thing that scrolls.
  columns: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    // The containing block for the chain overlay (`ChainOverlay`), which is one `<svg>`
    // laid over the whole board. It had none, and this is exactly why one overlay is
    // possible at all: this is the ONLY scrolling element, so an absolutely-positioned
    // child of it shares the cards' coordinate space and scrolls with them. It changes
    // nothing about the columns themselves — an absolutely-positioned child of a grid
    // container is out of flow and never becomes a track of its own.
    position: 'relative',
    // Breathing room above the first card. Its 3px project stripe and its 3px attention
    // ring both live ON the card's top edge, and with the sticky header sitting directly
    // on top of the list they had nothing to breathe into.
    paddingTop: '4px',
  },
  right: {
    // Exactly 40%, whatever the card holds. `1 1 40%` let the pane grow past its basis:
    // a flex item's automatic minimum is its CONTENT's min-width, so a card with wide
    // content (a long MR title, a full stage row, the three pickers side by side) widened
    // the pane and squeezed the board — and the pane visibly changed size card to card.
    // `minWidth: 0` drops that automatic minimum and `flex-shrink: 0` holds the basis.
    flex: '0 0 40%',
    minWidth: 0,
    // Anything that still doesn't fit scrolls inside its own row (the chat, the code
    // blocks, the details cell) rather than spilling over the board.
    overflow: 'hidden',
    display: 'flex',
    minHeight: 0,
    // No inset: the detail pane's top band is full-bleed (it is a section of the pane,
    // not a card in it), so each of the pane's other rows carries its own padding.
    // One surface for the whole pane, a step LIGHTER than the board — that contrast is
    // what separates the two halves of the screen, so no dividing line is needed.
    backgroundColor: tokens.colorNeutralBackground1,
  },
  /**
   * The commit graph's pane. A fixed px basis rather than the detail pane's percentage: what
   * it holds is a fixed-width thing — a lane gutter, a subject, an author and a date — so a
   * share of the window would leave it either clipping every subject or padded with empty
   * space, depending only on how wide the monitor is. `0 0` so it neither grows nor shrinks,
   * and the board (`flex: 1 1 auto`) absorbs the difference.
   */
  graph: {
    flex: '0 0 340px',
    minWidth: 0,
    display: 'flex',
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    // A rule rather than a change of shade: with the detail pane open this sits against
    // another pane of the same surface, and two identical surfaces need an edge.
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

/**
 * The optimistic half of the main process's `humanStatusPatch`: where a status the human
 * just chose goes on THIS copy of the task, until the real one comes back.
 *
 * A card whose run has borrowed `status` gets the new state parked in `preRunStatus`, which
 * is what `columnForTask` reads — so the card jumps columns the instant you let go without
 * the spinner, the run strip or the attention ring flickering off and back on.
 */
function optimisticMove(task: Task, column: BoardColumn): Task {
  const status = statusForColumn(column);
  return isRunStatus(task.status) ? { ...task, preRunStatus: status } : { ...task, status };
}

export function MyTasks(): JSX.Element {
  const styles = useStyles();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // The repos a card can be delegated to — fetched once and shared by the cards
  // (glyph tooltip) and the detail pane (assign dialog).
  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` on purpose. A notice is the engine reporting a decision it took to
  // protect the board — "JIRA answered short, so nothing was removed" — not a failure. Shown
  // in its own bar because a warning dressed as an error is a bar people stop reading.
  const [notice, setNotice] = useState<IpcEvents['board:notice'] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /**
   * The cards that have LEFT the board — held here rather than fetched when the dialog opens,
   * because the toolbar button is only offered when there are some, and a count that only
   * became true once you clicked it would be no count at all.
   */
  const [archived, setArchived] = useState<Task[]>([]);
  /**
   * The removed CARDS. `board:archived` answers with rows, and a card's steps were archived
   * with it — see `archivedCards`, which is also why the toolbar's count is derived rather
   * than being `archived.length`.
   */
  const removedCards = useMemo(() => archivedCards(archived), [archived]);
  /**
   * When the Removed-cards dialog was opened, or null while it is closed.
   *
   * The timestamp rather than a boolean because the list's labels are relative ("yesterday")
   * and take `now` as an argument — read once, on opening, so the rows cannot re-word
   * themselves under the pointer on an unrelated re-render.
   */
  const [archivedOpenedAt, setArchivedOpenedAt] = useState<number | null>(null);
  // Merge requests for the WHOLE board in one array, not hung off each Task: a JIRA
  // sync rebuilds every task literal, so an array living there would be clobbered on
  // every poll. See the `gitlab:mergeRequests` contract.
  const [mergeRequests, setMergeRequests] = useState<MergeRequest[]>([]);
  /**
   * The chain's edges, held as their own list for exactly the reason the merge requests
   * are: a JIRA sync rebuilds every `Task` literal on every poll, so an arrow hung off a
   * task would be clobbered by the next one. The board derives whatever index it needs.
   */
  const [links, setLinks] = useState<TaskLink[]>([]);
  /**
   * Every attachment on the board, for the third time and the third reason: the pane that
   * shows a card's files is not the only thing that can change them (a step's brief shows
   * its own beside its parent's), and a JIRA sync would clobber anything hung off `Task`.
   * The board holds the flat list and hands each pane its slice.
   */
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  /**
   * The link being drawn right now — by dragging a card's handle, or armed from the
   * keyboard. Holds every card's verdict, computed once when the gesture starts (see
   * `linkDropStates`) rather than per card per `dragover`.
   */
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null);
  /** The arrow being edited: heavier, endpoints marked, and wearing the gate popover. */
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  /**
   * **Focus mode** — show only the selected card's chain.
   *
   * Local state rather than a saved setting, unlike the other toolbar switches: it is not a
   * preference about how cards are drawn but a lens on ONE card, and a board that came back
   * next launch showing three of your twenty cards, for a selection you no longer remember
   * making, would read as lost work rather than as a filter left on.
   */
  const [chainFocus, setChainFocus] = useState(false);
  /**
   * The whole inbox and the live-run set, subscribed ONCE here and passed down.
   *
   * Here rather than in the card because both the ring and the sort order read them, and
   * a per-card subscription would mean one round trip per card and N copies of a state
   * that must agree. See `useAttentionIndex` for the three bugs this replaced.
   */
  const attention = useAttentionIndex();
  const liveRuns = useActiveRuns();
  // The third of the same kind: which cards are having their branch merged. Nothing about
  // a merging task changes while it merges, so this is the only thing any surface has to
  // go on — see `useIntegratingTasks`.
  const merging = useIntegratingTasks();

  const showDone = settings?.jira.showDoneColumn ?? false;
  const jiraEnabled = settings?.jira.enabled ?? false;
  const currentSprintOnly = settings?.jira.currentSprintOnly ?? false;
  const gitlabEnabled = settings?.gitlab.enabled ?? false;
  const display = settings?.board ?? DEFAULT_BOARD_DISPLAY;
  const showDetail = settings?.showTaskDetail ?? true;
  // Off until the settings land, unlike the detail pane: the graph costs a `git log` on the
  // machine the project runs on, so guessing it ON would spawn one before we know it is wanted.
  const showGraph = settings?.showGitGraph ?? false;

  const refresh = useCallback(async () => {
    setTasks(await window.api.invoke('board:tasks'));
  }, []);

  // One seed load for every channel the board reads, so a failure in any of them is
  // reported rather than leaving the board on its spinner.
  const seed = useCallback(async () => {
    const [board, appSettings, repos, mrs, chain, files, gone] = await Promise.all([
      window.api.invoke('board:tasks'),
      window.api.invoke('settings:get'),
      window.api.invoke('agentProject:list'),
      window.api.invoke('gitlab:mergeRequests'),
      window.api.invoke('chain:links'),
      window.api.invoke('attachment:list'),
      window.api.invoke('board:archived'),
    ]);
    setTasks(board);
    setSettings(appSettings);
    setAgentProjects(repos);
    setMergeRequests(mrs);
    setLinks(chain);
    setAttachments(files);
    setArchived(gone);
  }, []);

  /**
   * Re-read the removed list. Cheap — one indexed query over a table the board has just been
   * read from anyway — and there is nothing to push it: a card leaves the board on a POLL, so
   * "the board changed" is the only signal there is that something might have left it.
   */
  const refreshArchived = useCallback(async () => {
    setArchived(await window.api.invoke('board:archived'));
  }, []);

  /** Put a removed card back, and take it out of the list it came from. */
  const restoreCard = useCallback(
    async (taskId: string) => {
      setTasks(await window.api.invoke('task:restore', taskId));
      await refreshArchived();
    },
    [refreshArchived],
  );

  const initial = useInitialLoad(seed);

  const patchTask = useCallback((task: Task) => {
    if (task.projectId !== PERSONAL_PROJECT_ID) return; // board shows only personal tasks
    setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
  }, []);

  // Live updates: single-task changes, and whole-board replacement after a sync/add.
  // Plus the settings the ENGINE writes: dragging a card teaches it what a JIRA status
  // means, and this screen saves the whole settings blob (the two switches above), so
  // the learned map has to come back or the next toggle would write over it.
  useEffect(() => {
    const offTask = window.api.on('task:changed', ({ task }) => patchTask(task));
    const offTasks = window.api.on('project:tasksChanged', ({ projectId, tasks: next }) => {
      if (projectId !== PERSONAL_PROJECT_ID) return;
      setTasks(next);
      // A card leaving the board is a whole-board change and nothing else — there is no
      // per-card event for it, because from the card's own point of view nothing happened.
      // So the removed list is re-read alongside: it is the one moment it can have changed.
      void refreshArchived();
    });
    const offSettings = window.api.on('settings:changed', (next) => {
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              jira: {
                ...prev.jira,
                learnedStatusColumns: next.jira.learnedStatusColumns,
                lastCreateProjectKey: next.jira.lastCreateProjectKey,
                lastCreateIssueTypeId: next.jira.lastCreateIssueTypeId,
              },
            }
          : prev,
      );
    });
    const offMrs = window.api.on('gitlab:mergeRequestsChanged', setMergeRequests);
    // The whole list, replaced — a link can also vanish because its CARD was deleted and
    // the row cascaded away, which no per-link patch would ever hear about.
    const offLinks = window.api.on('chain:changed', setLinks);
    // Ditto, and one more reason on top: an attachment also vanishes when its CARD is
    // deleted and the row cascades away, which no per-file patch would hear about.
    const offAttachments = window.api.on('attachment:changed', setAttachments);
    // Pushed by a sync that kept cards it could not confirm had left. It arrives from the
    // POLLER as often as from the button, so it cannot be the return value of `sync()`.
    const offNotice = window.api.on('board:notice', setNotice);
    return () => {
      offTask();
      offTasks();
      offSettings();
      offMrs();
      offLinks();
      offAttachments();
      offNotice();
    };
  }, [patchTask, refreshArchived]);

  const selectedTask = useMemo(
    () => tasks?.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  /**
   * taskId → its files, so each pane gets its own slice and nothing downstream filters a
   * whole-board list per render. Built the same way `mrsByTask` is, and for the same
   * reason — the list arrives flat because that is the only shape a sync cannot clobber.
   */
  const attachmentsByTask = useMemo(() => {
    const map = new Map<string, TaskAttachment[]>();
    for (const attachment of attachments) {
      const list = map.get(attachment.taskId);
      if (list) list.push(attachment);
      else map.set(attachment.taskId, [attachment]);
    }
    return map;
  }, [attachments]);

  /** taskId → its merge requests, so a card can be built in one pass. */
  const mrsByTask = useMemo(() => {
    const map = new Map<string, MergeRequest[]>();
    for (const mr of mergeRequests) {
      if (!mr.taskId) continue; // an orphan: its ticket is not on this board
      const list = map.get(mr.taskId);
      if (list) list.push(mr);
      else map.set(mr.taskId, [mr]);
    }
    return map;
  }, [mergeRequests]);

  /**
   * The ids focus mode allows through — the selected card, everything upstream of it and
   * everything downstream — or null when the board is showing everything.
   *
   * Null rather than "every id on the board": the filter below is then a no-op in the
   * ordinary case, and focus with nothing selected (which the toggle disables, though a
   * deleted card could still get you there) reads as no filter rather than as an empty
   * board. The component is undirected — see `chainComponent` — because the question focus
   * asks is "show me this piece of work and everything it is entangled with", which is not
   * the same as the ROUTE the arrows light, and a card that branches off a shared
   * predecessor belongs on the board you are using to reason about it.
   *
   * The columns are the board's real ones throughout: a chain is not a pipeline of its own,
   * and its cards sit exactly where their status puts them.
   */
  const focusIds = useMemo(
    () => (chainFocus && selectedTaskId ? chainComponent(links, selectedTaskId) : null),
    [chainFocus, selectedTaskId, links],
  );

  const cardsByColumn = useMemo(() => {
    const map: Record<BoardColumn, BoardCard[]> = {
      todo: [],
      'in-progress': [],
      'in-review': [],
      blocked: [],
      done: [],
    };
    // A card's steps are not cards of their own — they render inside the parent and
    // travel with it, whatever their own status. `focusCards` then narrows the board to
    // the selected card's chain, or passes everything through when focus is off.
    for (const card of focusCards(groupSubtasks(tasks ?? [], mrsByTask), focusIds)) {
      map[columnForTask(card.task)].push(card);
    }
    // Cards that want you first, then by priority — see `sortCards`. The inbox's ids go
    // in too: the ordering and the orange ring are the same predicate on purpose, so
    // passing it to the card and not to the sort would have the two disagree.
    for (const col of Object.keys(map) as BoardColumn[])
      map[col] = sortCards(map[col], attention.taskIds);
    return map;
  }, [tasks, mrsByTask, attention.taskIds, focusIds]);

  /**
   * Where every card is, for the chain overlay's arrows — plus which card the pointer is
   * over, which only this hook is in a position to know cheaply (see `useCardAnchors`).
   *
   * `cardsByColumn` is the revision it re-measures on: re-sorting a column moves cards
   * without resizing anything, so no observer would otherwise see it.
   */
  const anchors = useCardAnchors(cardsByColumn);

  /** id → task for the whole board, so an arrow can ask its gate about the predecessor. */
  const tasksById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  /**
   * Where each chained card stands: what it is still waiting on, which of those are waiting
   * only on a human to merge, and whether its turn has come without anything having started.
   *
   * Computed once for the board rather than per card, and only for cards that actually have
   * an arrow into them — `readyToRelease` is vacuously true for everything else, so asking
   * per card would have every unchained card on the board answering a question about a
   * feature nobody used on it.
   *
   * `ready` matches the ENGINE's own release condition (never run, still waiting in To Do):
   * the chip has to mean "the engine would have started this", or a card that shows `ready`
   * and then sits there teaches the human to distrust the word.
   */
  const chainStates = useMemo(() => {
    const byTask = new Map<string, { waitingOn: Task[]; mergeHeld: Task[]; ready: boolean }>();
    for (const id of new Set(links.map((l) => l.toTaskId))) {
      const task = tasksById.get(id);
      if (!task) continue;
      const waitingOn = blockedBy(task, links, tasksById);
      byTask.set(id, {
        waitingOn,
        // A subset of `waitingOn`, derived from the same links in the same pass, so the
        // chip's noun and its verb can never come from two different readings of the board.
        mergeHeld: awaitingMerge(task, links, tasksById),
        ready: waitingOn.length === 0 && task.status === 'pending' && !task.sessionId,
      });
    }
    return byTask;
  }, [links, tasksById]);

  /**
   * The chain the selected task belongs to: a card's own steps, or — when a step is
   * selected — its siblings, so the detail pane can say "step 2 of 5" and offer the
   * way back to the parent.
   */
  const chain = useMemo(() => {
    if (!selectedTask) return [];
    const parentId = selectedTask.parentTaskId ?? selectedTask.id;
    return (tasks ?? [])
      .filter((t) => t.parentTaskId === parentId)
      .sort((a, b) => a.order - b.order);
  }, [tasks, selectedTask]);

  const parentOfSelected = useMemo(
    () =>
      selectedTask?.parentTaskId
        ? (tasks?.find((t) => t.id === selectedTask.parentTaskId) ?? null)
        : null,
    [tasks, selectedTask],
  );

  /** Cards a hand-written step can be added under: every top-level card on this board. */
  const parentCandidates = useMemo(() => (tasks ?? []).filter((t) => !t.parentTaskId), [tasks]);

  const setShowDone = useCallback((value: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, jira: { ...prev.jira, showDoneColumn: value } };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  /**
   * The card's optional lines. Saved through the whole settings blob like the other board
   * switches, so the Display menu and the Settings page are two views of one value rather
   * than two places that can disagree.
   */
  const saveDisplay = useCallback((board: BoardDisplaySettings) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, board };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  const setShowDetail = useCallback((value: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, showTaskDetail: value };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  /** The commit-graph pane, saved the same optimistic way the detail pane's fold is. */
  const setShowGraph = useCallback((value: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, showGitGraph: value };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  /**
   * Refresh every service that is switched on, not just JIRA.
   *
   * The button said "Sync JIRA" while GitLab was only ever refreshed by its own poll, so
   * merge-request rows sat stale — an MR approved minutes ago still showed as waiting,
   * and pressing the only visible Sync did nothing about it.
   *
   * `allSettled`: one service being unreachable must not stop the other from refreshing,
   * and the failures are reported together rather than the first one winning.
   */
  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    // The last sync's notice describes the last sync. This one will push its own if the
    // condition is still there, so clearing it here is what stops a warning about a
    // truncated fetch outliving the fetch that was truncated.
    setNotice(null);
    try {
      const [jira, gitlab] = await Promise.allSettled([
        jiraEnabled ? window.api.invoke('jira:sync') : Promise.resolve(null),
        gitlabEnabled ? window.api.invoke('gitlab:sync') : Promise.resolve(null),
      ]);
      if (jira.status === 'fulfilled' && jira.value) setTasks(jira.value);
      if (gitlab.status === 'fulfilled' && gitlab.value) setMergeRequests(gitlab.value);
      const failures = [jira, gitlab]
        .flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
        .map((e) => (e instanceof Error ? e.message : String(e)));
      if (failures.length > 0) setError(failures.join(' · '));
    } finally {
      setSyncing(false);
    }
  }, [jiraEnabled, gitlabEnabled]);

  // Unlike "Show Done", which only hides a column that is already loaded, this one
  // changes the JQL the next fetch runs — so the board is re-synced immediately,
  // otherwise the switch would appear to do nothing until the next poll.
  const setCurrentSprintOnly = useCallback(
    async (value: boolean) => {
      if (!settings) return;
      const next = { ...settings, jira: { ...settings.jira, currentSprintOnly: value } };
      setSettings(next);
      await window.api.invoke('settings:save', next);
      if (next.jira.enabled) await sync();
    },
    [settings, sync],
  );

  const moveTask = useCallback(
    async (taskId: string, column: BoardColumn) => {
      const task = tasks?.find((t) => t.id === taskId);
      if (!task || columnForTask(task) === column) return;
      setError(null);
      const prev = task;
      patchTask(optimisticMove(task, column)); // optimistic
      try {
        patchTask(await window.api.invoke('task:move', taskId, column));
      } catch (e) {
        patchTask(prev); // rollback (e.g. JIRA transition unavailable)
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [tasks, patchTask],
  );

  /**
   * Stop the agent working a card, from the card itself.
   *
   * NOT optimistic, unlike the move above: stopping a run is the engine's to do, it can
   * take the length of an IPC hop plus a process dying, and the steps it cancels along the
   * way are rows this board also draws. Painting a guess would mean guessing at all of
   * them. The task that comes back is the truth, and `task:changed` brings the rest.
   *
   * One call covers the whole card — `stopTask` stops the card AND its steps, which is
   * what makes a single button on the card the right shape for a chain.
   */
  const stopTask = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        patchTask(await window.api.invoke('task:stopAgent', taskId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [patchTask],
  );

  /**
   * Draw an arrow — `toTaskId` runs after `fromTaskId`.
   *
   * The same confirm-free optimistic shape `moveTask` uses: the arrow appears the instant
   * you let go, and un-draws itself with a message if the main process disagrees. Drawing
   * a link is trivially reversible (select it, press Delete), so making you wait on a round
   * trip to see whether it worked would be charging for a certainty you already have.
   *
   * The refusal is asked TWICE on purpose. Here, so the message names what went wrong
   * without a round trip; and again in the handler, against the real rows — this copy of
   * the board can be a poll behind, and a cycle that slips past is a chain that never runs.
   */
  const drawLink = useCallback(
    async (fromTaskId: string, toTaskId: string) => {
      setLinkDrag(null);
      const refusal = canLink(links, tasksById.get(fromTaskId), tasksById.get(toTaskId));
      if (refusal) {
        setError(`Can't chain those two — ${LINK_REFUSAL_MESSAGE[refusal]}.`);
        return;
      }
      setError(null);
      const prev = links;
      // A stand-in id until the real row comes back a frame later. Namespaced rather than
      // random because it CAN be addressed in that frame — click the new arrow fast enough
      // and Delete would send this id — and `chain:unlink` on an id no row has is a no-op
      // that returns the true list, so the board corrects itself either way. A UUID here
      // would look like a real id in a log without behaving any better.
      const optimistic: TaskLink = {
        id: `pending:${fromTaskId}:${toTaskId}`,
        fromTaskId,
        toTaskId,
        // The strict gate is the default — see `LinkGate`. Change it in the popover.
        gate: 'after-merge',
        createdAt: Date.now(),
      };
      setLinks([...prev, optimistic]);
      try {
        const result = await window.api.invoke('chain:link', fromTaskId, toTaskId, 'after-merge');
        if (result.status === 'refused') {
          setLinks(prev);
          setError(`Can't chain those two — ${LINK_REFUSAL_MESSAGE[result.reason]}.`);
          return;
        }
        setLinks(result.links);
      } catch (e) {
        setLinks(prev);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [links, tasksById],
  );

  const removeLink = useCallback(
    async (linkId: string) => {
      const prev = links;
      setSelectedLinkId(null);
      setLinks(prev.filter((l) => l.id !== linkId)); // optimistic
      try {
        setLinks(await window.api.invoke('chain:unlink', linkId));
      } catch (e) {
        setLinks(prev); // rollback
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [links],
  );

  const setLinkGate = useCallback(
    async (linkId: string, gate: LinkGate) => {
      const prev = links;
      setLinks(prev.map((l) => (l.id === linkId ? { ...l, gate } : l))); // optimistic
      try {
        setLinks(await window.api.invoke('chain:setGate', linkId, gate));
      } catch (e) {
        setLinks(prev); // rollback
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [links],
  );

  /**
   * Start a link, or — when one is already armed from the keyboard — cancel it. The handle
   * is a button, so Enter and Space arrive here as a click.
   */
  const armLink = useCallback(
    (taskId: string) => {
      setSelectedLinkId(null);
      setLinkDrag((at) =>
        at?.fromTaskId === taskId
          ? null
          : {
              fromTaskId: taskId,
              // The same verdicts the drag shows, so an armed board marks its valid,
              // already-linked and refused cards exactly as a dragged one does. `at: null`
              // is the whole difference — there is no pointer, so there is no band.
              states: linkDropStates(links, tasks ?? [], taskId),
              at: null,
              overTaskId: null,
            },
      );
    },
    [links, tasks],
  );

  /**
   * Picking a card. While a link is ARMED (the keyboard path, which has no drop) the next
   * card you pick is the successor rather than the card you wanted to read — the one modal
   * moment in the board, which is why Escape and a second press on the handle both leave it.
   */
  const selectTask = useCallback(
    (id: string) => {
      setSelectedLinkId(null);
      if (linkDrag && linkDrag.at === null && linkDrag.fromTaskId !== id) {
        void drawLink(linkDrag.fromTaskId, id);
        return;
      }
      setLinkDrag(null);
      setSelectedTaskId(id);
    },
    [linkDrag, drawLink],
  );

  /** The selected arrow, and the point on its curve the gate popover hangs from. */
  const selectedLink = useMemo(
    () => links.find((l) => l.id === selectedLinkId) ?? null,
    [links, selectedLinkId],
  );
  const selectedLinkAt = useMemo(() => {
    if (!selectedLink) return null;
    const from = anchors.rects.get(selectedLink.fromTaskId);
    const to = anchors.rects.get(selectedLink.toTaskId);
    // An endpoint the board is not showing has a stub rather than an arrow, and a stub is
    // a fact about the FILTER — there is no curve to hang a gate picker on.
    if (!from || !to) return null;
    return arrowRoute(from, to, anchors.bounds.width).mid;
  }, [selectedLink, anchors.rects, anchors.bounds.width]);

  // Delete or Backspace erases the selected arrow, Escape lets it go. On the window rather
  // than on the path, because an SVG `<path>` cannot hold focus — and never while the caret
  // is in a field, where Backspace means "delete a character" and always will.
  useEffect(() => {
    if (!selectedLinkId) return;
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable) return;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key === 'Escape') {
        setSelectedLinkId(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Backspace is "go back" in a browser and nothing at all here; take it either way.
        e.preventDefault();
        void removeLink(selectedLinkId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLinkId, removeLink]);

  // The way out of an armed link for anyone who armed it and changed their mind. A DRAG
  // needs none of this — Escape cancels it in the browser and `dragend` still fires.
  useEffect(() => {
    if (!linkDrag || linkDrag.at !== null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLinkDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkDrag]);

  if (tasks === null) {
    return (
      <PaneLoading
        label="Loading tasks…"
        error={initial.error}
        onRetry={initial.retry}
        shape="board"
      />
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.board}>
        <div className={styles.toolbar}>
          <Switch
            label="Show Done"
            checked={showDone}
            onChange={(_e, d) => setShowDone(d.checked)}
          />
          {jiraEnabled && (
            <Switch
              label="Current sprint"
              checked={currentSprintOnly}
              disabled={syncing}
              onChange={(_e, d) => void setCurrentSprintOnly(d.checked)}
            />
          )}
          <span className={styles.grow} />
          {/* Focus the board on ONE route through it: the selected card, everything it
              waits for and everything waiting on it. A busy board is where a chain is
              hardest to follow and where you most need to — this reduces it to the piece
              of work you are actually reasoning about, in the board's own columns.

              A `ToggleButton` rather than an accent-filled one: an on-state is a fact about
              the VIEW, and this board spends colour only on things that move (the running
              band, the travelling dash). Its pressed shade says it without borrowing that.

              `disabledFocusable` rather than `disabled`: focus follows the selection, so
              with nothing selected the control has something to SAY, and a plainly
              disabled button can be neither hovered for its tooltip nor tabbed to. */}
          <ToggleButton
            size="small"
            appearance="subtle"
            icon={<ArrowRoutingRegular />}
            checked={chainFocus}
            disabledFocusable={!selectedTaskId}
            title={
              !selectedTaskId
                ? 'Pick a card first — focus follows the selected card’s chain'
                : chainFocus
                  ? 'Showing this card’s chain only — click for the whole board'
                  : 'Show only this card’s chain: what it waits for, and what waits on it'
            }
            onClick={() => setChainFocus((v) => !v)}
          >
            Chain
          </ToggleButton>
          {/* The card's optional lines, switchable HERE as well as in Settings — this is
              where you actually notice the noise, and a trip to Settings to quiet a board
              you are looking at is a trip most people won't make. */}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<EyeRegular />}>
                Display
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList
                checkedValues={{
                  display: [
                    ...(display.showLabels ? ['labels'] : []),
                    ...(display.showProjectName ? ['project'] : []),
                    ...(display.showEpicName ? ['epic'] : []),
                  ],
                }}
                onCheckedValueChange={(_e, { checkedItems }) =>
                  void saveDisplay({
                    ...display,
                    showLabels: checkedItems.includes('labels'),
                    showProjectName: checkedItems.includes('project'),
                    showEpicName: checkedItems.includes('epic'),
                  })
                }
              >
                <MenuItemCheckbox name="display" value="labels" disabled={!settings}>
                  JIRA labels
                </MenuItemCheckbox>
                <MenuItemCheckbox name="display" value="project" disabled={!settings}>
                  Project name
                </MenuItemCheckbox>
                <MenuItemCheckbox name="display" value="epic" disabled={!settings}>
                  Epic
                </MenuItemCheckbox>
              </MenuList>
            </MenuPopover>
          </Menu>
          {/* What actually happened in the repo, beside what the board believes about it.
              The same kind of control as the fold beside it — a view, not a filter — and off
              by default, because it costs a `git log` on the project it is pointed at. */}
          <Button
            size="small"
            appearance="subtle"
            icon={<BranchForkRegular />}
            title={showGraph ? 'Hide the commit graph' : 'Show the repository’s commit graph'}
            aria-label={showGraph ? 'Hide the commit graph' : 'Show the commit graph'}
            aria-pressed={showGraph}
            onClick={() => setShowGraph(!showGraph)}
          />
          {/* Fold the detail pane away. An icon button rather than a third switch: this
              one is a view control, not a filter on what the board contains. */}
          <Button
            size="small"
            appearance="subtle"
            icon={showDetail ? <PanelRightContractRegular /> : <PanelRightExpandRegular />}
            title={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
            aria-label={showDetail ? 'Hide the detail pane' : 'Show the detail pane'}
            aria-pressed={showDetail}
            onClick={() => setShowDetail(!showDetail)}
          />
          {/* What is NOT on the board. Rendered only when something has left it: on a healthy
              board this is an empty list, and a permanent button for an empty list is a
              permanent invitation to check whether anything has gone missing.

              The bare count, because the archive glyph beside it already supplies the noun —
              and no colour, no badge: these are cards that are not moving, and a count that
              demanded attention would make an ordinary sync look like an incident. */}
          {removedCards.length > 0 && (
            <Button
              size="small"
              appearance="subtle"
              icon={<ArchiveRegular />}
              title={archivedCountTitle(removedCards.length)}
              aria-label={archivedCountTitle(removedCards.length)}
              onClick={() => setArchivedOpenedAt(Date.now())}
            >
              {archivedCountLabel(removedCards.length)}
            </Button>
          )}
          {/* One button for every enabled service — it was called "Sync JIRA" while also
              refreshing GitLab, which made the merge-request rows look stale on purpose. */}
          {(jiraEnabled || gitlabEnabled) && (
            <Button size="small" disabled={syncing} onClick={() => void sync()}>
              {syncing ? 'Syncing…' : 'Sync'}
            </Button>
          )}
          <Button size="small" appearance="primary" onClick={() => setAddOpen(true)}>
            Add task…
          </Button>
        </div>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" appearance="transparent" onClick={() => setError(null)}>
                Dismiss
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {notice && (
          <MessageBar intent={notice.intent}>
            <MessageBarBody>{notice.text}</MessageBarBody>
            <MessageBarActions>
              <Button size="small" appearance="transparent" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {/*
          The drag state is cleared HERE, not only on the card. A card dropped into
          another column is re-parented by the optimistic patch below, so React unmounts
          the node the drag started on and its `dragend` never reaches the root — the
          card would keep `styles.dragging` (half opacity) until the next drag. This
          container never unmounts, so it also catches an ESC-cancelled drag and a drop
          back into the column the card came from, both of which leaked the same state.
        */}
        <div
          ref={anchors.containerRef}
          className={styles.columns}
          onDragEnd={() => {
            setDraggingId(null);
            // Covers every way a link drag can end that is not a drop on a card: escaped,
            // released over the toolbar, released over a gap between columns.
            setLinkDrag(null);
          }}
          // The rubber band's loose end. `dragover` is the only event that reports the
          // pointer during a native drag — `mousemove` does not fire at all — and it
          // reaches here because neither the cards nor the columns stop it.
          onDragOver={(e) => {
            if (!linkDrag || !isChainLinkDrag(e.dataTransfer.types)) return;
            const at = anchors.toContentPoint(e.clientX, e.clientY);
            if (!at) return;
            const overTaskId = taskIdUnder(e.target);
            setLinkDrag((d) => {
              if (!d) return d;
              // `dragover` keeps firing at a stationary pointer, and re-rendering the whole
              // board for a band that has not moved is work for nothing. Sub-pixel moves
              // are below what the 2px stroke could show anyway.
              const still =
                d.at !== null &&
                Math.abs(d.at.x - at.x) < 2 &&
                Math.abs(d.at.y - at.y) < 2 &&
                d.overTaskId === overTaskId;
              return still ? d : { ...d, at, overTaskId };
            });
          }}
          // Any click that gets this far landed on the board rather than on an arrow — the
          // arrows stop their own. Letting go of the selection here is what makes clicking
          // away the obvious way to close the gate popover.
          onClick={() => setSelectedLinkId(null)}
        >
          {visibleColumns(showDone).map((col) => (
            <KanbanColumn
              key={col}
              column={col}
              label={COLUMN_LABEL[col]}
              cards={cardsByColumn[col]}
              projectNameOf={(t) =>
                t.externalSource === 'jira' ? t.phase || undefined : undefined
              }
              agentNameOf={(t) => agentProjects.find((p) => p.id === t.agentProjectId)?.name}
              // The stripe is the PROJECT the card is filed under, not the agent it may
              // or may not be delegated to.
              projectColorOf={(t) =>
                agentProjects.find((p) => p.id === t.projectTagId)?.color || undefined
              }
              // With the sprint filter on every card carries the same chip, so the name
              // moves to the status bar and is said once. Off, the chip earns its place.
              showSprint={!currentSprintOnly}
              statusKeywords={settings?.statusKeywords}
              attentionTaskIds={attention.taskIds}
              liveRunTaskIds={liveRuns}
              mergingTaskIds={merging}
              display={display}
              anchorRef={anchors.anchorRef}
              linkDrag={linkDrag}
              onLinkStart={(taskId) => {
                // Drawing a new arrow puts the old one's panel away — it is a real DOM box
                // lying over the board, and the cards under it are drop targets now.
                setSelectedLinkId(null);
                setLinkDrag({
                  fromTaskId: taskId,
                  states: linkDropStates(links, tasks, taskId),
                  at: null,
                  overTaskId: null,
                });
              }}
              onLinkEnd={() => setLinkDrag(null)}
              onLinkTo={(fromTaskId, toTaskId) => void drawLink(fromTaskId, toTaskId)}
              onLinkArm={armLink}
              chainStateOf={(t) => chainStates.get(t.id)}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onStopTask={(taskId) => void stopTask(taskId)}
              onSelectTask={selectTask}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onDropInColumn={(taskId, column) => {
                // Before the move, not after: `moveTask` patches optimistically and the
                // dragged card is gone from this column by the time the promise settles.
                setDraggingId(null);
                void moveTask(taskId, column);
              }}
            />
          ))}
          {/* Last, so the arrows paint over the cards — and inside the scroll container,
              so they travel with them. It takes no pointer events; only the strokes do. */}
          <ChainOverlay
            links={links}
            anchors={anchors.rects}
            tasksById={tasksById}
            runningTaskIds={liveRuns}
            selectedTaskId={selectedTaskId}
            hoveredTaskId={anchors.hoveredTaskId}
            focusTaskIds={focusIds}
            selectedLinkId={selectedLinkId}
            onSelectLink={setSelectedLinkId}
            linkDrag={linkDrag}
            width={anchors.bounds.width}
            height={anchors.bounds.height}
          />
          {/* A sibling of the overlay, in the same scrolling container — so it sits on the
              arrow's own curve and stays there while the board scrolls. */}
          {selectedLink && selectedLinkAt && (
            <ChainLinkPopover
              link={selectedLink}
              fromTitle={tasksById.get(selectedLink.fromTaskId)?.title ?? 'another card'}
              toTitle={tasksById.get(selectedLink.toTaskId)?.title ?? 'another card'}
              at={selectedLinkAt}
              boardWidth={anchors.bounds.width}
              onSetGate={(gate) => void setLinkGate(selectedLink.id, gate)}
              onRemove={() => void removeLink(selectedLink.id)}
            />
          )}
        </div>
      </div>

      {/* Unmounted rather than hidden when folded away: remounting re-runs loadActivity,
          which is cheap, and re-marks the selected card read — which is what you want
          the moment the pane comes back anyway. */}
      {showDetail && (
        <div className={styles.right}>
          <TaskDetail
            task={selectedTask}
            agentProjects={agentProjects}
            subtasks={chain}
            parentTask={parentOfSelected}
            mergeRequests={selectedTask ? (mrsByTask.get(selectedTask.id) ?? []) : []}
            // The shown task's own files — a step's slice when a step is shown, since a
            // step is a task row and carries its own.
            attachments={selectedTask ? (attachmentsByTask.get(selectedTask.id) ?? []) : []}
            // And the card's, when what is shown is a step: a step's brief may name its
            // parent's files as well as its own, so the mockup attached once above it is
            // citable from every step of the plan without a copy per step.
            parentAttachments={
              parentOfSelected ? (attachmentsByTask.get(parentOfSelected.id) ?? []) : []
            }
            statusKeywords={settings?.statusKeywords}
            // The pane draws priority the same way the cards beside it do — one setting,
            // both surfaces, so they can never show the same fact two different ways.
            priorityDisplay={display.priorityDisplay}
            attention={attention}
            liveRunTaskIds={liveRuns}
            mergingTaskIds={merging}
            // What the selected card is still waiting on, so the pane can offer to override
            // it. From the same index the chips read, so the chip and the button can never
            // disagree about whether this card is blocked.
            chainWaitingOn={selectedTask ? chainStates.get(selectedTask.id)?.waitingOn : undefined}
            // Which of those are waiting on nothing but a merge, so the pane can offer that
            // merge where the human already is, rather than sending them to the other card.
            chainMergeHeld={selectedTask ? chainStates.get(selectedTask.id)?.mergeHeld : undefined}
            // The whole chain, for the pane's Chain section — the keyboard's route to what
            // the board does by dragging. `removeLink` is the board's own, so an unlink from
            // the pane and one from the arrow's popover are the same call.
            chainLinks={links}
            chainTasksById={tasksById}
            onUnlinkChain={(linkId) => void removeLink(linkId)}
            onOpenTask={setSelectedTaskId}
            onStatusChanged={patchTask}
            onSubtasksChanged={() => void refresh()}
          />
        </div>
      )}

      {/* Last in the row, so folding it away never shifts the detail pane sideways — and
          unmounted rather than hidden, for the same reason the detail pane is: a graph
          nobody is looking at should not be re-reading a repository on every `task:changed`. */}
      {showGraph && (
        <div className={styles.graph}>
          <GitGraphPane
            projects={agentProjects}
            selectedTask={selectedTask}
            // The whole board, so a branch can carry the CARD's title instead of `orch/…`.
            tasksById={tasksById}
            // The only thing on the drawing allowed a colour — see `GRAPH_INK`.
            runningTaskIds={liveRuns}
          />
        </div>
      )}

      <AddTaskDialog
        open={addOpen}
        projectId={PERSONAL_PROJECT_ID}
        phases={[]}
        parents={parentCandidates}
        // The same cards, asked a different question: a step of that card, or a card of its
        // own that runs after it. Chaining at creation saves finding the new card on the
        // board and dragging an arrow to it — three moves for one intent.
        chainCandidates={parentCandidates}
        // The same repos the detail pane files a card under, offered while the card is
        // being written instead of only afterwards.
        projects={agentProjects}
        jiraEnabled={jiraEnabled}
        onClose={() => setAddOpen(false)}
        onCreated={() => void refresh()}
        // A link that would not draw is reported HERE: the card exists by then, and the
        // dialog it was refused in is already closing.
        onNotice={setError}
      />

      <ArchivedCardsDialog
        open={archivedOpenedAt !== null}
        archived={removedCards}
        // Read once, when it opened — see `archivedOpenedAt`.
        now={archivedOpenedAt ?? 0}
        onClose={() => setArchivedOpenedAt(null)}
        // Left open on purpose: restoring one card of five is a normal thing to do, and the
        // list shortens under you as each goes back. It closes when you close it.
        onRestore={restoreCard}
      />
    </div>
  );
}
