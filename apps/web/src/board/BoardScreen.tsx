/**
 * The web board: `GET /v1/board`'s tasks/projects, drawn as the desktop's My Tasks screen —
 * the same frame (`useBoardLayoutStyles`), the same columns in the same order, the same
 * cards (`KanbanColumn`/`TaskCard`), the same ordering rule (`sortCards`), the same arrows
 * over the top (`ChainOverlay`/`ChainLinkPopover`), the same 40% detail pane down the right,
 * and — when the toolbar's button asks for it — the same commit graph beside that
 * (`GitGraphPane`, reading the desktop's repository over the relay).
 *
 * IT IS NOT READ-ONLY ANY MORE
 * ----------------------------
 * It used to be, and the reason was never the UI: `TaskDetail` has always rendered all of
 * this, and this screen simply did not pass it the props. With no agent projects, no merge
 * requests, no attachments, no chain links, no attention index and no live runs, the shared
 * pane skips those sections entirely — so the same component drew a stub here and the whole
 * thing on the desktop.
 *
 * Every one of those lists is a relayed `IpcApi` read now (`useBoardExtras`), so they are
 * passed, and the pane draws what it always could. Most of what a person actually clicks —
 * creating or filing a card, setting its status or column, editing its description, adding
 * or editing a project — now applies straight to the mirror over `HttpTransport`'s direct
 * tier (`httpTransport.ts`) and needs no desktop Client on record at all. What is left honest
 * is narrower: a handful of sections (live agent runs, chat, comments, attachments,
 * credentials) are still carried out BY a desktop client, so they land on its next poll
 * rather than instantly, and the host-only channels (`@tm/shared/ipcRelay`) refuse with the
 * reason they are host-only.
 *
 * The board's own preferences live in `settings:get`/`settings:save` now rather than in this
 * app's `localStorage`, so the switches match the desktop's instead of being a second set of
 * the same three toggles that silently disagreed with them.
 *
 * And making a card is the desktop's own dialog (`@tm/ui/AddTaskDialog`), not this app's fork
 * of it. The fork asked for a title and a phase because that is all the `create-task` command
 * kind could carry; the shared one calls `task:create`, which posts straight to `POST
 * /v1/tasks` now, so every field — type, description, filing, parent, chain link, ticket —
 * lands without needing a desktop Client to apply it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import { COLUMN_META, hiddenColumnsSummary } from '@tm/ui/board/boardColumns';
import { allowedDropColumns, moveSheetOptions } from '@tm/ui/board/moveTargets';
import { hiddenBoardColumns, withColumnHidden } from '@tm/shared/settings';
import { KanbanColumn } from '@tm/ui/board/KanbanColumn';
import { ColumnSwitcher } from '@tm/ui/board/ColumnSwitcher';
import { columnSwitcherItems } from '@tm/ui/board/compactColumns';
import { chainPosition } from '@tm/ui/board/chainPosition';
import { MoveToSheet } from '@tm/ui/board/MoveToSheet';
import { ShelfStrip } from '@tm/ui/board/ShelfStrip';
import { ChainLegend, ChainOverlay } from '@tm/ui/board/ChainOverlay';
import { ChainLinkPopover } from '@tm/ui/board/ChainLinkPopover';
import { useCardAnchors } from '@tm/ui/board/useCardAnchors';
import { buildChainDrawing, linkMidpoint } from '@tm/ui/board/chainArrows';
import { linkDropStates, type LinkDragState } from '@tm/ui/board/chainDrag';
import { linkView, nextLinkMode, type LinkMode } from '@tm/ui/board/linkMode';
import { linkChips } from '@tm/ui/board/linkChips';
import { useGlobalShortcut } from '@tm/ui/palette/shortcut';
import { ensureShelvedCard, shelvedCardSet, toggleShelvedCard } from '@tm/ui/board/shelvedCards';
import { chainStates } from '@tm/ui/board/chainStates';
import { AddTaskDialog } from '@tm/ui/AddTaskDialog';
import { useReleaseOnDone } from '@tm/ui/ReleaseWaitingDialog';
import { GitGraphPane } from '@tm/ui/GitGraphPane';
import { TaskDetailHost } from '@tm/ui/TaskDetailHostView';
import { useTicketRegistries } from '@tm/ui/projects/useTicketRegistries';
import { useTransport } from '@tm/ui/transport';
import { useBoardLayoutStyles } from '@tm/ui/board/boardLayout';
import { ArchivedCardsDialog, archivedCards } from '@tm/ui/board/ArchivedCardsDialog';
import { CompactCardScreen } from '@tm/ui/board/CompactCardScreen';
import type { CardSection } from '@tm/ui/layout/compactRoute';
import { chainComponent } from '@tm/shared/taskChain';
import { isVariantRow } from '@tm/shared/board';
import { archiveIndexOf } from '@tm/shared/trackerArchive';
import { DEFAULT_READY_LANES, openPrTaskIds } from '@tm/shared/readyLanes';
import {
  isManualStatus,
  ownsTickets,
  PERSONAL_PROJECT_ID,
  type BoardColumn,
  type ManualStatus,
  type Person,
  type Task,
} from '@tm/shared/model';
import type { BoardScope } from '@tm/shared/ipc';
import { BoardToolbar } from './BoardToolbar';
import {
  bucketBoardCards,
  selectAgentProjects,
  selectArchivedTasks,
  selectBoardTasks,
} from './boardSelectors';
import { displayStatus, isTaskPending, type CloudBoardState } from './cloudBoardStore';
import { mergeRequestsByTask, useBoardExtras, byTask } from './useBoardExtras';

const useStyles = makeStyles({
  /** The empty state, in the board's own half of the screen rather than across all of it. */
  empty: { padding: '8px 4px' },
  error: { padding: '4px', color: tokens.colorPaletteRedForeground1 },
});

/**
 * The one sentence the pane wears (`TaskDetail`'s `readOnlyNotice`).
 *
 * It no longer says "read-only", because that stopped being true — nor does it say every
 * edit needs a desktop, because that stopped being true too. Creating a card, moving it,
 * setting its status or description, and adding or editing a project all apply straight from
 * this tab (`httpTransport.ts`'s direct tier). What this notice flags is what a reader
 * genuinely cannot infer from a pane that looks fully live: a few sections — running an
 * agent, chat, comments, attachments — are still carried out BY the desktop app, so those
 * need one running and land on its next sync rather than instantly.
 */
const RELAY_NOTICE =
  'Creating and editing cards works from here directly. Running an agent, chat, comments ' +
  'and attachments are still carried out by your desktop app and show up on its next sync — ' +
  'a few seconds. A few controls (file pickers, credentials, window buttons) only work over there.';

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

/** A stable empty set — `buildChainDrawing`'s `litTaskIds` when only the geometry matters. */
const EMPTY_TASK_IDS: ReadonlySet<string> = new Set();

export interface BoardScreenProps {
  state: CloudBoardState;
  /** A card dropped into a column, or moved there from the compact board's "Move to"
   *  sheet — sent as `task:move`, not `task:setStatus`. */
  onMoveTask: (taskId: string, column: BoardColumn) => Promise<Task>;
  /**
   * A status change the DETAIL PANE has already sent for itself: record the same pending
   * overlay a drag gets, without putting a second identical command on the wire.
   */
  onStatusNoted: (taskId: string, status: ManualStatus) => void;
  /**
   * The compact one-column board (F3.5) — set by `CompactApp` on a narrow viewport. Renders
   * `BoardToolbar` as today, then a `ColumnSwitcher`, then ONE `KanbanColumn` for `column`
   * instead of all of them side by side: no `ChainOverlay`, no `ChainLinkPopover`, no
   * link-drag handles (there is no room to draw an arrow over a single column — `TaskCard`'s
   * "step n of m" caption says what it would have), and no right-hand detail pane or git
   * graph. The `ShelfStrip` stays, as it does on the wide board. Absent, the wide path below
   * is unchanged.
   */
  compact?: {
    /** The column to show, or `null` only when every column is hidden. */
    column: BoardColumn | null;
    onColumnChange: (column: BoardColumn) => void;
    /** A card was tapped — the compact shell opens it full-screen rather than a detail pane. */
    onOpenCard: (id: string) => void;
    /**
     * Set by `CompactApp.tsx` when the hash route is a `card` route (F3.7) — this screen
     * renders `CompactCardScreen` full-screen instead of `column`'s single `KanbanColumn`,
     * and every `TaskDetail`-shaped prop below follows this card's own id rather than the
     * wide pane's `selectedTaskId` (`effectiveSelectedId`, above).
     */
    card?: {
      id: string;
      section: CardSection;
      onSectionChange: (section: CardSection) => void;
      onBack: () => void;
    };
  };
  /**
   * The wide pane's own selection, seeded once from `App.tsx`'s own hash route (F3.7) so a
   * card opened here survives a rotation down to compact and back — `App.tsx` writes the
   * route from `onSelectedTaskChange` below, and reads this screen's INITIAL selection back
   * out of it (`openCardId`) the next time the wide layout mounts. Absent on the desktop,
   * which has no route to round-trip through.
   */
  initialSelectedTaskId?: string | null;
  /** Every change to the wide pane's own selection — see `initialSelectedTaskId`. */
  onSelectedTaskChange?: (taskId: string | null) => void;
  /**
   * Why the Changes pane's comments and Send review are paused — `activityGate`'s own
   * `unreachable` message, computed by `App.tsx`/`CompactApp.tsx` from the same
   * `pollError`/`presence`/`targetClientId` the status bar already reads. Passed straight
   * through to `TaskDetail`'s `hostUnreachable` (`taskDetailProps`, below).
   */
  hostUnreachable?: string;
  /**
   * A command-palette action landed while this screen was already mounted (F9.5) — a card
   * selection or Add task that `initialSelectedTaskId` cannot reach, since that only seeds
   * the wide pane's selection on mount. `nonce` is a tie-breaker: re-selecting the SAME card
   * a second time while the palette fires must still produce a new prop value for the effect
   * below to see, since the object's shape alone would otherwise be identical to the last one.
   */
  paletteRequest?:
    { kind: 'select'; taskId: string; nonce: number } | { kind: 'add'; nonce: number };
}

export function BoardScreen({
  state,
  onMoveTask,
  onStatusNoted,
  compact,
  initialSelectedTaskId = null,
  onSelectedTaskChange,
  hostUnreachable,
  paletteRequest,
}: BoardScreenProps): JSX.Element {
  const layout = useBoardLayoutStyles();
  const styles = useStyles();
  const transport = useTransport();
  const extras = useBoardExtras();
  const [selectedTaskId, setSelectedTaskIdRaw] = useState(initialSelectedTaskId);
  /** Every wide-pane selection change, reported out for `App.tsx`'s own route to follow
   *  (`onSelectedTaskChange`) as well as applied locally — never for the compact paths,
   *  which never call this (`compact.card`'s own id is reported through `navigate` itself,
   *  not through this screen's selection state at all). */
  const setSelectedTaskId = useCallback(
    (id: string | null) => {
      setSelectedTaskIdRaw(id);
      onSelectedTaskChange?.(id);
    },
    [onSelectedTaskChange],
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** The card the compact board's "Move to" sheet (F3.6) is open for, or null when shut. */
  const [moveSheetTaskId, setMoveSheetTaskId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null);
  const [chainFocus, setChainFocus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Whether the shared add-task dialog is up — the desktop's own `addOpen`. */
  const [addOpen, setAddOpen] = useState(false);
  /** The column whose header "+" opened the add dialog — the desktop's own `addColumn`. */
  const [addColumn, setAddColumn] = useState<BoardColumn | null>(null);
  // The command palette's own entry into an already-mounted board (F9.5) — see
  // `paletteRequest`'s own doc comment for why `initialSelectedTaskId` alone cannot reach this.
  useEffect(() => {
    if (!paletteRequest) return;
    if (paletteRequest.kind === 'select') setSelectedTaskId(paletteRequest.taskId);
    else {
      setAddColumn(null);
      setAddOpen(true);
    }
  }, [paletteRequest, setSelectedTaskId]);
  /**
   * When the Removed-cards dialog was opened, or null while it is shut — the timestamp
   * rather than a boolean for the reason `MyTasks` holds one: the rows are labelled
   * relatively ("yesterday") and must not re-word themselves on an unrelated render.
   */
  const [archivedOpenedAt, setArchivedOpenedAt] = useState<number | null>(null);

  const { settings, saveSettings } = extras;
  // `hiddenBoardColumns` reads BOTH legacy per-tracker flags, where `settings.jira
  // .showDoneColumn` alone used to leave this board stuck honouring only JIRA's — a
  // GitHub-only user's "show done" toggle on the desktop never reached this screen.
  const hiddenColumns = hiddenBoardColumns(settings);
  const showDone = !hiddenColumns.includes('done');
  const showDetail = settings.showTaskDetail;
  /**
   * The commit-graph pane, read from the DESKTOP's own setting rather than a web-only one —
   * the same bargain every other switch in this toolbar makes. Off until settings arrive,
   * which is also `DEFAULT_SETTINGS`'s answer: the pane costs a `git log` on the desktop's
   * machine, so it opens when somebody asks for it and not because a fetch is in flight.
   */
  const showGraph = settings.showGitGraph;
  const display = settings.board;
  const boardLinks: LinkMode = settings.boardLinks;

  const projects = useMemo(() => Object.values(state.projects), [state.projects]);

  /**
   * Which board is open — `'all'` unions every board's cards, or one board's own project id.
   * Mirrors `settings.boardScopeId`, the desktop's own persisted choice (`MyTasks.tsx`), so
   * the two apps open on the same board.
   */
  const scope = settings.boardScopeId || 'all';

  /**
   * The agent projects every DELEGATION control on this screen draws from — the relay's
   * answer when the desktop gave one, and the mirrored `projects` rows when it did not.
   * Computed once and passed to every one of them, so a card's stripe, its agent name and
   * the commit graph can never be looking at two different lists. See `selectAgentProjects`
   * for why this replaces rather than merges.
   */
  const agentProjects = useMemo(
    () => selectAgentProjects(state.projects, extras.agentProjects, extras.agentProjectsLoaded),
    [state.projects, extras.agentProjects, extras.agentProjectsLoaded],
  );

  /**
   * The boards the toolbar's scope Dropdown offers — Personal plus every other project, the
   * desktop's own `board:scopes` rule. Computed straight from the mirrored `Project` rows
   * rather than a relayed round trip: the mirror already carries every project, and this is
   * the same join `store.ts`'s `board:scopes` handler runs, just read from `state.projects`
   * instead of SQLite.
   */
  const scopes = useMemo<BoardScope[]>(() => {
    const personal = state.projects[PERSONAL_PROJECT_ID];
    const list: BoardScope[] = personal
      ? [
          {
            id: personal.id,
            name: personal.name,
            color: personal.color,
            ownsTickets: false,
            archivedAt: null,
          },
        ]
      : [];
    for (const project of projects) {
      if (project.id === PERSONAL_PROJECT_ID) continue;
      list.push({
        id: project.id,
        name: project.name,
        color: project.color,
        ownsTickets: ownsTickets(project),
        archivedAt: project.archivedAt,
      });
    }
    return list;
  }, [state.projects, projects]);
  /** The scope Dropdown's closed-state label. */
  const scopeLabel = useMemo(
    () =>
      scope === 'all' ? 'All boards' : (scopes.find((s) => s.id === scope)?.name ?? 'All boards'),
    [scope, scopes],
  );

  const agentNameOf = (task: Task): string | undefined =>
    agentProjects.find((p) => p.id === task.agentProjectId)?.name;

  /** The desktop's own card set for this scope, un-archived. See `boardSelectors.ts`. */
  const boardTasks = useMemo(() => selectBoardTasks(state, scope), [state, scope]);

  /** The lookups `bucketBoardCards`' `archive` option needs to hide a ticket whose tracker
   *  project, milestone or epic has been archived (F14.5) — epics are looked up in
   *  `boardTasks`, this scope's own rows. */
  const archiveIndex = useMemo(
    () =>
      archiveIndexOf(Object.values(state.milestones), boardTasks, Object.values(state.projects)),
    [state.milestones, boardTasks, state.projects],
  );

  /**
   * The cards that have LEFT this board. No fetch and no `board:archived` equivalent: the
   * archived rows are already in `state.tasks` (the mirror carries them, and
   * `boardSelectors.ts` says why ingest must not drop them), so this is the same list the
   * desktop's dialog shows, minus the step rows `archivedCards` filters out.
   */
  const removedCards = useMemo(
    () => archivedCards(selectArchivedTasks(state, scope)),
    [state, scope],
  );

  const mrsByTask = useMemo(
    () => mergeRequestsByTask(extras.mergeRequests),
    [extras.mergeRequests],
  );
  const attachmentsByTask = useMemo(() => byTask(extras.attachments), [extras.attachments]);
  const tasksById = useMemo(() => new Map(boardTasks.map((t) => [t.id, t])), [boardTasks]);
  /** A native ticket's parent epic, by name (Phase 24) — `TaskCard`'s own `epicName` prop. */
  const epicNameOf = (task: Task): string | undefined =>
    task.epicTaskId ? tasksById.get(task.epicTaskId)?.title : undefined;

  /**
   * Cards the add-task dialog may hang a hand-written step under, and — asked the other way
   * round — chain the new card after. `MyTasks`'s own `parentCandidates`: every top-level
   * card on this board, from the mirrored rows this screen already draws.
   */
  const parentCandidates = useMemo(
    () => boardTasks.filter((t) => !t.parentTaskId && !isVariantRow(t)),
    [boardTasks],
  );

  /** The chain the focus toggle narrows the board to — `MyTasks`'s own `focusIds`. */
  const focusIds = useMemo(
    () => (chainFocus && selectedTaskId ? chainComponent(extras.chainLinks, selectedTaskId) : null),
    [chainFocus, selectedTaskId, extras.chainLinks],
  );

  /**
   * The board's cards parked onto the shelf, mirroring `MyTasks.tsx`'s own `shelvedIds` —
   * `boardTasks` is already this scope's own cards, so the flat id list needs no per-scope
   * keying (see `partitionShelved`).
   */
  const shelvedIds = useMemo(() => shelvedCardSet(settings.shelvedCardIds), [settings]);

  const { cardsByColumn, shelvedCards } = useMemo(() => {
    // Overlay any still-pending edit before grouping/columning, so a dragged card jumps to
    // its destination column the instant you let go — the same optimism `MyTasks.tsx`'s own
    // `optimisticMove` gives the desktop board, just computed from `displayStatus`
    // (`cloudBoardStore.ts`) instead of local SQLite state.
    const displayTasks = boardTasks.map((task) => ({
      ...task,
      status: displayStatus(state, task),
    }));
    return bucketBoardCards(
      displayTasks,
      mrsByTask,
      focusIds,
      shelvedIds,
      extras.attention.taskIds,
      { index: archiveIndex },
    );
  }, [boardTasks, state, mrsByTask, focusIds, extras.attention.taskIds, shelvedIds, archiveIndex]);

  const hiddenDone = useMemo(
    () => hiddenColumnsSummary(cardsByColumn.get('done') ?? [], ['done']),
    [cardsByColumn],
  );

  /** The compact board's column tabs — absent entirely on the wide path. */
  const switcherItems = useMemo(
    () => columnSwitcherItems(cardsByColumn, hiddenColumns),
    [cardsByColumn, hiddenColumns],
  );

  /** Where every card is, for the arrows — see `useCardAnchors`. */
  const anchors = useCardAnchors(cardsByColumn);

  /**
   * Where each chained card stands. `MyTasks`'s own `chainStates`, over the mirrored rows
   * and the relayed links — the same functions, so the chip on the web says what it says on
   * the desktop. Capped by each mirrored project's Ready lanes, as `MyTasks` caps it.
   */
  const chainState = useMemo(
    () =>
      chainStates(extras.chainLinks, tasksById, extras.liveRunTaskIds, {
        capOf: (projectId) => state.projects[projectId]?.readyLanes ?? DEFAULT_READY_LANES,
        openPrTaskIds: openPrTaskIds(extras.mergeRequests),
        cards: boardTasks,
      }),
    [
      extras.chainLinks,
      tasksById,
      extras.liveRunTaskIds,
      state.projects,
      extras.mergeRequests,
      boardTasks,
    ],
  );

  const pendingTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of Object.values(state.tasks)) {
      if (isTaskPending(state, task.id)) ids.add(task.id);
    }
    return ids;
  }, [state]);

  /**
   * The id `TaskDetail`/`CompactCardScreen` is actually showing — `compact.card`'s own id
   * when the compact shell has opened a card full-screen (F3.7), since there is no drag or
   * detail-pane click on that screen to have set `selectedTaskId` with; the wide pane's own
   * selection otherwise.
   */
  const effectiveSelectedId = compact?.card?.id ?? selectedTaskId;

  /**
   * The card the pane is showing — with the same pending overlay its column applies, so a
   * card dragged to DONE does not read "In progress" in the pane beside it.
   */
  const selectedTask = useMemo(() => {
    const task = effectiveSelectedId ? (state.tasks[effectiveSelectedId] ?? null) : null;
    return task ? { ...task, status: displayStatus(state, task) } : null;
  }, [state, effectiveSelectedId]);

  /**
   * The four app-wide registries a ticket can point at, scoped to the selected card's
   * project — see `useTicketRegistries`. The board's own `peopleById` reads `registries.people`
   * too, the same bargain `MyTasks.tsx` makes: an assignee can be anyone, not just someone on
   * the selected card's own project, so it must not depend on which card is selected.
   */
  const registries = useTicketRegistries(selectedTask?.projectId ?? null);
  const peopleById = useMemo(
    () => new Map(registries.people.map((p) => [p.id, p])),
    [registries.people],
  );
  /** A native ticket's assignee (Phase 24) — `TaskCard`'s own `assignee` prop. */
  const assigneeOf = (task: Task): Person | undefined =>
    task.assigneeId ? peopleById.get(task.assigneeId) : undefined;

  /**
   * A desktop that was asleep when this screen mounted leaves `registries`'s seed rejected
   * for good — `useInitialLoad` does not retry on its own. Once `hostUnreachable` clears,
   * somebody is home again, so ask it once more. Fails soft the same way `useBoardExtras`
   * does: no banner, since the status bar's dot already said nobody was home.
   */
  const wasHostUnreachable = useRef(hostUnreachable);
  useEffect(() => {
    if (wasHostUnreachable.current && !hostUnreachable) registries.retry();
    wasHostUnreachable.current = hostUnreachable;
  }, [hostUnreachable, registries.retry]);

  /**
   * The card the "Move to" sheet is open for — the same `displayStatus` overlay
   * {@link selectedTask} carries, so the sheet's current-column checkmark agrees with
   * where the card's own column already shows it sitting.
   */
  const moveSheetTask = useMemo(() => {
    const task = moveSheetTaskId ? (state.tasks[moveSheetTaskId] ?? null) : null;
    return task ? { ...task, status: displayStatus(state, task) } : null;
  }, [state, moveSheetTaskId]);

  /**
   * The chain the pane needs: the selected card's own steps, or — when a STEP is selected,
   * which `TaskSteps` makes reachable from the card above it — its siblings, which is what
   * lets the pane say "step 2 of 5". `MyTasks.tsx`'s `chain`, over the mirrored rows.
   */
  const chain = useMemo(() => {
    if (!selectedTask) return [];
    const parentId = selectedTask.parentTaskId ?? selectedTask.id;
    return boardTasks.filter((t) => t.parentTaskId === parentId).sort((a, b) => a.order - b.order);
  }, [boardTasks, selectedTask]);

  /** The card a shown step belongs to — the pane's breadcrumb back out of it. */
  const parentOfSelected = useMemo(
    () => (selectedTask?.parentTaskId ? (state.tasks[selectedTask.parentTaskId] ?? null) : null),
    [state.tasks, selectedTask],
  );

  const selectedLink = useMemo(
    () => extras.chainLinks.find((l) => l.id === selectedLinkId) ?? null,
    [extras.chainLinks, selectedLinkId],
  );
  // The same routed geometry `ChainOverlay` draws, memoised once here rather than recomputed
  // by hand — an endpoint the board is not showing has a stub rather than an arrow, and
  // `linkMidpoint` already returns null for exactly that case.
  const chainDrawing = useMemo(
    () =>
      buildChainDrawing({
        links: extras.chainLinks,
        anchors: anchors.rects,
        cardColumns: anchors.cardColumns,
        tasksById,
        litTaskIds: EMPTY_TASK_IDS,
        boardWidth: anchors.bounds.width,
        layout: anchors.layout,
      }),
    [
      extras.chainLinks,
      anchors.rects,
      anchors.cardColumns,
      tasksById,
      anchors.bounds.width,
      anchors.layout,
    ],
  );
  const selectedLinkAt = useMemo(
    () => (selectedLink ? linkMidpoint(chainDrawing, selectedLink.id) : null),
    [selectedLink, chainDrawing],
  );

  // The Off/Focus/All switch (F13.20) — the desktop's own `settings.boardLinks`, so the
  // two hosts agree on how the links look the same way they already agree on every other
  // toolbar switch.
  const linkState = useMemo(
    () => linkView(extras.chainLinks, boardLinks, selectedTaskId),
    [extras.chainLinks, boardLinks, selectedTaskId],
  );
  useGlobalShortcut(
    'l',
    () =>
      void saveSettings({ ...settings, boardLinks: nextLinkMode(boardLinks) }).catch(reportError),
    { ignoreInFields: true },
  );

  // Widens the gutters (`columnsLinked`/`listLinked`) only while there is something to route
  // through them — a board with no links yet keeps its ordinary, narrower gap — and the
  // switch is not Off, where nothing is drawn over the board at all.
  const linksDrawn = extras.chainLinks.length > 0 && linkState.drawn;

  // Off draws no arrow at all, so each card says what it would have said in words instead
  // (`linkChips.ts`) — absent every other mode, which is what leaves `chainChip` alone there.
  const linkChipsOf =
    boardLinks === 'off'
      ? (t: Task) => linkChips(t.id, extras.chainLinks, tasksById, extras.liveRunTaskIds)
      : undefined;

  // Delete or Backspace erases the selected arrow, Escape lets it go — the desktop's own
  // keyboard contract, on the window rather than the path because an SVG `<path>` cannot
  // hold focus.
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
        e.preventDefault();
        void extras.removeLink(selectedLinkId).catch(reportError);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLinkId, extras]);

  const reportError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const onBoardIds = useMemo(() => new Set(boardTasks.map((t) => t.id)), [boardTasks]);

  /**
   * Move a card onto the shelf, or back off it — the desktop's own `toggleShelved`, over
   * `saveSettings` rather than the direct IPC write.
   */
  const toggleShelved = useCallback(
    (taskId: string) => {
      void saveSettings({
        ...settings,
        shelvedCardIds: toggleShelvedCard(settings.shelvedCardIds, taskId, onBoardIds),
      }).catch(reportError);
    },
    [settings, saveSettings, onBoardIds, reportError],
  );

  /** A card dropped onto the shelf strip — always shelves it, never the reverse. */
  const dropOnShelf = useCallback(
    (taskId: string) => {
      void saveSettings({
        ...settings,
        shelvedCardIds: ensureShelvedCard(settings.shelvedCardIds, taskId, onBoardIds),
      }).catch(reportError);
    },
    [settings, saveSettings, onBoardIds, reportError],
  );

  const toggleShelfFolded = useCallback(() => {
    void saveSettings({ ...settings, shelfFolded: !settings.shelfFolded }).catch(reportError);
  }, [settings, saveSettings, reportError]);

  // Stable identity for `TaskDetail`'s `onStatusChanged`: the pane keys `loadActivity`'s own
  // effect on this prop's identity, so an inline arrow rebuilt every render forced a reload —
  // and its own `jira:markRead`/`github:markRead` reply — on every poll.
  const handleStatusChanged = useCallback(
    (updated: Task) => {
      if (isManualStatus(updated.status)) onStatusNoted(updated.id, updated.status);
    },
    [onStatusNoted],
  );

  /** Picking a card — and, while a link is armed from the keyboard, drawing it instead. */
  const selectTask = useCallback(
    (id: string) => {
      setSelectedLinkId(null);
      if (linkDrag && linkDrag.at === null && linkDrag.fromTaskId !== id) {
        void extras
          .drawLink(linkDrag.fromTaskId, id)
          .then((refusal) => refusal && setError(refusal))
          .catch(reportError);
        setLinkDrag(null);
        return;
      }
      setLinkDrag(null);
      setSelectedTaskId(id);
    },
    [linkDrag, extras, reportError, setSelectedTaskId],
  );

  const { askAfterMove, dialog: releaseDialog } = useReleaseOnDone();
  /** A card dropped into a column, on either the wide board or the compact one. */
  const handleDropInColumn = useCallback(
    (taskId: string, dropColumn: BoardColumn) => {
      setDraggingId(null);
      if (
        !allowedDropColumns({ hiddenColumns, pending: pendingTaskIds.has(taskId) }).includes(
          dropColumn,
        )
      ) {
        return;
      }
      const before = tasksById.get(taskId);
      // After the move, never instead of it: a human's move into Done may ask whether to
      // release the cards chained after this one (`@tm/ui/ReleaseWaitingDialog`). A refused
      // move asks nothing — the board's pending overlay already rolled it back.
      onMoveTask(taskId, dropColumn).then(
        (after) => {
          if (before) {
            askAfterMove(before, after, extras.chainLinks, tasksById, extras.mergeRequests);
          }
        },
        () => {},
      );
      // The drag that returns a shelved card to a column is the toggle's other click — see
      // `MyTasks.tsx`'s own `onDropInColumn`.
      if (shelvedIds.has(taskId)) toggleShelved(taskId);
    },
    [
      hiddenColumns,
      pendingTaskIds,
      onMoveTask,
      shelvedIds,
      toggleShelved,
      tasksById,
      askAfterMove,
      extras.chainLinks,
      extras.mergeRequests,
    ],
  );

  /**
   * Every prop `TaskDetail` needs beyond `task` and `section` — shared between the wide
   * pane's own `<TaskDetail>` below and `CompactCardScreen` (F3.7), so a card drawn
   * full-screen on a phone and the same card drawn in the wide pane's sidebar can never
   * drift into disagreeing about what either one offers. `onOpenTask` is the one prop that
   * has to differ by host: the wide pane swaps its OWN selection in place
   * (`setSelectedTaskId`), where a full-screen card route has no "in place" to swap —
   * opening another card (a breadcrumb, a step) there is `compact.onOpenCard`'s own
   * navigation, the identical call a column tap already makes.
   */
  const taskDetailProps = {
    agentProjects,
    boards: scopes,
    subtasks: chain,
    parentTask: parentOfSelected,
    mergeRequests: selectedTask ? (mrsByTask.get(selectedTask.id) ?? []) : [],
    afterMergePipeline: settings.features.afterMergePipeline,
    mrRebaseButton: settings.features.mrRebaseButton,
    mrMergeButton: settings.features.mrMergeButton,
    quietAgentProgress: settings.features.quietAgentProgress,
    attachments: selectedTask ? (attachmentsByTask.get(selectedTask.id) ?? []) : [],
    parentAttachments: parentOfSelected ? (attachmentsByTask.get(parentOfSelected.id) ?? []) : [],
    subtaskAttachments: chain.flatMap((s) => attachmentsByTask.get(s.id) ?? []),
    statusKeywords: settings.statusKeywords,
    priorityDisplay: display.priorityDisplay,
    attention: extras.attention,
    liveRunTaskIds: extras.liveRunTaskIds,
    mergingTaskIds: extras.mergingTaskIds,
    chainWaitingOn: selectedTask ? chainState.get(selectedTask.id)?.waitingOn : undefined,
    chainMergeHeld: selectedTask ? chainState.get(selectedTask.id)?.mergeHeld : undefined,
    chainLinks: extras.chainLinks,
    chainTasksById: tasksById,
    people: registries.people,
    milestones: registries.milestones,
    labels: registries.labels,
    ticketLinks: registries.links,
    ticketProjects: Object.values(state.projects),
    onUnlinkChain: (linkId: string) => void extras.removeLink(linkId).catch(reportError),
    onOpenTask: compact?.card ? compact.onOpenCard : setSelectedTaskId,
    readOnlyNotice: RELAY_NOTICE,
    hostUnreachable,
    // The pane's State dropdown has already sent its own `task:setStatus` through the
    // transport by the time this runs (`TaskDetailsCell`), so this only records the
    // optimistic overlay a drag gets — it must not send a second command. The task it hands
    // back is the transport's stub (`{ id, status }`), never a row worth merging into
    // `state.tasks`; the next poll brings the real one.
    onStatusChanged: handleStatusChanged,
    onSubtasksChanged: extras.refresh,
  };

  // Full-screen: none of `layout.root`'s board/detail-pane/graph row applies — there is no
  // second pane sharing this screen with the card the way the wide layout's sidebar does.
  if (compact?.card) {
    return (
      <CompactCardScreen
        task={selectedTask}
        section={compact.card.section}
        onSectionChange={compact.card.onSectionChange}
        onBack={compact.card.onBack}
        {...taskDetailProps}
      />
    );
  }

  return (
    <div className={layout.root}>
      <div className={layout.board}>
        <BoardToolbar
          scope={scope}
          scopeLabel={scopeLabel}
          scopes={scopes}
          onScopeChange={(next) =>
            void saveSettings({ ...settings, boardScopeId: next }).catch(reportError)
          }
          showDone={showDone}
          hiddenDone={hiddenDone}
          onShowDoneChange={(next) =>
            void saveSettings({
              ...settings,
              board: {
                ...settings.board,
                hiddenColumns: withColumnHidden(hiddenColumns, 'done', !next),
              },
            }).catch(reportError)
          }
          showDetail={showDetail}
          onShowDetailChange={(next) =>
            void saveSettings({ ...settings, showTaskDetail: next }).catch(reportError)
          }
          showGraph={showGraph}
          onShowGraphChange={(next) =>
            void saveSettings({ ...settings, showGitGraph: next }).catch(reportError)
          }
          chainFocus={chainFocus}
          onChainFocusChange={setChainFocus}
          canFocusChain={selectedTaskId !== null}
          boardLinks={boardLinks}
          onBoardLinksChange={(next) =>
            void saveSettings({ ...settings, boardLinks: next }).catch(reportError)
          }
          currentSprintOnly={settings.jira.currentSprintOnly}
          onCurrentSprintOnlyChange={(next) =>
            void saveSettings({
              ...settings,
              jira: { ...settings.jira, currentSprintOnly: next },
            }).catch(reportError)
          }
          syncing={syncing}
          onSync={() => {
            setSyncing(true);
            setError(null);
            void transport
              .invoke('jira:sync')
              .catch(reportError)
              .finally(() => setSyncing(false));
          }}
          archivedCount={removedCards.length}
          onOpenArchived={() => setArchivedOpenedAt(Date.now())}
          // The trigger only — the dialog itself is mounted at the bottom of the tree, the
          // way the desktop mounts it, because it is `open`-controlled rather than wrapped
          // round its own button. Small and primary, exactly as `MyTasks` renders it: it
          // sits in a row of small controls, and a default-size button would set the
          // toolbar's height and make the two boards visibly different.
          addTask={
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
          }
        />

        {error && <Caption1 className={styles.error}>{error}</Caption1>}

        {/* The compact board's column tabs — standing in for the wide board's five
            side-by-side columns, which a single-column layout has no room for. */}
        {compact && (
          <ColumnSwitcher
            items={switcherItems}
            selected={compact.column}
            onSelect={compact.onColumnChange}
          />
        )}

        {/* The empty state is about the CARD SET, not the mirror: a board with a hundred rows
            in other projects still has nothing to draw, and saying "no board data" there would
            be a lie. Only when nothing at all has arrived is it a sync that hasn't happened. */}
        {boardTasks.length === 0 ? (
          <Caption1 className={styles.empty}>
            {projects.length === 0 && Object.keys(state.tasks).length === 0
              ? 'No board data yet — waiting on the first sync from your desktop app.'
              : `No cards on ${scope === 'all' ? 'any board' : `the ${scopeLabel} board`}.`}
          </Caption1>
        ) : compact ? (
          // The compact board: no chain overlay, no link-drag handles, no popover — there is
          // no second column to draw an arrow into, and `chainPositionOf` says in words what
          // the arrows would have. `compact.column` is only `null` when every column is
          // hidden, which this simply renders as nothing rather than an empty-state lie (the
          // board is not empty — there is just nowhere configured to show it).
          compact.column && (
            <KanbanColumn
              column={compact.column}
              label={COLUMN_LABEL[compact.column]}
              cards={cardsByColumn.get(compact.column) ?? []}
              layout="compact"
              epicNameOf={epicNameOf}
              assigneeOf={assigneeOf}
              agentNameOf={agentNameOf}
              attentionTaskIds={extras.attention.taskIds}
              liveRunTaskIds={extras.liveRunTaskIds}
              runPurposes={extras.runPurposes}
              runStartedAt={extras.runStartedAt}
              mergingTaskIds={extras.mergingTaskIds}
              chainStateOf={(t) => chainState.get(t.id)}
              chainPositionOf={(t) => chainPosition(extras.chainLinks, t.id) ?? undefined}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onStopTask={(taskId) => void extras.stopTask(taskId).catch(reportError)}
              onResumeTask={(taskId) => void extras.resumeTask(taskId).catch(reportError)}
              onToggleShelved={settings.features.shelf ? toggleShelved : undefined}
              onMoveTask={setMoveSheetTaskId}
              onSelectTask={(id) => compact.onOpenCard(id)}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onDropInColumn={handleDropInColumn}
            />
          )
        ) : (
          <div
            className={mergeClasses(layout.columns, linksDrawn && layout.columnsLinked)}
            onClick={() => setSelectedLinkId(null)}
          >
            {allowedDropColumns({ hiddenColumns, pending: false }).map((column) => (
              <KanbanColumn
                key={column}
                column={column}
                label={COLUMN_LABEL[column]}
                cards={cardsByColumn.get(column) ?? []}
                onAddCard={(c) => {
                  setAddColumn(c);
                  setAddOpen(true);
                }}
                epicNameOf={epicNameOf}
                assigneeOf={assigneeOf}
                agentNameOf={agentNameOf}
                attentionTaskIds={extras.attention.taskIds}
                liveRunTaskIds={extras.liveRunTaskIds}
                runPurposes={extras.runPurposes}
                runStartedAt={extras.runStartedAt}
                mergingTaskIds={extras.mergingTaskIds}
                anchorRef={anchors.anchorRef}
                linksDrawn={linksDrawn}
                dimmedTaskIds={linkState.dimmedTaskIds}
                linkDrag={linkDrag}
                onLinkStart={(taskId) => {
                  setSelectedLinkId(null);
                  setLinkDrag({
                    fromTaskId: taskId,
                    states: linkDropStates(extras.chainLinks, boardTasks, taskId),
                    at: null,
                    overTaskId: null,
                  });
                }}
                onLinkEnd={() => setLinkDrag(null)}
                onLinkTo={(fromTaskId, toTaskId) => {
                  setLinkDrag(null);
                  void extras
                    .drawLink(fromTaskId, toTaskId)
                    .then((refusal) => refusal && setError(refusal))
                    .catch(reportError);
                }}
                onLinkArm={(taskId) => {
                  setSelectedLinkId(null);
                  setLinkDrag((at) =>
                    at?.fromTaskId === taskId
                      ? null
                      : {
                          fromTaskId: taskId,
                          states: linkDropStates(extras.chainLinks, boardTasks, taskId),
                          at: null,
                          overTaskId: null,
                        },
                  );
                }}
                chainStateOf={(t) => chainState.get(t.id)}
                // A file hold's "Make this an arrow" — `chain:link` through the relay, exactly
                // as a drawn arrow goes. The compact board draws no arrows, so it has no button.
                onMakeArrow={(fromTaskId, toTaskId) => {
                  void extras
                    .drawLink(fromTaskId, toTaskId)
                    .then((refusal) => refusal && setError(refusal))
                    .catch(reportError);
                }}
                linkChipsOf={linkChipsOf}
                selectedTaskId={selectedTaskId}
                draggingId={draggingId}
                onStopTask={(taskId) => void extras.stopTask(taskId).catch(reportError)}
                // The card decides when to OFFER this (`canResumeWork`, from `stoppedAt` and
                // the card's own steps); the column only needs the prop to exist, and until
                // now this app was the only host that did not pass it.
                onResumeTask={(taskId) => void extras.resumeTask(taskId).catch(reportError)}
                onToggleShelved={settings.features.shelf ? toggleShelved : undefined}
                onSelectTask={selectTask}
                onDragStartTask={setDraggingId}
                onDragEndTask={() => setDraggingId(null)}
                onDropInColumn={handleDropInColumn}
              />
            ))}
            {/* Last, so the arrows paint over the cards — and inside the scroll container,
                so they travel with them. It takes no pointer events; only the strokes do.
                Absent entirely in Off: nothing to draw, and nothing for the popover below
                to hang off either. */}
            {linkState.drawn && (
              <ChainOverlay
                links={extras.chainLinks}
                anchors={anchors.rects}
                cardColumns={anchors.cardColumns}
                layout={anchors.layout}
                tasksById={tasksById}
                runningTaskIds={extras.liveRunTaskIds}
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
            {linkState.drawn && selectedLink && selectedLinkAt && (
              <ChainLinkPopover
                link={selectedLink}
                fromTitle={tasksById.get(selectedLink.fromTaskId)?.title ?? 'another card'}
                toTitle={tasksById.get(selectedLink.toTaskId)?.title ?? 'another card'}
                at={selectedLinkAt}
                boardWidth={anchors.bounds.width}
                onSetGate={(gate) =>
                  void extras.setLinkGate(selectedLink.id, gate).catch(reportError)
                }
                onRemove={() => void extras.removeLink(selectedLink.id).catch(reportError)}
              />
            )}
          </div>
        )}
        {/* Anchored to the BOARD (`layout.chainLegend`), never a child of the columns grid —
            see `ChainLegend`'s own comment for the bug a grid child used to cause. Absent on
            the compact board, same as the overlay itself above. */}
        {!compact && linksDrawn && (
          <div className={layout.chainLegend}>
            <ChainLegend />
          </div>
        )}
        {settings.features.shelf && (
          <ShelfStrip
            cards={shelvedCards}
            folded={settings.shelfFolded}
            onToggleFolded={toggleShelfFolded}
            epicNameOf={epicNameOf}
            assigneeOf={assigneeOf}
            agentNameOf={agentNameOf}
            attentionTaskIds={extras.attention.taskIds}
            liveRunTaskIds={extras.liveRunTaskIds}
            runPurposes={extras.runPurposes}
            runStartedAt={extras.runStartedAt}
            mergingTaskIds={extras.mergingTaskIds}
            selectedTaskId={selectedTaskId}
            draggingId={draggingId}
            onStopTask={(taskId) => void extras.stopTask(taskId).catch(reportError)}
            onResumeTask={(taskId) => void extras.resumeTask(taskId).catch(reportError)}
            onSelectTask={selectTask}
            onDragStartTask={setDraggingId}
            onDragEndTask={() => setDraggingId(null)}
            onToggleShelved={toggleShelved}
            onMoveTask={compact ? setMoveSheetTaskId : undefined}
            onDropOnShelf={dropOnShelf}
          />
        )}
        {compact && (
          <MoveToSheet
            options={
              moveSheetTask
                ? moveSheetOptions(moveSheetTask, {
                    hiddenColumns,
                    pending: pendingTaskIds.has(moveSheetTask.id),
                  })
                : []
            }
            title={moveSheetTask?.title ?? ''}
            open={moveSheetTask !== null}
            onPick={(column) => moveSheetTask && handleDropInColumn(moveSheetTask.id, column)}
            onClose={() => setMoveSheetTaskId(null)}
          />
        )}
      </div>

      {/* The desktop's own pane, the same component — and now with the same props, so it
          draws the same sections rather than degrading to a card and a timeline. Never on
          the compact board: there is no room for it, and no gesture here opens it anyway
          (`compact.onOpenCard` leaves the board for the card screen instead). Also never
          with nothing selected — the empty-state placeholder used to hold the pane's full
          width for nothing (the 2026-10-18 screenshot review); see `MyTasks.tsx`'s own fix. */}
      {!compact && showDetail && selectedTask && (
        <div className={layout.right}>
          <TaskDetailHost
            taskId={selectedTask?.id ?? null}
            task={selectedTask}
            {...taskDetailProps}
          />
        </div>
      )}

      {/* The desktop's commit graph, over the relay. Last in the row so folding it away never
          shifts the detail pane sideways, and unmounted rather than hidden for the reason the
          desktop unmounts it: a graph nobody is looking at should not be asking a desktop to
          re-read a repository every time a card changes. Never on the compact board — same
          reason as the detail pane above. */}
      {!compact && showGraph && (
        <div className={layout.graph}>
          <GitGraphPane
            projects={agentProjects}
            selectedTask={selectedTask}
            // The whole board, so a branch can carry the CARD's title instead of `orch/…`.
            tasksById={tasksById}
            // The only thing on the drawing allowed a colour — see `GRAPH_INK`.
            runningTaskIds={extras.liveRunTaskIds}
          />
        </div>
      )}

      {/* The desktop's own add-task dialog, the same component with the same props — so a
          card made here can carry a project, a description, a type, a phase, a parent, a
          chain link and a JIRA ticket, instead of the title-and-phase pair the web's own
          fork of this dialog could ask for. It talks to the engine through the transport
          (`task:create`, `task:addSubtask`, `chain:link`, `jira:*`), so every field it
          collects is applied by the desktop's own handler and lands in full. */}
      <AddTaskDialog
        open={addOpen}
        // The board open when Add is pressed — a project's own scope preselects that board
        // in the dialog's Board dropdown, rather than always defaulting to Personal.
        projectId={scope === 'all' ? PERSONAL_PROJECT_ID : scope}
        phases={[]}
        parents={parentCandidates}
        // The same cards, asked a different question — see `parentCandidates`.
        chainCandidates={parentCandidates}
        jiraEnabled={settings.jira.enabled}
        agentProjects={agentProjects}
        // A browser has no OS file picker and no path for a dropped `File`, so the whole
        // files section is one thing this host cannot do rather than a control to grey out.
        filesEnabled={false}
        column={addColumn ?? undefined}
        onClose={() => {
          setAddOpen(false);
          setAddColumn(null);
        }}
        // The new card itself arrives on the next board poll (the desktop mirrors the write);
        // this re-reads the relayed lists, which is where a chain link drawn at creation is.
        onCreated={extras.refresh}
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
        // Left open on purpose, exactly as the desktop leaves it: restoring one card of five
        // is a normal thing to do, and the list shortens under you as each goes back.
        onRestore={(taskId) => extras.restoreTask(taskId).catch(reportError)}
      />
      {releaseDialog}
    </div>
  );
}
