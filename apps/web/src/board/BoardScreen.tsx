/**
 * The web board: `GET /v1/board`'s tasks/projects, drawn as the desktop's My Tasks screen —
 * the same frame (`useBoardLayoutStyles`), the same columns in the same order, the same
 * cards (`KanbanColumn`/`TaskCard`), the same ordering rule (`sortCards`), the same toolbar
 * minus the controls a browser cannot act on (`BoardToolbar`), and the same 40% detail pane
 * down the right.
 *
 * Editing is narrower than the desktop's: dragging a card between columns and creating a
 * card are the two things `CommandEnvelope`'s v1 kinds can carry all the way to a rendered
 * result here (see `httpTransport.ts`'s own header for why `add-comment` isn't wired to
 * anything in this app). Everything else is read — which is a statement about what this app
 * can DO, and no reason at all for it to look like a different application.
 */
import { useMemo, useState } from 'react';
import { Caption1, makeStyles } from '@fluentui/react-components';
import {
  COLUMN_META,
  groupSubtasks,
  hiddenDoneSummary,
  sortCards,
  visibleColumns,
  type BoardCard,
} from '@tm/ui/board/boardColumns';
import { columnForTask, statusForColumn } from '@tm/shared/board';
import { KanbanColumn } from '@tm/ui/board/KanbanColumn';
import { TaskDetail } from '@tm/ui/TaskDetail';
import { useBoardLayoutStyles } from '@tm/ui/board/boardLayout';
import { ArchivedCardsDialog, archivedCards } from '@tm/ui/board/ArchivedCardsDialog';
import { isManualStatus, type BoardColumn, type ManualStatus, type Task } from '@tm/shared/model';
import { AddTaskDialog } from './AddTaskDialog';
import { BoardToolbar } from './BoardToolbar';
import { selectArchivedTasks, selectBoardTasks } from './boardSelectors';
import { displayStatus, isTaskPending, type CloudBoardState } from './cloudBoardStore';
import { loadBoardPrefs, saveBoardPrefs, type WebBoardPrefs } from './webPrefs';

const useStyles = makeStyles({
  /** The empty state, in the board's own half of the screen rather than across all of it. */
  empty: { padding: '8px 4px' },
});

/**
 * The one sentence the pane wears (`TaskDetail`'s `readOnlyNotice`). It names what DOES
 * work, because that is the part a reader cannot infer: everything else in the pane looks
 * exactly as live as it does on the desktop.
 */
const READ_ONLY_NOTICE =
  'Read-only here — moving a card and adding one are the only edits the web app can make. ' +
  'Everything else is done from the desktop app.';

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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /**
   * The toolbar's three switches, in `localStorage` — this app's stand-in for the desktop's
   * `settings:save` round trip (see `webPrefs.ts`). Read once on mount: a preference that
   * re-read the store on every render would still only ever change from in here.
   */
  const [prefs, setPrefs] = useState<WebBoardPrefs>(() => loadBoardPrefs(window.localStorage));
  const savePrefs = (next: WebBoardPrefs): void => {
    setPrefs(next);
    saveBoardPrefs(window.localStorage, next);
  };
  /**
   * When the Removed-cards dialog was opened, or null while it is shut — the timestamp
   * rather than a boolean for the reason `MyTasks` holds one: the rows are labelled
   * relatively ("yesterday") and must not re-word themselves on an unrelated render.
   */
  const [archivedOpenedAt, setArchivedOpenedAt] = useState<number | null>(null);

  const projects = useMemo(() => Object.values(state.projects), [state.projects]);
  /**
   * The card's optional lines, read the desktop's way: `projectNameOf` is the JIRA project a
   * ticket is filed under (`phase`), not the local project — every card on this board is in
   * Personal, so that one would say the same word on all of them — and the stripe is the
   * repo the card is tagged with, which is what the desktop colours it by.
   */
  const projectNameOf = (task: Task): string | undefined =>
    task.externalSource === 'jira' ? task.phase || undefined : undefined;
  const agentNameOf = (task: Task): string | undefined =>
    task.agentProjectId ? state.projects[task.agentProjectId]?.name : undefined;
  const projectColorOf = (task: Task): string | undefined =>
    task.projectTagId ? state.projects[task.projectTagId]?.color || undefined : undefined;

  /** The desktop's own card set — Personal, un-archived. See `boardSelectors.ts`. */
  const boardTasks = useMemo(() => selectBoardTasks(state), [state]);

  /**
   * The cards that have LEFT this board. No fetch and no `board:archived` equivalent: the
   * archived rows are already in `state.tasks` (the mirror carries them, and
   * `boardSelectors.ts` says why ingest must not drop them), so this is the same list the
   * desktop's dialog shows, minus the step rows `archivedCards` filters out.
   */
  const removedCards = useMemo(() => archivedCards(selectArchivedTasks(state)), [state]);

  const cardsByColumn = useMemo(() => {
    // Overlay any still-pending edit before grouping/columning, so a dragged card jumps to
    // its destination column the instant you let go — the same optimism
    // `MyTasks.tsx`'s own `optimisticMove` gives the desktop board, just computed from
    // `displayStatus` (`cloudBoardStore.ts`) instead of local SQLite state.
    const displayTasks = boardTasks.map((task) => ({
      ...task,
      status: displayStatus(state, task),
    }));
    const byColumn = new Map<BoardColumn, BoardCard[]>();
    for (const meta of COLUMN_META) byColumn.set(meta.column, []);
    for (const card of groupSubtasks(displayTasks)) {
      byColumn.get(columnForTask(card.task))?.push(card);
    }
    // The desktop's ordering, so the same board reads the same way in both places: cards
    // that want you first, then priority, then `order`. No attention set to pass — the
    // inbox is not mirrored — which leaves the priority ordering, and a card whose ring
    // this app cannot draw is also one it cannot promote.
    for (const meta of COLUMN_META) {
      byColumn.set(meta.column, sortCards(byColumn.get(meta.column) ?? []));
    }
    return byColumn;
  }, [boardTasks, state]);

  const hiddenDone = useMemo(
    () => hiddenDoneSummary(cardsByColumn.get('done') ?? []),
    [cardsByColumn],
  );

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

  const disabledReason = everSeenClient
    ? undefined
    : 'No desktop app has ever synced this account — sign in and open it once first.';

  return (
    <div className={layout.root}>
      <div className={layout.board}>
        <BoardToolbar
          showDone={prefs.showDone}
          hiddenDone={hiddenDone}
          onShowDoneChange={(showDone) => savePrefs({ ...prefs, showDone })}
          display={prefs.display}
          onDisplayChange={(display) => savePrefs({ ...prefs, display })}
          showDetail={prefs.showDetail}
          onShowDetailChange={(showDetail) => savePrefs({ ...prefs, showDetail })}
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
          <div className={layout.columns}>
            {visibleColumns(prefs.showDone).map((column) => (
              <KanbanColumn
                key={column}
                column={column}
                label={COLUMN_LABEL[column]}
                cards={cardsByColumn.get(column) ?? []}
                projectNameOf={projectNameOf}
                agentNameOf={agentNameOf}
                projectColorOf={projectColorOf}
                display={prefs.display}
                // The sprint chip earns its place here: this board has no sprint filter to
                // put every card behind the same one, which is the only case the desktop
                // hides it in.
                showSprint
                selectedTaskId={selectedTaskId}
                draggingId={draggingId}
                onSelectTask={setSelectedTaskId}
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
          </div>
        )}
      </div>

      {/* The desktop's own pane, the same component, degraded by what is NOT passed to it:
          with no agent projects, no merge requests, no attachments, no chain links, no
          attention index and no live runs, the Chain, MR, attention and agent sections
          never render at all — see `TaskDetail`'s props. What is left is the card, its
          steps and its timeline, which is exactly what this app has. The notice is how a
          reader tells that from a pane that is merely broken. */}
      {prefs.showDetail && (
        <div className={layout.right}>
          <TaskDetail
            task={selectedTask}
            subtasks={chain}
            parentTask={parentOfSelected}
            priorityDisplay={prefs.display.priorityDisplay}
            readOnlyNotice={READ_ONLY_NOTICE}
            onOpenTask={setSelectedTaskId}
            // The pane's State dropdown has already sent its own `task:setStatus` through
            // the transport by the time this runs (`TaskDetailsCell`), so this only records
            // the optimistic overlay a drag gets — it must not send a second command. The
            // task it hands back is the transport's stub (`{ id, status }`), never a row
            // worth merging into `state.tasks`; the next poll brings the real one.
            onStatusChanged={(updated) => {
              if (isManualStatus(updated.status)) onStatusNoted(updated.id, updated.status);
            }}
          />
        </div>
      )}

      <ArchivedCardsDialog
        open={archivedOpenedAt !== null}
        archived={removedCards}
        // Read once, when it opened — see `archivedOpenedAt`.
        now={archivedOpenedAt ?? 0}
        onClose={() => setArchivedOpenedAt(null)}
        // No `onRestore`: a restore is a write to the desktop's own database and there is no
        // command kind that carries one, so the list is read-only here. See the dialog.
      />
    </div>
  );
}
