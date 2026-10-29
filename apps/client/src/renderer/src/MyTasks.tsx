/**
 * My Tasks — the standalone personal Kanban board (Phase C).
 *
 * A board independent of code-projects: it holds your JIRA-synced tickets and
 * internal ad-hoc tasks side by side. Columns are To Do / In Progress / Blocked,
 * plus a toggleable Done. Drag a card between columns to change its status; for a
 * JIRA ticket that also transitions the real issue — every column, Blocked included,
 * where the workflow has a status for it. The selected card's status and activity
 * timeline show in the right pane (`TaskDetail`).
 *
 * The chain of execution is drawn over the top of it: arrows between cards (`ChainOverlay`),
 * drawn by dragging a card's handle, and a **Chain** toggle in the toolbar that reduces the
 * board to the selected card's chain and nothing else — see `focusIds`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskSummary } from '@shared/taskSummary';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  mergeClasses,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import { hasPlan, hasRepo, PERSONAL_PROJECT_ID, type Milestone, type Project } from '@shared/model';
import {
  DEFAULT_BOARD_DISPLAY,
  hiddenBoardColumns,
  withColumnHidden,
  type AppSettings,
} from '@shared/settings';
import type { BoardScope, IpcEvents } from '@shared/ipc';
import type { MergeRequest } from '@shared/mergeRequest';
import { DEFAULT_READY_LANES, openPrTaskIds } from '@shared/readyLanes';
import type { TaskAttachment } from '@shared/attachments';
import {
  LINK_REFUSAL_MESSAGE,
  canLink,
  chainComponent,
  type LinkGate,
  type TaskLink,
} from '@shared/taskChain';
import { isVariantRow } from '@shared/board';
import { AddTaskDialog } from '@ui/AddTaskDialog';
import { ArchivedCardsDialog, archivedCards } from '@ui/board/ArchivedCardsDialog';
import { dictationAvailable } from '@ui/dictation/dictationModel';
import { GitGraphPane } from '@ui/GitGraphPane';
import { PaneLoading } from '@ui/PaneLoading';
import { useTicketRegistries } from '@ui/projects/useTicketRegistries';
import { TaskDetailHost } from '@ui/TaskDetailHostView';
import { useInitialLoad } from '@ui/useInitialLoad';
import { useTaskSummaries } from '@ui/useTaskSummaries';
import { applyTaskDelta, deltaFromBoardList, patchTaskSummary } from '@ui/taskSummaryStore';
import { useReleaseOnDone } from '@ui/ReleaseWaitingDialog';
import { KanbanColumn } from '@ui/board/KanbanColumn';
import { useBoardLayoutStyles } from '@ui/board/boardLayout';
import { currentSprintName } from '@ui/board/currentSprint';
import { doneSwitchLabel, doneSwitchTitle } from '@ui/board/doneSwitchLabel';
import { ChainLegend, ChainOverlay } from '@ui/board/ChainOverlay';
import { ChainLinkPopover } from '@ui/board/ChainLinkPopover';
import { LinkModeSwitch } from '@ui/board/LinkModeSwitch';
import { BoardMoreMenu } from '@ui/board/BoardMoreMenu';
import { BoardTitlePicker, BoardViewTabs } from '@ui/board/BoardHeader';
import { GlassPane } from '@ui/shell/GlassPane';
import { linkView, nextLinkMode, type LinkMode } from '@ui/board/linkMode';
import { linkChips } from '@ui/board/linkChips';
import { buildChainDrawing, linkMidpoint } from '@ui/board/chainArrows';
import { useGlobalShortcut } from '@ui/palette/shortcut';
import {
  hiddenBy,
  hiddenByMessage,
  type BoardFilter,
  type BoardViewState,
} from '@ui/board/hiddenBy';
import {
  isChainLinkDrag,
  linkDropStates,
  taskIdUnder,
  type LinkDragState,
} from '@ui/board/chainDrag';
import { archivedByNamesOf, archiveIndexOf, archiveRestoreTarget } from '@shared/trackerArchive';
import { chainStates } from '@ui/board/chainStates';
import { useCardAnchors } from '@ui/board/useCardAnchors';
import { ensureShelvedCard, shelvedCardSet, toggleShelvedCard } from '@ui/board/shelvedCards';
import { ShelfStrip } from '@ui/board/ShelfStrip';
import { useAttentionIndex } from './useAttentionIndex';
import { useActiveRuns } from './useActiveRuns';
import { useIntegratingTasks } from './useIntegratingTasks';
import {
  bucketBoardCards,
  COLUMN_META,
  columnForTask,
  focusAnchorId,
  hiddenColumnsSummary,
  isRunStatus,
  statusForColumn,
  visibleColumns,
} from '@ui/board/boardColumns';
import type { BoardColumn } from '@ui/board/boardColumns';

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

/** A stable empty set — `buildChainDrawing`'s `litTaskIds` when only the geometry matters. */
const EMPTY_TASK_IDS: ReadonlySet<string> = new Set();

/**
 * The optimistic half of the main process's `humanStatusPatch`: where a status the human
 * just chose goes on THIS copy of the task, until the real one comes back.
 *
 * A card whose run has borrowed `status` gets the new state parked in `preRunStatus`, which
 * is what `columnForTask` reads — so the card jumps columns the instant you let go without
 * the spinner, the run strip or the attention ring flickering off and back on.
 */
function optimisticMove(task: TaskSummary, column: BoardColumn): TaskSummary {
  const status = statusForColumn(column);
  return isRunStatus(task.status) ? { ...task, preRunStatus: status } : { ...task, status };
}

export interface MyTasksProps {
  /** A card another tab wants opened — Automations' "Open card" is the first caller. Consumed
   *  once the board selects it, via `onOpenTaskIdHandled`, so switching back to this tab on
   *  your own doesn't re-select it. */
  openTaskId?: string | null;
  onOpenTaskIdHandled?: () => void;
  /** The Add task dialog, asked open from outside this screen — the command palette's "Add
   *  task" (F9.4) is the first caller. The same one-shot shape as `openTaskId` above. */
  openAddTask?: boolean;
  onOpenAddTaskHandled?: () => void;
  /** Reports the board's own selection upward on every change — what the command palette's
   *  "Start/Stop selected card" (F9.4) acts on, since the selection otherwise lives only in
   *  this screen's own state and the palette can be opened from any tab. */
  onSelectedTaskIdChange?: (taskId: string | null) => void;
  /** The header's List tab: leave the board for the same tickets as a list (the Tickets
   *  tab). Absent, the tab is drawn but disabled. */
  onOpenList?: () => void;
}

export function MyTasks({
  openTaskId,
  onOpenTaskIdHandled,
  openAddTask,
  onOpenAddTaskHandled,
  onSelectedTaskIdChange,
  onOpenList,
}: MyTasksProps = {}): JSX.Element {
  // The board's frame — including the commit graph's own pane — shared with the browser
  // client. See `boardLayout.ts`; this screen has no styles left of its own.
  const layout = useBoardLayoutStyles();
  /** The desktop's dictation offer (F9.10) — read once, since `window.navigator.userAgent`
   *  never changes mid-session. */
  const dictation = useMemo(() => dictationAvailable('desktop', window), []);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // The repos a card can be delegated to — fetched once and shared by the cards
  // (glyph tooltip) and the detail pane (assign dialog).
  const [agentProjects, setAgentProjects] = useState<Project[]>([]);
  /** Every project, unfiltered — `archiveIndex` below needs the ticket projects
   *  `agentProjects` already drops (a repo-less board has no agent project at all). */
  const [projectList, setProjectList] = useState<Project[]>([]);
  /** Milestones across every ticket project, for the same `archiveIndex` — see
   *  `milestone:list`'s own no-`projectId` scope. */
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  /** The boards the header's title picker offers — Personal plus every other
   *  project. Fed by `board:scopes`. */
  const [scopes, setScopes] = useState<BoardScope[]>([]);
  /**
   * Which board is open: `'all'` unions every board's cards, or one board's own
   * project id. Mirrors `settings.boardScopeId`, but kept as its own state — unlike
   * the toolbar switches below — because changing it drives a re-fetch
   * (`board:tasks(scope)`/`board:archived(scope)`) rather than a plain settings write.
   */
  const [scope, setScope] = useState<string>('all');
  /** False until the saved scope has been read — the board loads nothing before it knows
   *  which board to load. */
  const [scopeReady, setScopeReady] = useState(false);
  /**
   * `scope`, for the live-update effect below to read WITHOUT depending on it. That
   * effect subscribes seven events on `[patchTask, refreshArchived]`; putting scope in
   * `patchTask`'s deps would tear all seven down and rebuild them on every scope
   * change, possibly mid-drag. Kept current by a plain assignment in the render body —
   * the same pattern `Transcript` uses for a value a stable callback must always see
   * the latest of.
   */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** Board project ids `scope === 'all'` covers — what "is this project in scope"
   *  tests against once the scope itself is All rather than one board. */
  const scopeIds = useMemo(() => new Set(scopes.map((s) => s.id)), [scopes]);
  const scopeIdsRef = useRef(scopeIds);
  scopeIdsRef.current = scopeIds;
  /**
   * The board's cards, as summaries (F29.2): loaded once per scope, then merged from deltas
   * and `task:changed` rows — never re-read whole on an event. On All, a delta is taken only
   * for a board the scope picker offers; a single board's scope takes only its own.
   *
   * A card leaving the board is a whole-board change and nothing else — there is no per-card
   * event for it — so a delta that removes cards re-reads the removed list alongside: it is
   * the one moment that list can have changed.
   */
  const board = useTaskSummaries(scopeReady ? scope : null, {
    accepts: (projectId) => scopeRef.current !== 'all' || scopeIdsRef.current.has(projectId),
    onDelta: (delta) => {
      if (delta.removed.length > 0) void refreshArchived();
    },
  });
  const { tasks, setTasks } = board;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` on purpose. A notice is the engine reporting a decision it took to
  // protect the board — "JIRA answered short, so nothing was removed" — not a failure. Shown
  // in its own bar because a warning dressed as an error is a bar people stop reading.
  const [notice, setNotice] = useState<IpcEvents['board:notice'] | null>(null);
  /**
   * What `openTaskId` (F12.9 — jumping to a card from the Tickets panel, Automations, or
   * anywhere else that calls `openTaskOnBoard`) found when the ticket it pointed at was not
   * actually showing: `filter` names whichever rule hid it (`null` once the fix below lifts
   * it) alongside the row itself, so the bar can word it with `hiddenByMessage` without
   * re-finding a card that `loadedIds` or `archived` may be the only list holding. `filter`
   * and `card` both `null` means the ticket could not be found anywhere at all — a deleted
   * id reached this screen late.
   *
   * Cleared by dismissing the bar, by its own one-click fix once the card is selected, or by
   * picking any other card by hand — a notice about a ticket you are no longer trying to
   * reach is just noise.
   */
  const [hiddenNotice, setHiddenNotice] = useState<{
    taskId: string;
    filter: BoardFilter | null;
    card: TaskSummary | null;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** The column whose header "+" opened the add dialog — the new card is moved there.
   *  Null for every other way in (the header button, the palette), which add to To Do. */
  const [addColumn, setAddColumn] = useState<BoardColumn | null>(null);
  /**
   * The cards that have LEFT the board — held here rather than fetched when the dialog opens,
   * because the toolbar button is only offered when there are some, and a count that only
   * became true once you clicked it would be no count at all.
   */
  const [archived, setArchived] = useState<TaskSummary[]>([]);
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
  // every poll. See the `mr:mergeRequests` contract.
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
  const { ids: liveRuns, purposes: runPurposes, startedAt: runStartedAt } = useActiveRuns();
  // The third of the same kind: which cards are having their branch merged. Nothing about
  // a merging task changes while it merges, so this is the only thing any surface has to
  // go on — see `useIntegratingTasks`.
  const merging = useIntegratingTasks();

  /**
   * The columns the board does NOT draw — see `hiddenBoardColumns`, which also covers the
   * two legacy per-tracker `showDoneColumn` flags for a settings blob that predates the
   * column picker. Defaults to hiding Done, matching the old pre-settings default, while
   * `settings` itself is still loading.
   */
  const hiddenColumns = settings ? hiddenBoardColumns(settings) : (['done'] as BoardColumn[]);
  const showDone = !hiddenColumns.includes('done');
  const jiraEnabled = settings?.jira.enabled ?? false;
  const currentSprintOnly = settings?.jira.currentSprintOnly ?? false;
  const gitlabEnabled = settings?.gitlab.enabled ?? false;
  const githubEnabled = settings?.github.enabled ?? false;
  const display = settings?.board ?? DEFAULT_BOARD_DISPLAY;
  /** The open board's name — the same words the header's title picker shows. */
  const scopeLabel = useMemo(
    () =>
      scope === 'all' ? 'All boards' : (scopes.find((s) => s.id === scope)?.name ?? 'All boards'),
    [scope, scopes],
  );
  const showDetail = settings?.showTaskDetail ?? true;
  // Off until the settings land, unlike the detail pane: the graph costs a `git log` on the
  // machine the project runs on, so guessing it ON would spawn one before we know it is wanted.
  const showGraph = settings?.showGitGraph ?? false;

  const refresh = board.reload;

  // One seed load for every channel the board reads, so a failure in any of them is
  // reported rather than leaving the board on its spinner.
  //
  // Settings come first, alone, because `board:tasks`/`board:archived` need the saved
  // scope BEFORE they are asked — a parallel fetch would have to guess and then redo
  // the read once settings landed.
  const seed = useCallback(async () => {
    const appSettings = await window.api.invoke('settings:get');
    const initialScope = appSettings.boardScopeId || 'all';
    const [projects, mrs, chain, files, gone, boardScopeList, milestoneList] = await Promise.all([
      window.api.invoke('project:list'),
      window.api.invoke('mr:mergeRequests'),
      window.api.invoke('chain:links'),
      window.api.invoke('attachment:list'),
      window.api.invoke('board:archived', initialScope),
      window.api.invoke('board:scopes'),
      window.api.invoke('milestone:list'),
    ]);
    setScope(initialScope);
    setScopeReady(true);
    setSettings(appSettings);
    const allProjects = projects.map((p) => p.project);
    setProjectList(allProjects);
    // A repo directory with no plan file — the delegation targets, same as `agentProject:list`
    // used to answer before the two channel sets merged into `project:*`.
    setAgentProjects(allProjects.filter((p) => hasRepo(p) && !hasPlan(p)));
    setMergeRequests(mrs);
    setLinks(chain);
    setAttachments(files);
    setArchived(gone);
    setScopes(boardScopeList);
    setMilestones(milestoneList);
  }, []);

  /**
   * Re-read the removed list. Cheap — one indexed query over a table the board has just been
   * read from anyway — and there is nothing to push it: a card leaves the board on a POLL, so
   * "the board changed" is the only signal there is that something might have left it.
   */
  const refreshArchived = useCallback(async () => {
    setArchived(await window.api.invoke('board:archived', scopeRef.current));
  }, []);

  /**
   * Switch boards: re-seeds both `board:tasks`/`board:archived` for the new scope and
   * saves it, so the board comes back where it was left rather than resetting to All
   * on the next launch. Not optimistic on the task list itself — unlike the toolbar
   * switches, this is a different set of rows, not a property of the ones already
   * shown, so there is nothing honest to paint before the answer comes back.
   */
  const setBoardScope = useCallback(async (nextScope: string) => {
    // The scope change itself re-reads `board:tasks(nextScope)` (`useTaskSummaries`).
    setScope(nextScope);
    setArchived(await window.api.invoke('board:archived', nextScope));
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, boardScopeId: nextScope };
      void window.api.invoke('settings:save', next);
      return next;
    });
  }, []);

  /** Put a removed card back, and take it out of the list it came from. The answer is the
   *  Personal board's whole list, merged as the delta it amounts to — on All it must not
   *  replace the other boards' cards. */
  const restoreCard = useCallback(
    async (taskId: string) => {
      const personal = await window.api.invoke('task:restore', taskId);
      setTasks((prev) =>
        prev
          ? applyTaskDelta(
              prev,
              deltaFromBoardList(prev, PERSONAL_PROJECT_ID, personal),
              scopeRef.current,
            )
          : prev,
      );
      await refreshArchived();
    },
    [refreshArchived, setTasks],
  );

  const initial = useInitialLoad(seed);

  /** Patch one card the board holds with an answer an action returned (a move, a stop) — a
   *  card it does not hold is ignored, which is also what keeps another board's card out. */
  const patchTask = useCallback(
    (task: TaskSummary) => setTasks((prev) => (prev ? patchTaskSummary(prev, task) : prev)),
    [setTasks],
  );

  // Live updates — the cards themselves arrive through `useTaskSummaries` above. These are
  // the settings the ENGINE writes: dragging a card teaches it what a JIRA status
  // means, and this screen saves the whole settings blob (the two switches above), so
  // the learned map has to come back or the next toggle would write over it.
  useEffect(() => {
    const offSettings = window.api.on('settings:changed', (next) => {
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              // The engine resets this behind the UI's back when the project a saved scope
              // named is removed (`ticketProject:remove`) — a screen that saves the whole
              // blob would otherwise clobber that reset right back onto disk.
              boardScopeId: next.boardScopeId,
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
    const offMrs = window.api.on('mergeRequests:changed', setMergeRequests);
    // Pushed whenever a milestone is saved, removed, or archived/restored — the whole
    // across-every-ticket-project list, same shape `milestone:list` answers with no
    // `projectId` of its own.
    const offMilestones = window.api.on('milestone:changed', setMilestones);
    // The whole list, replaced — a link can also vanish because its CARD was deleted and
    // the row cascaded away, which no per-link patch would ever hear about.
    const offLinks = window.api.on('chain:changed', setLinks);
    // Ditto, and one more reason on top: an attachment also vanishes when its CARD is
    // deleted and the row cascades away, which no per-file patch would hear about.
    const offAttachments = window.api.on('attachment:changed', setAttachments);
    // Pushed by a sync that kept cards it could not confirm had left. It arrives from the
    // POLLER as often as from the button, so it cannot be the return value of `sync()`.
    //
    // Empty text is that same channel's only way to say "never mind" — a background sync
    // that no longer has anything to warn about sends one so a bar the last poll raised
    // does not outlive the condition that raised it.
    const offNotice = window.api.on('board:notice', (n) => setNotice(n.text ? n : null));
    return () => {
      offSettings();
      offMrs();
      offMilestones();
      offLinks();
      offAttachments();
      offNotice();
    };
  }, []);

  const selectedTask = useMemo(
    () => tasks?.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  /**
   * The four app-wide registries a ticket can point at, scoped to the SELECTED card's
   * project — see `useTicketRegistries`. `people` is app-wide regardless (an assignee can
   * be anyone, not just someone on the selected card's own project), so the board's own
   * `peopleById` reads it too: a card's avatar must not depend on which card is selected.
   */
  const registries = useTicketRegistries(selectedTask?.projectId ?? null);

  // The command palette's "Add task" — the same one-shot shape as `openTaskId` below.
  useEffect(() => {
    if (!openAddTask) return;
    setAddColumn(null);
    setAddOpen(true);
    onOpenAddTaskHandled?.();
  }, [openAddTask, onOpenAddTaskHandled]);

  // Reported on every change, not just once, since the caller (the command palette's
  // "Start/Stop selected card") needs to know the CURRENT selection, not merely the one
  // in flight when this screen first mounted.
  useEffect(() => {
    onSelectedTaskIdChange?.(selectedTaskId);
  }, [selectedTaskId, onSelectedTaskIdChange]);

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
   * The card focus is drawn around — the selection itself, or the parent of a selected
   * STEP, which is the only card a step's work is ever part of. See `focusAnchorId`:
   * selecting a step and turning focus on used to empty the whole board.
   */
  const focusAnchor = useMemo(
    () => focusAnchorId(tasks ?? [], selectedTaskId),
    [tasks, selectedTaskId],
  );

  /**
   * The ids focus mode allows through — the anchor card, everything upstream of it and
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
    () => (chainFocus && focusAnchor ? chainComponent(links, focusAnchor) : null),
    [chainFocus, focusAnchor, links],
  );

  /** The lookups `bucketBoardCards`' `archive` option needs to hide a ticket whose tracker
   *  project, milestone or epic has been archived (F14.5) — epics are looked up in `tasks`,
   *  this scope's own rows. Also what `hiddenBy` below needs on `BoardViewState` to name the
   *  SAME tracker archive (F14.9), rather than the board's `hiddenNotice` disagreeing with
   *  the board it is describing about why a card is off it. */
  const archiveIndex = useMemo(
    () => archiveIndexOf(milestones, tasks ?? [], projectList),
    [milestones, tasks, projectList],
  );

  /** Display names for `hiddenByMessage`'s "archived with <name>" clause (F14.9) — built from
   *  the same three lists `archiveIndex` is, so a milestone/epic/project named in the notice
   *  reads as itself rather than as a generic "its milestone". */
  const archiveNames = useMemo(
    () => archivedByNamesOf(milestones, tasks ?? [], projectList),
    [milestones, tasks, projectList],
  );

  // Waits for `tasks` to load (the caller may have switched tabs before the board's own
  // first fetch lands) before resolving, then tells the caller it's done so a later visit
  // to this tab on its own doesn't re-resolve a stale id.
  //
  // `openTaskId` (F12.9) can point at a card a filter is keeping off THIS board, or at one
  // this board never loaded at all (another board's card, reached from the Tickets panel or
  // Automations) — `hiddenBy` is the one place that already knows how to tell "off the
  // board right now" from "not on the board at all" apart. The row itself is looked up the
  // same way `TaskDetailHost` would: `tasks`, then `archived` (gone but still named),
  // then a last `board:tasks('all')` read for a card on a board this scope never loaded.
  useEffect(() => {
    if (!openTaskId || !tasks) return;
    let live = true;
    void (async () => {
      let card =
        tasks.find((t) => t.id === openTaskId) ?? archived.find((t) => t.id === openTaskId) ?? null;
      if (!card) {
        const all = await window.api.invoke('board:tasks', 'all');
        if (!live) return;
        card = all.find((t) => t.id === openTaskId) ?? null;
      }
      if (!card) {
        setHiddenNotice({ taskId: openTaskId, filter: null, card: null });
        onOpenTaskIdHandled?.();
        return;
      }
      const found = card;
      const parent = found.parentTaskId
        ? (tasks.find((t) => t.id === found.parentTaskId) ??
          archived.find((t) => t.id === found.parentTaskId) ??
          null)
        : null;
      const state: BoardViewState = {
        loadedIds: new Set(tasks.map((t) => t.id)),
        scopeName: scopeLabel,
        focusIds,
        currentSprintOnly,
        currentSprint: currentSprintName(tasks),
        hiddenColumns,
        archiveIndex,
      };
      const filter = hiddenBy(found, parent, state);
      if (filter === null) {
        setHiddenNotice(null);
        setSelectedTaskId(openTaskId);
      } else {
        setHiddenNotice({ taskId: openTaskId, filter, card: found });
      }
      onOpenTaskIdHandled?.();
    })();
    return () => {
      live = false;
    };
  }, [
    openTaskId,
    tasks,
    archived,
    scopeLabel,
    focusIds,
    currentSprintOnly,
    hiddenColumns,
    archiveIndex,
    onOpenTaskIdHandled,
  ]);

  /**
   * The board's cards parked onto the shelf — per-surface view-state, like `foldedSteps`.
   * `tasks` is already this scope's own cards (`board:tasks`), so the flat id list is all
   * the Personal/All split needs: see `partitionShelved`.
   */
  const shelvedIds = useMemo(() => shelvedCardSet(settings?.shelvedCardIds), [settings]);

  const { cardsByColumn, shelvedCards } = useMemo(
    () =>
      bucketBoardCards(tasks ?? [], mrsByTask, focusIds, shelvedIds, attention.taskIds, {
        index: archiveIndex,
      }),
    [tasks, mrsByTask, attention.taskIds, focusIds, shelvedIds, archiveIndex],
  );

  /**
   * What the "Show Done" switch is counting while the column is shut — put into words by
   * `doneSwitchLabel`/`doneSwitchTitle`, which the web board says the same way.
   *
   * Counted off `cardsByColumn.get('done')`, so it is the cards this board would show and
   * not the cards that exist: with chain focus on, a count that included the rest would be
   * pointing at cards opening the column still wouldn't reveal.
   */
  const hiddenDone = useMemo(
    () => hiddenColumnsSummary(cardsByColumn.get('done') ?? [], ['done']),
    [cardsByColumn],
  );

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
  /** id → person, for a native ticket's assignee avatar. */
  const peopleById = useMemo(
    () => new Map(registries.people.map((p) => [p.id, p])),
    [registries.people],
  );

  /**
   * Where each chained card stands: what it is still waiting on, which of those are waiting
   * only on a human to merge, and — once it is waiting for nothing — whether the engine
   * would actually start it. See `chainStates`, which the web's board shares.
   *
   * That answer used to be computed here, with a shorter predicate than the engine's, and
   * the two disagreed: a chained card resting in IN PROGRESS or with no agent assigned got
   * no chip at all, so a satisfied arrow arrived at a card that looked merely idle.
   *
   * Capped per project by its Ready lanes: past the cap a card reads `queued (lane limit)`
   * instead of `ready` — the same `readyLanes` answer the engine's auto-start draws on.
   */
  const chainState = useMemo(() => {
    const caps = new Map(projectList.map((p) => [p.id, p.readyLanes ?? DEFAULT_READY_LANES]));
    return chainStates(links, tasksById, liveRuns, {
      capOf: (projectId) => caps.get(projectId) ?? DEFAULT_READY_LANES,
      openPrTaskIds: openPrTaskIds(mergeRequests),
      cards: tasks ?? [],
    });
  }, [links, tasksById, liveRuns, projectList, mergeRequests, tasks]);

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

  /**
   * Cards a hand-written step can be added under: every top-level card on the board the
   * new card is filed to. `AddTaskDialog` below still files new cards under
   * `PERSONAL_PROJECT_ID` regardless of the scope open — a step belongs to its parent,
   * so with an All-scope board mixing several projects' cards in `tasks`, offering a
   * step on another board's card as a parent would be offering a parent it can never
   * actually join.
   */
  const parentCandidates = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) => !t.parentTaskId && !isVariantRow(t) && t.projectId === PERSONAL_PROJECT_ID,
      ),
    [tasks],
  );

  // Writes the explicit `board.hiddenColumns` list now, not the two legacy per-tracker
  // flags — `hiddenBoardColumns` still reads those for a settings blob saved before this,
  // but every save from here on goes through the one field both boards agree on.
  const setShowDone = useCallback((value: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        board: {
          ...prev.board,
          hiddenColumns: withColumnHidden(hiddenBoardColumns(prev), 'done', !value),
        },
      };
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

  /**
   * Move a card onto the shelf, or back off it — one menu item either way (`TaskCard`'s
   * `onToggleShelved`), and also what a card dropped back into a column clears (see
   * `onDropInColumn` below). Saved the same optimistic way every other board switch is.
   */
  const toggleShelved = useCallback(
    (taskId: string) => {
      const onBoard = new Set((tasks ?? []).map((t) => t.id));
      setSettings((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          shelvedCardIds: toggleShelvedCard(prev.shelvedCardIds, taskId, onBoard),
        };
        void window.api.invoke('settings:save', next);
        return next;
      });
    },
    [tasks],
  );

  /** A card dropped onto the shelf strip — always shelves it, never the reverse. */
  const dropOnShelf = useCallback(
    (taskId: string) => {
      const onBoard = new Set((tasks ?? []).map((t) => t.id));
      setSettings((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          shelvedCardIds: ensureShelvedCard(prev.shelvedCardIds, taskId, onBoard),
        };
        void window.api.invoke('settings:save', next);
        return next;
      });
    },
    [tasks],
  );

  const toggleShelfFolded = useCallback(() => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, shelfFolded: !prev.shelfFolded };
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

  /** The Off/Focus/All switch, saved the same optimistic way every other toolbar switch is. */
  const setBoardLinks = useCallback((mode: LinkMode) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, boardLinks: mode };
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
      const [jira, gitlab, github] = await Promise.allSettled([
        jiraEnabled ? window.api.invoke('jira:sync') : Promise.resolve(null),
        gitlabEnabled ? window.api.invoke('gitlab:sync') : Promise.resolve(null),
        githubEnabled ? window.api.invoke('github:sync') : Promise.resolve(null),
      ]);
      // JIRA only ever syncs the Personal board — `jira.value` is that board's WHOLE
      // list, never the union. On the All scope it can only replace Personal's own
      // slice; on any other single-board scope it names a board that isn't even open.
      if (jira.status === 'fulfilled' && jira.value) {
        const jiraTasks = jira.value;
        setTasks((prev) =>
          prev
            ? applyTaskDelta(
                prev,
                deltaFromBoardList(prev, PERSONAL_PROJECT_ID, jiraTasks),
                scopeRef.current,
              )
            : prev,
        );
      }
      // Both forges return the WHOLE list, so the later one wins and neither can lose the
      // other's rows — see `gitlab:sync` in the contract.
      if (gitlab.status === 'fulfilled' && gitlab.value) setMergeRequests(gitlab.value);
      if (github.status === 'fulfilled' && github.value) setMergeRequests(github.value);
      const failures = [jira, gitlab, github]
        .flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
        .map((e) => (e instanceof Error ? e.message : String(e)));
      if (failures.length > 0) setError(failures.join(' · '));
    } finally {
      setSyncing(false);
    }
  }, [jiraEnabled, gitlabEnabled, githubEnabled]);

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

  /**
   * `hiddenNotice`'s one-click fix (F12.9): lifts whichever filter `hiddenBy` named, through
   * the SAME setter the toolbar control for that filter already uses — never a duplicate
   * settings write — then selects the card and dismisses the bar. A `card: null` notice (the
   * ticket could not be found at all) has no filter to lift, so this is never offered one.
   *
   * `archived` with a `by` (F14.9, the tracker's own archive) restores through
   * `archive:restore` on `archiveRestoreTarget`'s target instead of opening the Removed-cards
   * dialog — that dialog is only for `Task.archivedAt`, the board's OWN archive, which is what
   * a `by`-less `archived` filter still means. A `self` target that is not an epic (should
   * never happen — `archivedBy`'s own `self` only ever names one, see `archiveEpicTx`) has no
   * target to restore, so this just selects the card, same as opening it would.
   *
   * Restoring a milestone or epic pushes `milestone:changed`/`project:tasksChanged`, which
   * this screen already listens for — nothing to re-fetch. Restoring a project does not (its
   * own row changed, not a task or milestone list), so `project:list` is re-read by hand, the
   * same gap `archiveHandlers.ts`'s own docstring calls out.
   */
  const liftHiddenFilter = useCallback(
    async (notice: { taskId: string; filter: BoardFilter | null; card: TaskSummary | null }) => {
      const filter = notice.filter;
      if (!filter) return;
      switch (filter.kind) {
        case 'archived': {
          if (!filter.by) {
            setArchivedOpenedAt(Date.now());
            break;
          }
          const target = notice.card && archiveRestoreTarget(notice.card, filter.by);
          if (target) {
            try {
              const result = await window.api.invoke('archive:restore', target);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              if (target.kind === 'project') {
                const projects = await window.api.invoke('project:list');
                setProjectList(projects.map((p) => p.project));
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              return;
            }
          }
          break;
        }
        case 'current-sprint':
          void setCurrentSprintOnly(false);
          break;
        case 'scope':
          void setBoardScope('all');
          break;
        case 'focus':
          setChainFocus(false);
          break;
        case 'column':
          setSettings((prev) => {
            if (!prev) return prev;
            const next = {
              ...prev,
              board: {
                ...prev.board,
                hiddenColumns: withColumnHidden(hiddenBoardColumns(prev), filter.column, false),
              },
            };
            void window.api.invoke('settings:save', next);
            return next;
          });
          break;
      }
      setSelectedTaskId(notice.taskId);
      setHiddenNotice(null);
    },
    [setCurrentSprintOnly, setBoardScope],
  );

  const { askAfterMove, dialog: releaseDialog } = useReleaseOnDone();
  const moveTask = useCallback(
    async (taskId: string, column: BoardColumn) => {
      const task = tasks?.find((t) => t.id === taskId);
      if (!task || columnForTask(task) === column) return;
      setError(null);
      const prev = task;
      patchTask(optimisticMove(task, column)); // optimistic
      try {
        const moved = await window.api.invoke('task:move', taskId, column);
        patchTask(moved);
        // After the move, never instead of it: a human's drag into Done may ask whether to
        // release the cards chained after this one (`@ui/ReleaseWaitingDialog`).
        askAfterMove(prev, moved, links, tasksById, mergeRequests);
      } catch (e) {
        patchTask(prev); // rollback (e.g. JIRA transition unavailable)
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [tasks, patchTask, askAfterMove, links, tasksById, mergeRequests],
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
   * Pick a card's stopped work back up, from the card itself — `stopTask` run backwards, and
   * deliberately the same shape as it.
   *
   * Not optimistic either, and rather more so: a resume rejoins a session, re-queues the
   * steps that were cancelled behind it, and can be refused outright by the usage gate. The
   * task that comes back is the truth about all of that, and `task:changed` brings the steps.
   * A refusal lands in `error`, where the board already shows what went wrong.
   *
   * One call covers the whole card, exactly as one Stop did.
   */
  const resumeTask = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        patchTask(await window.api.invoke('task:resumeAgent', taskId));
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
      setHiddenNotice(null);
      setSelectedTaskId(id);
    },
    [linkDrag, drawLink],
  );

  /** The selected arrow, and the point on its curve the gate popover hangs from. */
  const selectedLink = useMemo(
    () => links.find((l) => l.id === selectedLinkId) ?? null,
    [links, selectedLinkId],
  );
  // The same routed geometry `ChainOverlay` draws, memoised once here rather than recomputed
  // by hand — an endpoint the board is not showing has a stub rather than an arrow, and
  // `linkMidpoint` already returns null for exactly that case.
  const chainDrawing = useMemo(
    () =>
      buildChainDrawing({
        links,
        anchors: anchors.rects,
        cardColumns: anchors.cardColumns,
        tasksById,
        litTaskIds: EMPTY_TASK_IDS,
        boardWidth: anchors.bounds.width,
        layout: anchors.layout,
      }),
    [links, anchors.rects, anchors.cardColumns, tasksById, anchors.bounds.width, anchors.layout],
  );
  const selectedLinkAt = useMemo(
    () => (selectedLink ? linkMidpoint(chainDrawing, selectedLink.id) : null),
    [selectedLink, chainDrawing],
  );

  // The Off/Focus/All switch (F13.20). `boardLinks` falls back to the shipped default
  // ('all') until settings arrive, same as every other toolbar switch keyed off `settings?.`.
  const boardLinks: LinkMode = settings?.boardLinks ?? 'all';
  const linkState = useMemo(
    () => linkView(links, boardLinks, selectedTaskId),
    [links, boardLinks, selectedTaskId],
  );
  useGlobalShortcut('l', () => setBoardLinks(nextLinkMode(boardLinks)), {
    ignoreInFields: true,
  });

  // Widens the gutters (`columnsLinked`/`listLinked`) only while there is something to route
  // through them — a board with no links yet keeps its ordinary, narrower gap — and the
  // switch is not Off, where nothing is drawn over the board at all.
  const linksDrawn = links.length > 0 && linkState.drawn;

  // Off draws no arrow at all, so each card says what it would have said in words instead
  // (`linkChips.ts`) — absent every other mode, which is what leaves `chainChip` alone there.
  const linkChipsOf =
    boardLinks === 'off'
      ? (t: TaskSummary) => linkChips(t.id, links, tasksById, liveRuns)
      : undefined;

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
        error={initial.error ?? board.error ?? registries.error}
        onRetry={() => {
          initial.retry();
          board.retry();
          registries.retry();
        }}
        shape="board"
      />
    );
  }

  return (
    <div className={layout.root}>
      {/* The board's own card (v9-7): `GlassPane` paints the surface, `layout.board` is its
          body — the header row, then the columns grid running to the bottom padding. */}
      <GlassPane className={layout.board}>
        {/* One row (v9-7): title, tabs, spacer, the `Links:` pill, "…" and "+". Every other
            board control — Show Done, Current sprint, chain focus, the commit graph, the
            detail pane, Removed cards, Sync — lives behind "…" at every width
            (`BoardMoreMenu`, the same menu the web board draws). */}
        <div className={layout.header} data-board-header="">
          {/* Which board's cards are shown, as the card's own title (v9-7): every board
            unioned (the default), or one board alone. Fed by `board:scopes`, seeded from and
            saved to `settings.boardScopeId` so the board opens where it was left. The one
            control in the row that ellipsizes when the row runs short (`layout.header`). */}
          <BoardTitlePicker
            scope={scope}
            scopes={scopes}
            onScopeChange={(next) => void setBoardScope(next)}
          />
          <BoardViewTabs onOpenList={onOpenList} />
          <span className={layout.grow} />
          {/* Off/Focus/All: how the chain links over the board draw at all — distinct from
            chain focus in "…", which FILTERS which cards are on the board. `L` cycles it
            without reaching for the mouse (see the shortcut registered above). */}
          <LinkModeSwitch mode={boardLinks} onChange={setBoardLinks} />
          {/* The Done entry's count is its whole job while the column is shut: DONE is the
            one column a card can reach without anybody dragging it there, so the numeral
            makes a hidden card impossible to mistake for a lost one.

            Chain focus is keyed on the ANCHOR, not on `selectedTaskId`: the two differ for a
            selected step, and the entry has to be live in exactly the cases focus does
            something — offering it for a selection that resolves to no card is how the
            board went blank in the first place.

            Removed cards is offered only when something has left the board: on a healthy
            board that is an empty list, and a permanent entry for one is a permanent
            invitation to check whether anything has gone missing. */}
          <BoardMoreMenu
            doneLabel={doneSwitchLabel(showDone, hiddenDone)}
            doneTitle={doneSwitchTitle(showDone, hiddenDone)}
            doneChecked={showDone}
            onToggleDone={() => setShowDone(!showDone)}
            sprint={
              jiraEnabled
                ? {
                    checked: currentSprintOnly,
                    disabled: syncing,
                    onToggle: () => void setCurrentSprintOnly(!currentSprintOnly),
                  }
                : undefined
            }
            chainFocus={chainFocus}
            chainFocusDisabled={!focusAnchor}
            onToggleChainFocus={() => setChainFocus((v) => !v)}
            showGraph={showGraph}
            onToggleGraph={() => setShowGraph(!showGraph)}
            showDetail={showDetail}
            onToggleDetail={() => setShowDetail(!showDetail)}
            archivedCount={removedCards.length}
            onOpenArchived={() => setArchivedOpenedAt(Date.now())}
            sync={
              jiraEnabled || gitlabEnabled || githubEnabled
                ? { syncing, onSync: () => void sync() }
                : undefined
            }
          />
          {/* The v9 mockup's brand-filled square "+", the row's LAST control, so the one
            primary action sits at the far right edge. */}
          <Button
            size="small"
            appearance="primary"
            icon={<AddRegular />}
            title="Add task"
            aria-label="Add task"
            onClick={() => {
              setAddColumn(null);
              setAddOpen(true);
            }}
          />
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

        {/* A ticket `openTaskId` pointed at (F12.9) that a filter is keeping off the board,
            or that could not be found at all — see `hiddenNotice`'s own comment. */}
        {hiddenNotice && (
          <MessageBar intent="info">
            <MessageBarBody>
              {hiddenNotice.filter && hiddenNotice.card
                ? hiddenByMessage(hiddenNotice.card, hiddenNotice.filter, archiveNames).text
                : 'That ticket no longer exists'}
            </MessageBarBody>
            <MessageBarActions>
              {hiddenNotice.filter && hiddenNotice.card && (
                <Button
                  size="small"
                  appearance="transparent"
                  onClick={() => void liftHiddenFilter(hiddenNotice)}
                >
                  {hiddenByMessage(hiddenNotice.card, hiddenNotice.filter, archiveNames).action}
                </Button>
              )}
              <Button size="small" appearance="transparent" onClick={() => setHiddenNotice(null)}>
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
          className={mergeClasses(layout.columns, linksDrawn && layout.columnsLinked)}
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
          {visibleColumns(hiddenColumns).map((col) => (
            <KanbanColumn
              key={col}
              column={col}
              label={COLUMN_LABEL[col]}
              cards={cardsByColumn.get(col) ?? []}
              onAddCard={(c) => {
                setAddColumn(c);
                setAddOpen(true);
              }}
              // A native ticket's parent epic, by NAME (Phase 24) — `t.epicTaskId` names
              // another card on this same board.
              epicNameOf={(t) => (t.epicTaskId ? tasksById.get(t.epicTaskId)?.title : undefined)}
              assigneeOf={(t) => (t.assigneeId ? peopleById.get(t.assigneeId) : undefined)}
              agentNameOf={(t) => agentProjects.find((p) => p.id === t.agentProjectId)?.name}
              attentionTaskIds={attention.taskIds}
              liveRunTaskIds={liveRuns}
              runPurposes={runPurposes}
              runStartedAt={runStartedAt}
              mergingTaskIds={merging}
              anchorRef={anchors.anchorRef}
              linksDrawn={linksDrawn}
              dimmedTaskIds={linkState.dimmedTaskIds}
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
              chainStateOf={(t) => chainState.get(t.id)}
              // A file hold's "Make this an arrow" — the same after-merge arrow a drag draws.
              onMakeArrow={(fromTaskId, toTaskId) => void drawLink(fromTaskId, toTaskId)}
              linkChipsOf={linkChipsOf}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onStopTask={(taskId) => void stopTask(taskId)}
              onResumeTask={(taskId) => void resumeTask(taskId)}
              onToggleShelved={settings?.features.shelf ? toggleShelved : undefined}
              onSelectTask={selectTask}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onDropInColumn={(taskId, column) => {
                // Before the move, not after: `moveTask` patches optimistically and the
                // dragged card is gone from this column by the time the promise settles.
                setDraggingId(null);
                void moveTask(taskId, column);
                // A card dragged out of the shelf and into a column is off the shelf —
                // the drag that put it there and the drag that takes it back are the same
                // gesture, so this is the toggle's OTHER click.
                if (shelvedIds.has(taskId)) toggleShelved(taskId);
              }}
            />
          ))}
          {/* The parked shelf, as the grid's own second row (`layout.shelf`): sticky to the
              grid's bottom, over the panes rather than below them, so every column still runs
              to the card's padding and this stays the board's one scroll container. */}
          {settings?.features.shelf && (
            <ShelfStrip
              cards={shelvedCards}
              folded={settings?.shelfFolded ?? false}
              onToggleFolded={toggleShelfFolded}
              epicNameOf={(t) => (t.epicTaskId ? tasksById.get(t.epicTaskId)?.title : undefined)}
              assigneeOf={(t) => (t.assigneeId ? peopleById.get(t.assigneeId) : undefined)}
              agentNameOf={(t) => agentProjects.find((p) => p.id === t.agentProjectId)?.name}
              attentionTaskIds={attention.taskIds}
              liveRunTaskIds={liveRuns}
              runPurposes={runPurposes}
              runStartedAt={runStartedAt}
              mergingTaskIds={merging}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onStopTask={(taskId) => void stopTask(taskId)}
              onResumeTask={(taskId) => void resumeTask(taskId)}
              onSelectTask={selectTask}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onToggleShelved={toggleShelved}
              onDropOnShelf={dropOnShelf}
              span={visibleColumns(hiddenColumns).length}
            />
          )}
          {/* Last, so the arrows paint over the cards — and inside the scroll container,
              so they travel with them. It takes no pointer events; only the strokes do.
              Absent entirely in Off: nothing to draw, and nothing for the popover below to
              hang off either. */}
          {linkState.drawn && (
            <ChainOverlay
              links={links}
              anchors={anchors.rects}
              cardColumns={anchors.cardColumns}
              layout={anchors.layout}
              tasksById={tasksById}
              runningTaskIds={liveRuns}
              selectedTaskId={selectedTaskId}
              hoveredTaskId={anchors.hoveredTaskId}
              focusTaskIds={focusIds}
              selectedLinkId={selectedLinkId}
              onSelectLink={setSelectedLinkId}
              fadedLinkIds={linkState.fadedLinkIds}
              linkDrag={linkDrag}
              width={anchors.bounds.width}
              height={anchors.bounds.height}
            />
          )}
          {/* A sibling of the overlay, in the same scrolling container — so it sits on the
              arrow's own curve and stays there while the board scrolls. */}
          {linkState.drawn && selectedLink && selectedLinkAt && (
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
        {/* Anchored to the BOARD (`layout.chainLegend`), never a child of the columns grid —
            see `ChainLegend`'s own comment for the bug a grid child used to cause. */}
        {linksDrawn && (
          <div className={layout.chainLegend}>
            <ChainLegend />
          </div>
        )}
      </GlassPane>

      {/* Unmounted rather than hidden when folded away: remounting re-runs loadActivity,
          which is cheap, and re-marks the selected card read — which is what you want
          the moment the pane comes back anyway. Also unmounted with nothing selected: the
          empty-state placeholder (`TaskDetail`'s own `CollectionsEmptyRegular`) used to hold
          the pane's full 40% width for nothing (the 2026-10-18 screenshot review) — with no
          card to show, the pane itself should not be there to ask for the room. */}
      {showDetail && selectedTask && (
        <GlassPane className={layout.right}>
          <TaskDetailHost
            // No `task`/`subtasks`/`parentTask`: the board holds card summaries (F29.2), and
            // the pane reads the card's heavy half itself through `task:get`.
            taskId={selectedTaskId}
            agentProjects={agentProjects}
            boards={scopes}
            mergeRequests={selectedTask ? (mrsByTask.get(selectedTask.id) ?? []) : []}
            // The ticket registries, scoped to the selected card's own project — see
            // `registries` above. Passing `ticketLinks` through means `useTicketLinks`
            // inside the pane no longer fetches its own copy.
            people={registries.people}
            milestones={registries.milestones}
            labels={registries.labels}
            ticketLinks={registries.links}
            ticketProjects={projectList}
            afterMergePipeline={settings?.features.afterMergePipeline}
            mrRebaseButton={settings?.features.mrRebaseButton}
            mrMergeButton={settings?.features.mrMergeButton}
            quietAgentProgress={settings?.features.quietAgentProgress}
            // The shown task's own files — a step's slice when a step is shown, since a
            // step is a task row and carries its own.
            attachments={selectedTask ? (attachmentsByTask.get(selectedTask.id) ?? []) : []}
            // And the card's, when what is shown is a step: a step's brief may name its
            // parent's files as well as its own, so the mockup attached once above it is
            // citable from every step of the plan without a copy per step.
            parentAttachments={
              parentOfSelected ? (attachmentsByTask.get(parentOfSelected.id) ?? []) : []
            }
            // Every one of the shown card's own steps' files — the Files section groups
            // them back out by step; see `FilesSection.tsx`.
            subtaskAttachments={chain.flatMap((s) => attachmentsByTask.get(s.id) ?? [])}
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
            chainWaitingOn={selectedTask ? chainState.get(selectedTask.id)?.waitingOn : undefined}
            // Which of those are waiting on nothing but a merge, so the pane can offer that
            // merge where the human already is, rather than sending them to the other card.
            chainMergeHeld={selectedTask ? chainState.get(selectedTask.id)?.mergeHeld : undefined}
            // The whole chain, for the pane's Chain section — the keyboard's route to what
            // the board does by dragging. `removeLink` is the board's own, so an unlink from
            // the pane and one from the arrow's popover are the same call.
            chainLinks={links}
            chainTasksById={tasksById}
            onUnlinkChain={(linkId) => void removeLink(linkId)}
            onOpenTask={(id) => {
              setHiddenNotice(null);
              setSelectedTaskId(id);
            }}
            onStatusChanged={patchTask}
            onSubtasksChanged={() => void refresh()}
            dictation={dictation}
          />
        </GlassPane>
      )}

      {/* Last in the row, so folding it away never shifts the detail pane sideways — and
          unmounted rather than hidden, for the same reason the detail pane is: a graph
          nobody is looking at should not be re-reading a repository on every `task:changed`. */}
      {showGraph && (
        <GlassPane className={layout.graph}>
          <GitGraphPane
            projects={agentProjects}
            selectedTask={selectedTask}
            // The whole board, so a branch can carry the CARD's title instead of `orch/…`.
            tasksById={tasksById}
            // The only thing on the drawing allowed a colour — see `GRAPH_INK`.
            runningTaskIds={liveRuns}
          />
        </GlassPane>
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
        jiraEnabled={jiraEnabled}
        agentProjects={agentProjects}
        dictation={dictation}
        column={addColumn ?? undefined}
        onClose={() => {
          setAddOpen(false);
          setAddColumn(null);
        }}
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
      {releaseDialog}
    </div>
  );
}
