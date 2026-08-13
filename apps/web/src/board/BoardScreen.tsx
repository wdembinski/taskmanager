/**
 * The web board: `GET /v1/board`'s tasks/projects, drawn as the desktop's My Tasks screen —
 * the same frame (`useBoardLayoutStyles`), the same columns in the same order, the same
 * cards (`KanbanColumn`/`TaskCard`), the same ordering rule (`sortCards`), the same arrows
 * over the top (`ChainOverlay`/`ChainLinkPopover`), and the same 40% detail pane down the
 * right.
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
 * passed, and the pane draws what it always could. The two things that stay different are
 * honest ones: an edit is applied by a desktop client rather than in-process, so it lands on
 * the next poll rather than instantly; and the host-only channels (`@tm/shared/ipcRelay`)
 * refuse with the reason they are host-only.
 *
 * The board's own preferences live in `settings:get`/`settings:save` now rather than in this
 * app's `localStorage`, so the switches match the desktop's instead of being a second set of
 * the same three toggles that silently disagreed with them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Caption1, makeStyles } from '@fluentui/react-components';
import {
  COLUMN_META,
  focusCards,
  groupSubtasks,
  hiddenDoneSummary,
  sortCards,
  visibleColumns,
  type BoardCard,
} from '@tm/ui/board/boardColumns';
import { columnForTask, statusForColumn } from '@tm/shared/board';
import { KanbanColumn } from '@tm/ui/board/KanbanColumn';
import { ChainOverlay } from '@tm/ui/board/ChainOverlay';
import { ChainLinkPopover } from '@tm/ui/board/ChainLinkPopover';
import { useCardAnchors } from '@tm/ui/board/useCardAnchors';
import { arrowRoute } from '@tm/ui/board/chainArrows';
import { linkDropStates, type LinkDragState } from '@tm/ui/board/chainDrag';
import { foldedCardSet, toggleFoldedCard } from '@tm/ui/board/foldedSteps';
import { TaskDetail } from '@tm/ui/TaskDetail';
import { useTransport } from '@tm/ui/transport';
import { useBoardLayoutStyles } from '@tm/ui/board/boardLayout';
import { ArchivedCardsDialog, archivedCards } from '@tm/ui/board/ArchivedCardsDialog';
import { awaitingMerge, blockedBy, chainComponent } from '@tm/shared/taskChain';
import { isManualStatus, type BoardColumn, type ManualStatus, type Task } from '@tm/shared/model';
import { AddTaskDialog } from './AddTaskDialog';
import { BoardToolbar } from './BoardToolbar';
import { selectArchivedTasks, selectBoardTasks } from './boardSelectors';
import { displayStatus, isTaskPending, type CloudBoardState } from './cloudBoardStore';
import { mergeRequestsByTask, useBoardExtras, byTask } from './useBoardExtras';

const useStyles = makeStyles({
  /** The empty state, in the board's own half of the screen rather than across all of it. */
  empty: { padding: '8px 4px' },
  error: { padding: '4px', color: '#f1707b' },
});

/**
 * The one sentence the pane wears (`TaskDetail`'s `readOnlyNotice`).
 *
 * It no longer says "read-only", because that stopped being true. What it says instead is
 * the thing a reader genuinely cannot infer from a pane that looks fully live: an edit here
 * is carried out by the desktop app, so it needs one to be running, and the result appears
 * when it next reports back rather than the instant the button settles.
 */
const RELAY_NOTICE =
  'Edits here are carried out by your desktop app and show up on its next sync — a few ' +
  'seconds. A few controls (file pickers, credentials, window buttons) only work over there.';

const COLUMN_LABEL: Record<BoardColumn, string> = Object.fromEntries(
  COLUMN_META.map((c) => [c.column, c.label]),
) as Record<BoardColumn, string>;

export interface BoardScreenProps {
  state: CloudBoardState;
  everSeenClient: boolean;
  onSetStatus: (taskId: string, status: ManualStatus) => void;
  /**
   * A status change the DETAIL PANE has already sent for itself: record the same pending
   * overlay a drag gets, without putting a second identical command on the wire.
   */
  onStatusNoted: (taskId: string, status: ManualStatus) => void;
  onCreateTask: (projectId: string, input: { title: string; phase?: string }) => Promise<void>;
}

export function BoardScreen({
  state,
  everSeenClient,
  onSetStatus,
  onStatusNoted,
  onCreateTask,
}: BoardScreenProps): JSX.Element {
  const layout = useBoardLayoutStyles();
  const styles = useStyles();
  const transport = useTransport();
  const extras = useBoardExtras();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null);
  const [chainFocus, setChainFocus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /**
   * When the Removed-cards dialog was opened, or null while it is shut — the timestamp
   * rather than a boolean for the reason `MyTasks` holds one: the rows are labelled
   * relatively ("yesterday") and must not re-word themselves on an unrelated render.
   */
  const [archivedOpenedAt, setArchivedOpenedAt] = useState<number | null>(null);

  const { settings, saveSettings } = extras;
  const showDone = settings.jira.showDoneColumn;
  const showDetail = settings.showTaskDetail;
  const display = settings.board;

  const projects = useMemo(() => Object.values(state.projects), [state.projects]);
  /**
   * The card's optional lines, read the desktop's way: `projectNameOf` is the JIRA project a
   * ticket is filed under (`phase`), not the local project — every card on this board is in
   * Personal, so that one would say the same word on all of them — and the stripe is the
   * repo the card is tagged with, which is what the desktop colours it by.
   *
   * Both now read the real agent-project list rather than the mirrored `Project` rows, so a
   * card's stripe is the same colour it is on the desktop.
   */
  const projectNameOf = (task: Task): string | undefined =>
    task.externalSource === 'jira' ? task.phase || undefined : undefined;
  const agentNameOf = (task: Task): string | undefined =>
    extras.agentProjects.find((p) => p.id === task.agentProjectId)?.name;
  const projectColorOf = (task: Task): string | undefined =>
    extras.agentProjects.find((p) => p.id === task.projectTagId)?.color || undefined;

  /** The desktop's own card set — Personal, un-archived. See `boardSelectors.ts`. */
  const boardTasks = useMemo(() => selectBoardTasks(state), [state]);

  /**
   * The cards that have LEFT this board. No fetch and no `board:archived` equivalent: the
   * archived rows are already in `state.tasks` (the mirror carries them, and
   * `boardSelectors.ts` says why ingest must not drop them), so this is the same list the
   * desktop's dialog shows, minus the step rows `archivedCards` filters out.
   */
  const removedCards = useMemo(() => archivedCards(selectArchivedTasks(state)), [state]);

  const mrsByTask = useMemo(
    () => mergeRequestsByTask(extras.mergeRequests),
    [extras.mergeRequests],
  );
  const attachmentsByTask = useMemo(() => byTask(extras.attachments), [extras.attachments]);
  const tasksById = useMemo(() => new Map(boardTasks.map((t) => [t.id, t])), [boardTasks]);

  /** The chain the focus toggle narrows the board to — `MyTasks`'s own `focusIds`. */
  const focusIds = useMemo(
    () => (chainFocus && selectedTaskId ? chainComponent(extras.chainLinks, selectedTaskId) : null),
    [chainFocus, selectedTaskId, extras.chainLinks],
  );

  const cardsByColumn = useMemo(() => {
    // Overlay any still-pending edit before grouping/columning, so a dragged card jumps to
    // its destination column the instant you let go — the same optimism `MyTasks.tsx`'s own
    // `optimisticMove` gives the desktop board, just computed from `displayStatus`
    // (`cloudBoardStore.ts`) instead of local SQLite state.
    const displayTasks = boardTasks.map((task) => ({
      ...task,
      status: displayStatus(state, task),
    }));
    const byColumn = new Map<BoardColumn, BoardCard[]>();
    for (const meta of COLUMN_META) byColumn.set(meta.column, []);
    for (const card of focusCards(groupSubtasks(displayTasks, mrsByTask), focusIds)) {
      byColumn.get(columnForTask(card.task))?.push(card);
    }
    // The desktop's ordering, so the same board reads the same way in both places: cards
    // that want you first, then priority, then `order`. The inbox's ids go in too, now that
    // this app has them — the ordering and the orange ring are one predicate, and passing it
    // to the card but not to the sort would have the two disagree.
    for (const meta of COLUMN_META) {
      byColumn.set(
        meta.column,
        sortCards(byColumn.get(meta.column) ?? [], extras.attention.taskIds),
      );
    }
    return byColumn;
  }, [boardTasks, state, mrsByTask, focusIds, extras.attention.taskIds]);

  const hiddenDone = useMemo(
    () => hiddenDoneSummary(cardsByColumn.get('done') ?? []),
    [cardsByColumn],
  );

  /** Where every card is, for the arrows — see `useCardAnchors`. */
  const anchors = useCardAnchors(cardsByColumn);

  /**
   * Where each chained card stands. `MyTasks`'s own `chainStates`, over the mirrored rows
   * and the relayed links — the same functions, so the chip on the web says what it says on
   * the desktop.
   */
  const chainStates = useMemo(() => {
    const byId = new Map<string, { waitingOn: Task[]; mergeHeld: Task[]; ready: boolean }>();
    for (const id of new Set(extras.chainLinks.map((l) => l.toTaskId))) {
      const task = tasksById.get(id);
      if (!task) continue;
      const waitingOn = blockedBy(task, extras.chainLinks, tasksById);
      byId.set(id, {
        waitingOn,
        mergeHeld: awaitingMerge(task, extras.chainLinks, tasksById),
        ready: waitingOn.length === 0 && task.status === 'pending' && !task.sessionId,
      });
    }
    return byId;
  }, [extras.chainLinks, tasksById]);

  const pendingTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of Object.values(state.tasks)) {
      if (isTaskPending(state, task.id)) ids.add(task.id);
    }
    return ids;
  }, [state]);

  /**
   * The card the pane is showing — with the same pending overlay its column applies, so a
   * card dragged to DONE does not read "In progress" in the pane beside it.
   */
  const selectedTask = useMemo(() => {
    const task = selectedTaskId ? (state.tasks[selectedTaskId] ?? null) : null;
    return task ? { ...task, status: displayStatus(state, task) } : null;
  }, [state, selectedTaskId]);

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
  const selectedLinkAt = useMemo(() => {
    if (!selectedLink) return null;
    const from = anchors.rects.get(selectedLink.fromTaskId);
    const to = anchors.rects.get(selectedLink.toTaskId);
    if (!from || !to) return null;
    return arrowRoute(from, to, anchors.bounds.width).mid;
  }, [selectedLink, anchors.rects, anchors.bounds.width]);

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

  const foldedSteps = useMemo(() => foldedCardSet(settings.foldedStepCards), [settings]);
  const shownEarlierSteps = useMemo(
    () => foldedCardSet(settings.shownEarlierStepCards),
    [settings],
  );
  const onBoardIds = useMemo(() => new Set(boardTasks.map((t) => t.id)), [boardTasks]);

  const toggleSteps = useCallback(
    (taskId: string) => {
      void saveSettings({
        ...settings,
        foldedStepCards: toggleFoldedCard(settings.foldedStepCards, taskId, onBoardIds),
      }).catch(reportError);
    },
    [settings, saveSettings, onBoardIds, reportError],
  );
  const toggleEarlierSteps = useCallback(
    (taskId: string) => {
      void saveSettings({
        ...settings,
        shownEarlierStepCards: toggleFoldedCard(settings.shownEarlierStepCards, taskId, onBoardIds),
      }).catch(reportError);
    },
    [settings, saveSettings, onBoardIds, reportError],
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
    [linkDrag, extras, reportError],
  );

  const disabledReason = everSeenClient
    ? undefined
    : 'No desktop app has ever synced this account — sign in and open it once first.';

  return (
    <div className={layout.root}>
      <div className={layout.board}>
        <BoardToolbar
          showDone={showDone}
          hiddenDone={hiddenDone}
          onShowDoneChange={(next) =>
            void saveSettings({
              ...settings,
              jira: { ...settings.jira, showDoneColumn: next },
            }).catch(reportError)
          }
          display={display}
          onDisplayChange={(next) =>
            void saveSettings({ ...settings, board: next }).catch(reportError)
          }
          showDetail={showDetail}
          onShowDetailChange={(next) =>
            void saveSettings({ ...settings, showTaskDetail: next }).catch(reportError)
          }
          chainFocus={chainFocus}
          onChainFocusChange={setChainFocus}
          canFocusChain={selectedTaskId !== null}
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
          addTask={
            <AddTaskDialog
              projects={projects}
              onCreate={onCreateTask}
              disabled={!everSeenClient || projects.length === 0}
              disabledReason={disabledReason}
            />
          }
        />

        {error && <Caption1 className={styles.error}>{error}</Caption1>}

        {/* The empty state is about the CARD SET, not the mirror: a board with a hundred rows
            in other projects still has nothing to draw, and saying "no board data" there would
            be a lie. Only when nothing at all has arrived is it a sync that hasn't happened. */}
        {boardTasks.length === 0 ? (
          <Caption1 className={styles.empty}>
            {projects.length === 0 && Object.keys(state.tasks).length === 0
              ? 'No board data yet — waiting on the first sync from your desktop app.'
              : 'No cards on your Personal board.'}
          </Caption1>
        ) : (
          <div className={layout.columns} onClick={() => setSelectedLinkId(null)}>
            {visibleColumns(showDone).map((column) => (
              <KanbanColumn
                key={column}
                column={column}
                label={COLUMN_LABEL[column]}
                cards={cardsByColumn.get(column) ?? []}
                projectNameOf={projectNameOf}
                agentNameOf={agentNameOf}
                projectColorOf={projectColorOf}
                display={display}
                // With the sprint filter on, every card carries the same chip — the desktop
                // hides it for exactly that reason, and now so does this.
                showSprint={!settings.jira.currentSprintOnly}
                statusKeywords={settings.statusKeywords}
                attentionTaskIds={extras.attention.taskIds}
                liveRunTaskIds={extras.liveRunTaskIds}
                mergingTaskIds={extras.mergingTaskIds}
                foldedStepTaskIds={foldedSteps}
                onToggleSteps={toggleSteps}
                shownEarlierStepTaskIds={shownEarlierSteps}
                onToggleEarlierSteps={toggleEarlierSteps}
                anchorRef={anchors.anchorRef}
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
                chainStateOf={(t) => chainStates.get(t.id)}
                selectedTaskId={selectedTaskId}
                draggingId={draggingId}
                onStopTask={(taskId) => void extras.stopTask(taskId).catch(reportError)}
                // The card decides when to OFFER this (`canResumeWork`, from `stoppedAt` and
                // the card's own steps); the column only needs the prop to exist, and until
                // now this app was the only host that did not pass it.
                onResumeTask={(taskId) => void extras.resumeTask(taskId).catch(reportError)}
                onSelectTask={selectTask}
                onDragStartTask={setDraggingId}
                onDragEndTask={() => setDraggingId(null)}
                onDropInColumn={(taskId, dropColumn) => {
                  setDraggingId(null);
                  if (!everSeenClient) return;
                  if (pendingTaskIds.has(taskId)) return; // one edit in flight at a time per card
                  onSetStatus(taskId, statusForColumn(dropColumn));
                }}
              />
            ))}
            {/* Last, so the arrows paint over the cards — and inside the scroll container,
                so they travel with them. It takes no pointer events; only the strokes do. */}
            <ChainOverlay
              links={extras.chainLinks}
              anchors={anchors.rects}
              tasksById={tasksById}
              runningTaskIds={extras.liveRunTaskIds}
              selectedTaskId={selectedTaskId}
              hoveredTaskId={anchors.hoveredTaskId}
              focusTaskIds={focusIds}
              selectedLinkId={selectedLinkId}
              onSelectLink={setSelectedLinkId}
              linkDrag={linkDrag}
              width={anchors.bounds.width}
              height={anchors.bounds.height}
            />
            {selectedLink && selectedLinkAt && (
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
      </div>

      {/* The desktop's own pane, the same component — and now with the same props, so it
          draws the same sections rather than degrading to a card and a timeline. */}
      {showDetail && (
        <div className={layout.right}>
          <TaskDetail
            task={selectedTask}
            agentProjects={extras.agentProjects}
            subtasks={chain}
            parentTask={parentOfSelected}
            mergeRequests={selectedTask ? (mrsByTask.get(selectedTask.id) ?? []) : []}
            attachments={selectedTask ? (attachmentsByTask.get(selectedTask.id) ?? []) : []}
            parentAttachments={
              parentOfSelected ? (attachmentsByTask.get(parentOfSelected.id) ?? []) : []
            }
            statusKeywords={settings.statusKeywords}
            priorityDisplay={display.priorityDisplay}
            attention={extras.attention}
            liveRunTaskIds={extras.liveRunTaskIds}
            mergingTaskIds={extras.mergingTaskIds}
            chainWaitingOn={selectedTask ? chainStates.get(selectedTask.id)?.waitingOn : undefined}
            chainMergeHeld={selectedTask ? chainStates.get(selectedTask.id)?.mergeHeld : undefined}
            chainLinks={extras.chainLinks}
            chainTasksById={tasksById}
            onUnlinkChain={(linkId) => void extras.removeLink(linkId).catch(reportError)}
            readOnlyNotice={RELAY_NOTICE}
            onOpenTask={setSelectedTaskId}
            // The pane's State dropdown has already sent its own `task:setStatus` through
            // the transport by the time this runs (`TaskDetailsCell`), so this only records
            // the optimistic overlay a drag gets — it must not send a second command. The
            // task it hands back is the transport's stub (`{ id, status }`), never a row
            // worth merging into `state.tasks`; the next poll brings the real one.
            onStatusChanged={(updated) => {
              if (isManualStatus(updated.status)) onStatusNoted(updated.id, updated.status);
            }}
            onSubtasksChanged={extras.refresh}
          />
        </div>
      )}

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
    </div>
  );
}
