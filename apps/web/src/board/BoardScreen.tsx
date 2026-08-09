/**
 * The web board: `GET /v1/board`'s tasks/projects, rendered through the exact same
 * `KanbanColumn`/`TaskCard` the desktop app's My Tasks board uses (`@tm/ui/board`) — this
 * step's own brief, "into the same @tm/ui board the desktop renders". Editing is narrower
 * than the desktop's: dragging a card between columns and creating a card are the two
 * things `CommandEnvelope`'s v1 kinds can carry all the way to a rendered result here (see
 * `httpTransport.ts`'s own header for why `add-comment` isn't wired to anything in this
 * app).
 */
import { useMemo, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { SignOutRegular } from '@fluentui/react-icons';
import { COLUMN_META, groupSubtasks, type BoardCard } from '@tm/ui/board/boardColumns';
import { columnForTask, statusForColumn } from '@tm/shared/board';
import { KanbanColumn } from '@tm/ui/board/KanbanColumn';
import type { BoardColumn, ManualStatus, Task } from '@tm/shared/model';
import { AddTaskDialog } from './AddTaskDialog';
import { displayStatus, isTaskPending, type CloudBoardState } from './cloudBoardStore';
import { StaleBanner } from './StaleBanner';

const useStyles = makeStyles({
  root: { height: '100vh', display: 'flex', flexDirection: 'column', minHeight: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flex: 1 },
  columns: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(240px, 1fr)',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '12px 16px',
  },
});

export interface BoardScreenProps {
  state: CloudBoardState;
  everSeenClient: boolean;
  onSetStatus: (taskId: string, status: ManualStatus) => void;
  onCreateTask: (projectId: string, input: { title: string; phase?: string }) => Promise<void>;
  onSignOut: () => void;
}

export function BoardScreen({
  state,
  everSeenClient,
  onSetStatus,
  onCreateTask,
  onSignOut,
}: BoardScreenProps): JSX.Element {
  const styles = useStyles();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const projects = useMemo(() => Object.values(state.projects), [state.projects]);
  const projectNameOf = (task: Task): string | undefined => state.projects[task.projectId]?.name;
  const projectColorOf = (task: Task): string | undefined => {
    const color = state.projects[task.projectId]?.color;
    return color || undefined;
  };

  const cardsByColumn = useMemo(() => {
    // Overlay any still-pending edit before grouping/columning, so a dragged card jumps to
    // its destination column the instant you let go — the same optimism
    // `MyTasks.tsx`'s own `optimisticMove` gives the desktop board, just computed from
    // `displayStatus` (`cloudBoardStore.ts`) instead of local SQLite state.
    const displayTasks = Object.values(state.tasks).map((task) => ({
      ...task,
      status: displayStatus(state, task),
    }));
    const cards = groupSubtasks(displayTasks);
    const byColumn = new Map<BoardColumn, BoardCard[]>();
    for (const meta of COLUMN_META) byColumn.set(meta.column, []);
    for (const card of cards) {
      const column = columnForTask(card.task);
      byColumn.get(column)?.push(card);
    }
    return byColumn;
  }, [state]);

  const pendingTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of Object.values(state.tasks)) {
      if (isTaskPending(state, task.id)) ids.add(task.id);
    }
    return ids;
  }, [state]);

  const disabledReason = everSeenClient
    ? undefined
    : 'No desktop app has ever synced this account — sign in and open it once first.';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>VIPPER Task Manager Cloud</Title2>
        <div className={styles.grow} />
        <AddTaskDialog
          projects={projects}
          onCreate={onCreateTask}
          disabled={!everSeenClient || projects.length === 0}
          disabledReason={disabledReason}
        />
        <Button icon={<SignOutRegular />} appearance="subtle" onClick={onSignOut}>
          Sign out
        </Button>
      </div>

      {!everSeenClient || state.clients.length === 0 ? (
        <StaleBanner everSeenClient={everSeenClient} />
      ) : null}

      {projects.length === 0 && Object.keys(state.tasks).length === 0 ? (
        <Body1 style={{ padding: '16px' }}>
          <Caption1>No board data yet — waiting on the first sync from your desktop app.</Caption1>
        </Body1>
      ) : (
        <div className={styles.columns}>
          {COLUMN_META.map((meta) => (
            <KanbanColumn
              key={meta.column}
              column={meta.column}
              label={meta.label}
              cards={cardsByColumn.get(meta.column) ?? []}
              projectNameOf={projectNameOf}
              agentNameOf={() => undefined}
              projectColorOf={projectColorOf}
              showSprint={false}
              selectedTaskId={selectedTaskId}
              draggingId={draggingId}
              onSelectTask={setSelectedTaskId}
              onDragStartTask={setDraggingId}
              onDragEndTask={() => setDraggingId(null)}
              onDropInColumn={(taskId, column) => {
                setDraggingId(null);
                if (!everSeenClient) return;
                if (pendingTaskIds.has(taskId)) return; // one edit in flight at a time per card
                onSetStatus(taskId, statusForColumn(column));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
