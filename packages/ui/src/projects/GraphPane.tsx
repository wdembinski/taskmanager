/**
 * GraphPane — the Graph view of one project's tickets (Phase 24, chaining-tickets plan step 10).
 * A React Flow canvas, mounted alongside `BacklogTable` and `TimelinePane` as the third view in
 * `Projects.tsx`'s switch — never all three at once, the same reasoning `TimelinePane`'s own
 * doc gives for why a project switch remounts rather than reconciles.
 *
 * Loads its own tickets the same way `BacklogTable`/`TimelinePane` do: seed via `board:tasks`,
 * then stay live off `task:changed` (per-ticket patch) and `project:tasksChanged` (whole-list
 * replace — a ticket can also leave this way). No persisted layout: nodes sit in a
 * deterministic grid keyed only by array order, which a later step replaces with a saved
 * per-project position.
 *
 * **Edges — `blocks` dependencies and execution-chain links.** Loaded and kept live the exact
 * way `TimelinePane` loads its own: seed via `ticketLink:list` / `chain:links`, then
 * replace-on-change off `ticketLink:changed` / `chain:changed` (both send the WHOLE list, never
 * a patch — see `ipc.ts`'s own doc on `chain:changed`). Only the `blocks` type renders, the
 * same filter `TimelinePane`'s `dependencyPaths` applies — the other `TicketLinkType`s
 * (`relates`, `duplicates`, …) are documentary and drawn nowhere yet. Grey for a dependency,
 * cyan for a chain — `FLUO.cyan` is the app's one colour for "moving", the same one
 * `TimelinePane`'s own `chain` style and `ChainOverlay`'s `releasing` state use. A link whose
 * endpoint ticket is not among this project's own nodes (can't happen today, since both link
 * kinds are project-scoped the same way a ticket is, but cheap to guard) is dropped rather than
 * handed to React Flow, which would otherwise warn about a dangling edge.
 *
 * **Creating a link.** React Flow's own `onConnect` fires once a drag from one node's `Handle`
 * lands on another's, with nothing more than the two node ids — unlike the timeline's connect
 * knob, there is no ctrl-drag mid-gesture on this canvas to also ask for a chain, so the choice
 * of kind moves to `GraphLinkPicker`, a small dialog opened over the resolved `Task` pair
 * (`handleConnect`). It runs `canLinkTickets`/`canLink` itself before calling `ticketLink:add`
 * / `chain:link`, so a refusal it already knows about — self, duplicate, a would-be cycle —
 * reads inline without a round trip, `TimelinePane.commitConnect`'s own reasoning.
 *
 * **Deleting a link.** React Flow edges are selectable and deletable by default, so selecting
 * one and pressing Delete/Backspace fires `onEdgesDelete` with the removed `Edge`s — the
 * affordance is React Flow's own, nothing custom drawn on the canvas. `handleEdgesDelete`
 * resolves each deleted edge's id back to a kind the same way `TimelinePane`'s
 * `selectedChainLink`/`selectedTicketLink` split does: check `links` first, then `chainLinks` —
 * the two id spaces never collide (same invariant, see `TimelinePane`'s own doc on it) — and
 * calls `ticketLink:remove` or `chain:unlink`. `ticketLink:remove` returns nothing, so that half
 * removes optimistically and re-fetches the list on refusal; `chain:unlink` returns the fresh
 * list itself, `TimelinePane.removeChainLink`'s own shape.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
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
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { Task, TicketLink } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { typeIconKeyFor, type TypeIconKey } from '@tm/shared/tickets';
import { PaneLoading } from '../PaneLoading';
import { FLUO } from '../theme';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { GraphLinkPicker } from './GraphLinkPicker';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    height: '100%',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  canvas: { flex: 1, minHeight: 0 },
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

/** Grey `blocks` dependency — `TimelinePane.dependency`'s own colour, `tokens.colorNeutralStroke1`. */
const DEPENDENCY_STROKE = tokens.colorNeutralStroke1;
/** Cyan execution chain — `TimelinePane.chain`'s own colour, `FLUO.cyan`. */
const CHAIN_STROKE = FLUO.cyan;

/** One `blocks` dependency edge per link of that type — the others (`relates`, `duplicates`,
 *  …) are documentary and drawn nowhere in this app yet. Dropped, not just unstyled, if either
 *  end is not among `nodeIds` — a React Flow edge naming a missing node warns to the console. */
function dependencyEdges(links: TicketLink[], nodeIds: Set<string>): Edge[] {
  return links
    .filter((l) => l.type === 'blocks' && nodeIds.has(l.fromTaskId) && nodeIds.has(l.toTaskId))
    .map((l) => ({
      id: l.id,
      source: l.fromTaskId,
      target: l.toTaskId,
      style: { stroke: DEPENDENCY_STROKE, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: DEPENDENCY_STROKE },
    }));
}

/** One execution-chain edge per chain link — same shape as {@link dependencyEdges}, cyan. */
function chainEdges(links: TaskLink[], nodeIds: Set<string>): Edge[] {
  return links
    .filter((l) => nodeIds.has(l.fromTaskId) && nodeIds.has(l.toTaskId))
    .map((l) => ({
      id: l.id,
      source: l.fromTaskId,
      target: l.toTaskId,
      style: { stroke: CHAIN_STROKE, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: CHAIN_STROKE },
    }));
}

export interface GraphPaneProps {
  projectId: string;
}

export function GraphPane({ projectId }: GraphPaneProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [chainLinks, setChainLinks] = useState<TaskLink[]>([]);
  // The pending connect gesture — `GraphLinkPicker`'s own controlled-open prop, `null` while
  // its dialog is closed. Resolved from `tickets` (not the raw ids `onConnect` hands back) so
  // the picker gets full `Task`s to show titles from and run `canLinkTickets`/`canLink` against.
  const [pendingConnection, setPendingConnection] = useState<{ from: Task; to: Task } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // Seed-and-subscribe, `TimelinePane`'s own shape: both events hand back the WHOLE list, so
  // there is nothing to patch, only to replace.
  useEffect(() => {
    let live = true;
    void transport.invoke('ticketLink:list').then((all) => {
      if (live) setLinks(all);
    });
    const off = transport.on('ticketLink:changed', setLinks);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  useEffect(() => {
    let live = true;
    void transport.invoke('chain:links').then((all) => {
      if (live) setChainLinks(all);
    });
    const off = transport.on('chain:changed', setChainLinks);
    return () => {
      live = false;
      off();
    };
  }, [transport]);

  const nodes = useMemo(() => gridLayout(tickets ?? []), [tickets]);
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(
    () => [...dependencyEdges(links, nodeIds), ...chainEdges(chainLinks, nodeIds)],
    [links, chainLinks, nodeIds],
  );

  /**
   * Opens `GraphLinkPicker` over the pair a React Flow drag just named — the endpoints come
   * back as bare ids (`Connection.source`/`target`), resolved here against `tickets` since the
   * picker needs each end's own title, not just its id. A connection whose endpoint has left
   * `tickets` between the drag starting and ending (a delete mid-gesture) is silently dropped
   * rather than opening a picker over a ticket that is no longer there.
   */
  const handleConnect = useCallback(
    (connection: Connection) => {
      const from = (tickets ?? []).find((t) => t.id === connection.source);
      const to = (tickets ?? []).find((t) => t.id === connection.target);
      if (from && to) setPendingConnection({ from, to });
    },
    [tickets],
  );

  /** `ticketLink:remove`'s own half of a delete — `TimelinePane.removeTicketLink`'s own shape:
   *  remove locally first (the IPC returns nothing to replace it with), then re-fetch the list
   *  on refusal rather than leaving a stale edge gone from screen but still linked underneath. */
  const removeTicketLink = useCallback(
    async (linkId: string) => {
      setLinks((cur) => cur.filter((l) => l.id !== linkId));
      try {
        await transport.invoke('ticketLink:remove', linkId);
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : String(e));
        setLinks(await transport.invoke('ticketLink:list'));
      }
    },
    [transport],
  );

  /** `chain:unlink`'s own half — it returns the fresh list itself, so there is nothing to
   *  optimistically remove first, `TimelinePane.removeChainLink`'s own shape. */
  const removeChainLink = useCallback(
    async (linkId: string) => {
      try {
        setChainLinks(await transport.invoke('chain:unlink', linkId));
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : String(e));
      }
    },
    [transport],
  );

  /**
   * React Flow's own delete affordance — edges are selectable and deletable by default, so
   * selecting one and pressing Delete/Backspace lands here with the removed `Edge`s. An edge's
   * id alone does not say which kind it is (`dependencyEdges`/`chainEdges` set no `data`
   * discriminator), so it is resolved against `links` first, then `chainLinks` — the same
   * membership check `TimelinePane`'s `selectedChainLink`/`selectedTicketLink` split relies on,
   * safe because the two id spaces never collide.
   */
  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      setDeleteError(null);
      for (const edge of deleted) {
        if (links.some((l) => l.id === edge.id)) void removeTicketLink(edge.id);
        else if (chainLinks.some((l) => l.id === edge.id)) void removeChainLink(edge.id);
      }
    },
    [links, chainLinks, removeTicketLink, removeChainLink],
  );

  if (tickets === null) {
    return <PaneLoading label="Loading graph…" error={initial.error} onRetry={initial.retry} />;
  }

  return (
    <div className={styles.root}>
      {deleteError && (
        <MessageBar intent="error">
          <MessageBarBody>{deleteError}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.canvas}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onConnect={handleConnect}
            onEdgesDelete={handleEdgesDelete}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <GraphLinkPicker
        connection={pendingConnection}
        links={links}
        chainLinks={chainLinks}
        onClose={() => setPendingConnection(null)}
      />
    </div>
  );
}
