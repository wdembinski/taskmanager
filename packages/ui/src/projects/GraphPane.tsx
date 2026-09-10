/**
 * GraphPane — the Graph view of one project's tickets (Phase 24, chaining-tickets plan step 10).
 * A React Flow canvas, mounted alongside `BacklogTable` and `TimelinePane` as the third view in
 * `Projects.tsx`'s switch — never all three at once, the same reasoning `TimelinePane`'s own
 * doc gives for why a project switch remounts rather than reconciles.
 *
 * Loads its own tickets the same way `BacklogTable`/`TimelinePane` do: seed via `board:tasks`,
 * then stay live off `task:changed` (per-ticket patch) and `project:tasksChanged` (whole-list
 * replace — a ticket can also leave this way). No edges yet, and no persisted layout: nodes sit
 * in a deterministic grid keyed only by array order, which a later step replaces with a saved
 * per-project position.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import {
  BeakerRegular,
  BookmarkRegular,
  BugRegular,
  NoteRegular,
  PersonRegular,
  SparkleRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { Task } from '@tm/shared/model';
import { typeIconKeyFor, type TypeIconKey } from '@tm/shared/tickets';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    height: '100%',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px 10px',
    minWidth: '200px',
    maxWidth: '240px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: tokens.colorNeutralForeground2,
  },
  type: { display: 'flex', alignItems: 'center' },
  key: {
    fontSize: '11px',
    fontWeight: 600,
    fontFamily: 'monospace',
  },
  title: {
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  epic: { color: tokens.colorNeutralForeground3 },
});

/** Same key→glyph map as `BacklogTable`'s own `TYPE_ICON` — a ticket's type reads the same
 *  outline glyph everywhere in the app; see `board-colour-budget`: colour is for things that
 *  MOVE, and a node's type never does. */
const TYPE_ICON: Record<TypeIconKey, JSX.Element> = {
  epic: <SparkleRegular />,
  story: <BookmarkRegular />,
  task: <TaskListSquareLtrRegular />,
  bug: <BugRegular />,
  subtask: <PersonRegular />,
  feature: <BeakerRegular />,
  note: <NoteRegular />,
};

function TicketNode({ data }: NodeProps<Node<{ ticket: Task }>>): JSX.Element {
  const styles = useStyles();
  const { ticket } = data;
  return (
    <div className={styles.card}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.head}>
        <span className={styles.type}>{TYPE_ICON[typeIconKeyFor(ticket)]}</span>
        <span className={styles.key}>{ticket.ticketKey ?? '—'}</span>
      </div>
      <Caption1 className={styles.title}>{ticket.title}</Caption1>
      {ticket.epicTaskId && <Caption1 className={styles.epic}>Epic</Caption1>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { ticket: TicketNode };

/** Grid geometry for the placeholder layout — a later step replaces this with a per-project
 *  saved position, so these numbers only need to keep nodes from overlapping. */
const GRID_COLUMNS = 4;
const GRID_COLUMN_WIDTH = 280;
const GRID_ROW_HEIGHT = 140;

/** Deterministic grid placement, keyed on the ticket's own id so a re-render (or a
 *  `project:tasksChanged` replace) never reshuffles a node that was already on screen. */
function gridLayout(tickets: Task[]): Node<{ ticket: Task }>[] {
  return tickets.map((ticket, i) => ({
    id: ticket.id,
    type: 'ticket',
    position: {
      x: (i % GRID_COLUMNS) * GRID_COLUMN_WIDTH,
      y: Math.floor(i / GRID_COLUMNS) * GRID_ROW_HEIGHT,
    },
    data: { ticket },
  }));
}

export interface GraphPaneProps {
  projectId: string;
}

export function GraphPane({ projectId }: GraphPaneProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);

  const seed = useCallback(
    async () => setTickets(await transport.invoke('board:tasks', projectId)),
    [transport, projectId],
  );
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offTask = transport.on('task:changed', ({ task }) => {
      if (task.projectId !== projectId) return;
      setTickets((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
    });
    // The whole list, replaced — a ticket can also leave this way (deleted), which no
    // per-task patch would ever say.
    const offTasks = transport.on('project:tasksChanged', ({ projectId: changed, tasks }) => {
      if (changed !== projectId) return;
      setTickets(tasks);
    });
    return () => {
      offTask();
      offTasks();
    };
  }, [transport, projectId]);

  const nodes = useMemo(() => gridLayout(tickets ?? []), [tickets]);

  if (tickets === null) {
    return <PaneLoading label="Loading graph…" error={initial.error} onRetry={initial.retry} />;
  }

  return (
    <div className={styles.root}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={NODE_TYPES}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
