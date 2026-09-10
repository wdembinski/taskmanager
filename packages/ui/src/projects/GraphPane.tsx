/**
 * GraphPane — the Graph view of one project's tickets (Phase 24, chaining-tickets plan step 10).
 * A React Flow canvas, mounted alongside `BacklogTable` and `TimelinePane` as the third view in
 * `Projects.tsx`'s switch — never all three at once, the same reasoning `TimelinePane`'s own
 * doc gives for why a project switch remounts rather than reconciles.
 *
 * Loads its own tickets the same way `BacklogTable`/`TimelinePane` do: seed via `board:tasks`,
 * then stay live off `task:changed` (per-ticket patch) and `project:tasksChanged` (whole-list
 * replace — a ticket can also leave this way).
 *
 * **Layout.** `ticketGraph:getLayout` is fetched alongside `board:tasks` in the same seed
 * (one `Promise.all`, so the saved layout is already in state by the time `tickets` first
 * goes non-null — nothing to jump once the grid fallback below gets a chance to run). Any
 * ticket missing from it — nobody has ever dragged it — falls back to `gridPosition`'s
 * deterministic slot, keyed on its rank among the OTHER missing tickets rather than its
 * rank in the full list, so a mix of saved and un-saved nodes doesn't leave gaps. A drag
 * (`handleNodeDragStop`) updates `positions` locally and schedules `ticketGraph:saveLayout`
 * after `SAVE_DEBOUNCE_MS` of no further drag — the same trailing-debounce shape
 * `ModelField`'s own model-resolve probe uses, so a fast drag-drag-drag only ever writes
 * once. The call sends the WHOLE current layout, not just the moved node: there is no
 * per-node granularity on that channel, and re-sending everything is cheap (one row per
 * ticket, upserted).
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
 *
 * **Editing a link.** Delete-only was the one thing Delete/Backspace could never cover: there
 * was no way to retype an edge from a dependency into a chain (or back) without erasing it and
 * dragging a brand new one. `onEdgeClick` (`handleEdgeClick`) resolves the clicked edge's id
 * back to a kind the exact same way `handleEdgesDelete` already does — `links` then
 * `chainLinks` — and opens `GraphLinkPicker` in its edit mode over the resolved pair. The
 * picker itself owns the switch-or-delete logic; this pane only hands it the two removal
 * functions (`removeTicketLink`/`removeChainLink`) it already had for the Delete-key path, so a
 * type switch's remove half surfaces through the same `deleteError` `MessageBar` a Delete-key
 * removal would.
 *
 * **Epic zones.** An epic (`isEpic`) does not render as an ordinary `TicketNode` — it becomes
 * an `epicZone` container node, and every ticket whose `epicTaskId` names it (`isEpic` itself
 * excluded, an epic cannot nest inside another) becomes a `ticket` node with `parentId` set to
 * the epic and `extent: 'parent'`, React Flow's own sub-flow mechanism. A child's `position` is
 * therefore relative to its zone, not the canvas — `layoutNodes` keeps drawing from the same
 * `saved`/grid-fallback split either way, and `handleNodeDragStop` needs no change: React Flow
 * already hands a dragged child's `position` back relative to its parent, the exact shape
 * `positions`/`ticketGraph:saveLayout` store for every node regardless of kind. The zone itself
 * sizes to enclose its children (or a small empty band, for a childless epic) and always
 * renders — including with zero children — since the zone IS the epic, not a summary of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react';
import type { Task, TicketGraphPosition, TicketLink } from '@tm/shared/model';
import type { TaskLink } from '@tm/shared/taskChain';
import { isEpic, typeIconKeyFor, type TypeIconKey } from '@tm/shared/tickets';
import { PaneLoading } from '../PaneLoading';
import { FLUO } from '../theme';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { GraphLinkPicker, type EditingGraphLink } from './GraphLinkPicker';

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
  zone: {
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  zoneHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 10px',
    color: tokens.colorNeutralForeground2,
  },
  zoneTitle: {
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
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

type TicketNodeData = { ticket: Task };

function TicketNode({ data }: NodeProps<Node<TicketNodeData>>): JSX.Element {
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
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** An epic's own zone — the container `isEpic` renders as, `layoutNodes` gives it every
 *  ticket whose `epicTaskId` names it as a `parentId`-linked child instead. `width`/`height`
 *  travel in `data` (not just the node's own top-level fields) because a custom node type
 *  owns its DOM sizing itself — React Flow's built-in default node types read `style` for
 *  this, a custom one does not get it applied automatically. */
type EpicZoneData = { epic: Task; width: number; height: number };

function EpicZoneNode({ data }: NodeProps<Node<EpicZoneData>>): JSX.Element {
  const styles = useStyles();
  const { epic, width, height } = data;
  return (
    <div className={styles.zone} style={{ width, height }}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.zoneHead}>
        <span className={styles.type}>{TYPE_ICON[typeIconKeyFor(epic)]}</span>
        <span className={styles.key}>{epic.ticketKey ?? '—'}</span>
        <Caption1 className={styles.zoneTitle}>{epic.title}</Caption1>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { ticket: TicketNode, epicZone: EpicZoneNode };

/** Grid geometry for the fallback layout — the numbers only need to keep un-saved nodes
 *  from overlapping each other. Applies to top-level nodes only — an epic's own children lay
 *  out on {@link CHILD_GRID_COLUMNS}'s own smaller grid instead, see {@link childGridPosition}. */
const GRID_COLUMNS = 4;
const GRID_COLUMN_WIDTH = 280;
const GRID_ROW_HEIGHT = 140;

/** How long a drag's `ticketGraph:saveLayout` waits for another drag before it fires —
 *  `ModelField`'s own `RESOLVE_DEBOUNCE_MS` shape, longer since this follows a drag END
 *  (already a deliberate act) rather than every keystroke. */
const SAVE_DEBOUNCE_MS = 600;

function gridPosition(i: number): { x: number; y: number } {
  return {
    x: (i % GRID_COLUMNS) * GRID_COLUMN_WIDTH,
    y: Math.floor(i / GRID_COLUMNS) * GRID_ROW_HEIGHT,
  };
}

/** An epic zone's own inner geometry — the border/header chrome a child's relative position
 *  has to clear, and the card footprint `layoutNodes` assumes when it sizes a zone to enclose
 *  its children (the same "close enough, not measured" approximation {@link GRID_ROW_HEIGHT}
 *  already makes for top-level cards). Two columns, not {@link GRID_COLUMNS}'s four — a zone
 *  is a sub-area of the canvas, not the whole of it. */
const EPIC_PADDING = 24;
const EPIC_HEADER_HEIGHT = 40;
const CHILD_GRID_COLUMNS = 2;
const CHILD_COLUMN_WIDTH = 260;
const CHILD_ROW_HEIGHT = 120;
const CHILD_CARD_WIDTH = 240;
const CHILD_CARD_HEIGHT = 90;
/** A childless epic still renders as a zone — just a header-height band with no card row. */
const EPIC_EMPTY_WIDTH = EPIC_PADDING * 2 + CHILD_CARD_WIDTH;
const EPIC_EMPTY_HEIGHT = EPIC_HEADER_HEIGHT + EPIC_PADDING * 2 + 40;
/** Vertical gap between two un-positioned epic zones stacked in the fallback layout. */
const EPIC_STACK_GAP = 48;
/** Where the fallback grid for ordinary (non-epic, non-child) tickets starts on X, clearing
 *  the stacked epic-zone column — {@link CHILD_GRID_COLUMNS} bounds a zone's width regardless
 *  of how many children it has (only its height grows), so this stays a fixed offset rather
 *  than something computed from the actual epics. */
const OTHER_GRID_OFFSET_X = EPIC_PADDING * 2 + CHILD_GRID_COLUMNS * CHILD_COLUMN_WIDTH + 80;

function childGridPosition(i: number): { x: number; y: number } {
  return {
    x: EPIC_PADDING + (i % CHILD_GRID_COLUMNS) * CHILD_COLUMN_WIDTH,
    y: EPIC_HEADER_HEIGHT + EPIC_PADDING + Math.floor(i / CHILD_GRID_COLUMNS) * CHILD_ROW_HEIGHT,
  };
}

export type GraphNode = Node<TicketNodeData, 'ticket'> | Node<EpicZoneData, 'epicZone'>;

/**
 * One node per ticket — except an epic (`isEpic`), which becomes an `epicZone` container
 * instead of a `ticket` card, and a ticket whose `epicTaskId` names one of THIS project's own
 * epics, which becomes a `ticket` node nested under it (`parentId` + `extent: 'parent'`,
 * React Flow's sub-flow mechanism) rather than a top-level one. `saved`'s own position wins
 * either way; a child's is relative to its zone, everything else's is the canvas itself. The
 * grid fallback keeps `layoutNodes`'s original invariant — its counter only advances for a
 * node actually missing from `saved`, scoped per zone (a child) or globally (a zone/ordinary
 * ticket) — so a mix of saved and un-saved nodes never leaves gaps or reshuffles what is
 * already on screen. Parent zones are pushed before their own children, the order React Flow
 * needs to resolve a `parentId`.
 *
 * A ticket whose `epicTaskId` names an epic NOT among this project's own tickets (cannot
 * happen today — an epic and its children are always in the same project, same as ordinary
 * link endpoints — but cheap to guard, the same reasoning {@link dependencyEdges} drops a
 * dangling edge for) falls back to an ordinary top-level `ticket` node instead of a stray
 * `parentId` React Flow would refuse to resolve.
 */
export function layoutNodes(
  tickets: Task[],
  saved: Record<string, { x: number; y: number }>,
): GraphNode[] {
  const epics = tickets.filter((t) => isEpic(t));
  const epicIds = new Set(epics.map((e) => e.id));
  const childrenByEpic = new Map<string, Task[]>();
  const others: Task[] = [];
  for (const ticket of tickets) {
    if (isEpic(ticket)) continue;
    if (ticket.epicTaskId && epicIds.has(ticket.epicTaskId)) {
      const list = childrenByEpic.get(ticket.epicTaskId);
      if (list) list.push(ticket);
      else childrenByEpic.set(ticket.epicTaskId, [ticket]);
    } else {
      others.push(ticket);
    }
  }

  const nodes: GraphNode[] = [];
  let epicStackY = 0;
  for (const epic of epics) {
    const children = childrenByEpic.get(epic.id) ?? [];
    let childGridIndex = 0;
    const childNodes: Node<TicketNodeData, 'ticket'>[] = children.map((child) => ({
      id: child.id,
      type: 'ticket',
      parentId: epic.id,
      extent: 'parent',
      position: saved[child.id] ?? childGridPosition(childGridIndex++),
      data: { ticket: child },
    }));

    const width =
      childNodes.length === 0
        ? EPIC_EMPTY_WIDTH
        : Math.max(
            EPIC_EMPTY_WIDTH,
            ...childNodes.map((n) => n.position.x + CHILD_CARD_WIDTH + EPIC_PADDING),
          );
    const height =
      childNodes.length === 0
        ? EPIC_EMPTY_HEIGHT
        : Math.max(
            EPIC_EMPTY_HEIGHT,
            ...childNodes.map((n) => n.position.y + CHILD_CARD_HEIGHT + EPIC_PADDING),
          );

    let position = saved[epic.id];
    if (!position) {
      position = { x: 0, y: epicStackY };
      epicStackY += height + EPIC_STACK_GAP;
    }

    nodes.push({
      id: epic.id,
      type: 'epicZone',
      position,
      width,
      height,
      data: { epic, width, height },
    });
    nodes.push(...childNodes);
  }

  let otherGridIndex = 0;
  for (const ticket of others) {
    const position = saved[ticket.id];
    if (position) {
      nodes.push({ id: ticket.id, type: 'ticket', position, data: { ticket } });
      continue;
    }
    const fallback = gridPosition(otherGridIndex++);
    nodes.push({
      id: ticket.id,
      type: 'ticket',
      position: { x: fallback.x + OTHER_GRID_OFFSET_X, y: fallback.y },
      data: { ticket },
    });
  }

  return nodes;
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
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [chainLinks, setChainLinks] = useState<TaskLink[]>([]);
  // The pending connect gesture — `GraphLinkPicker`'s own controlled-open prop, `null` while
  // its dialog is closed. Resolved from `tickets` (not the raw ids `onConnect` hands back) so
  // the picker gets full `Task`s to show titles from and run `canLinkTickets`/`canLink` against.
  const [pendingConnection, setPendingConnection] = useState<{ from: Task; to: Task } | null>(null);
  // The edge an `onEdgeClick` resolved a kind for — `GraphLinkPicker`'s own edit-mode prop,
  // `null` while its dialog is closed the same way `pendingConnection` is for create mode.
  const [editingLink, setEditingLink] = useState<EditingGraphLink | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Both in one seed so `positions` is already populated the first time `tickets` goes
  // non-null — otherwise a node would render at its grid slot for one frame and then jump
  // to its saved one.
  const seed = useCallback(async () => {
    const [taskList, layout] = await Promise.all([
      transport.invoke('board:tasks', projectId),
      transport.invoke('ticketGraph:getLayout', projectId),
    ]);
    setPositions(Object.fromEntries(layout.map((p) => [p.taskId, { x: p.x, y: p.y }])));
    setTickets(taskList);
  }, [transport, projectId]);
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

  // Managed node state (`useNodesState`, React Flow's own `applyNodeChanges` wrapper) rather
  // than a plain `useMemo` — a fully-controlled `nodes` prop with no `onNodesChange` can't
  // absorb React Flow's live position deltas mid-drag, so nothing moved on screen until
  // `onNodeDragStop` finally updated `positions` and the memo recomputed. `layoutNodes` still
  // supplies the saved/grid position for a node this state has never seen; a node already on
  // screen keeps whatever position the drag (in progress or since finished) put it at — the
  // rest (`type`, `parentId`, `data`, and an `epicZone`'s own `width`/`height`) is always taken
  // fresh from `layoutNodes`, so a zone whose children changed resizes even while its own drag
  // position is preserved.
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  useEffect(() => {
    const laidOut = layoutNodes(tickets ?? [], positions);
    setNodes((current) => {
      const currentById = new Map(current.map((n) => [n.id, n]));
      return laidOut.map((n) => {
        const existing = currentById.get(n.id);
        return existing
          ? ({ ...n, position: existing.position, selected: existing.selected } as GraphNode)
          : n;
      });
    });
  }, [tickets, positions, setNodes]);
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(
    () => [...dependencyEdges(links, nodeIds), ...chainEdges(chainLinks, nodeIds)],
    [links, chainLinks, nodeIds],
  );

  // The debounce timer, `ModelField`'s own ref-based shape: cleared and restarted on every
  // drag stop, so a rapid string of drags writes once, and cleared on unmount so no save
  // fires against a pane the user has already left.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  /** React Flow's own drag-stop event — fires once per node (or once per node in a
   *  multi-select drag, each with its own final `position`) when the gesture ends. Merges
   *  every dragged node's new position into `positions` and (re)schedules the debounced
   *  save of the WHOLE current layout — `ticketGraph:saveLayout` has no per-node shape. */
  const handleNodeDragStop = useCallback<OnNodeDrag>(
    (_event, _node, draggedNodes) => {
      setPositions((prev) => {
        const next = { ...prev };
        for (const n of draggedNodes) next[n.id] = { x: n.position.x, y: n.position.y };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const toSave: TicketGraphPosition[] = Object.entries(next).map(([taskId, p]) => ({
            taskId,
            x: p.x,
            y: p.y,
          }));
          void transport.invoke('ticketGraph:saveLayout', projectId, toSave);
        }, SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [transport, projectId],
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

  /**
   * A click on an edge — the entry point for editing a link. Resolves the clicked edge's id
   * back to a kind the exact same way `handleEdgesDelete` does (check `links` first, then
   * `chainLinks`), then resolves BOTH endpoints back to full `Task`s (the picker needs titles
   * to show and full tickets to run `canLinkTickets`/`canLink` against, `handleConnect`'s own
   * reasoning) and opens `GraphLinkPicker` in edit mode over the result. Either half missing —
   * an endpoint ticket gone from `tickets`, or an edge id that resolves to neither list, which
   * `dependencyEdges`/`chainEdges` guarantee cannot actually happen — is silently dropped
   * rather than opening a picker with a hole in it.
   */
  const handleEdgeClick = useCallback(
    (_event: unknown, edge: Edge) => {
      const ticketLink = links.find((l) => l.id === edge.id);
      if (ticketLink) {
        const from = (tickets ?? []).find((t) => t.id === ticketLink.fromTaskId);
        const to = (tickets ?? []).find((t) => t.id === ticketLink.toTaskId);
        if (from && to) setEditingLink({ id: ticketLink.id, kind: 'blocks', from, to });
        return;
      }
      const chainLink = chainLinks.find((l) => l.id === edge.id);
      if (chainLink) {
        const from = (tickets ?? []).find((t) => t.id === chainLink.fromTaskId);
        const to = (tickets ?? []).find((t) => t.id === chainLink.toTaskId);
        if (from && to) {
          setEditingLink({ id: chainLink.id, kind: 'chain', gate: chainLink.gate, from, to });
        }
      }
    },
    [links, chainLinks, tickets],
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
            onNodesChange={onNodesChange}
            onConnect={handleConnect}
            onNodeDragStop={handleNodeDragStop}
            onEdgesDelete={handleEdgesDelete}
            onEdgeClick={handleEdgeClick}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Controls />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <GraphLinkPicker
        connection={pendingConnection}
        editingLink={editingLink}
        links={links}
        chainLinks={chainLinks}
        onClose={() => {
          setPendingConnection(null);
          setEditingLink(null);
        }}
        onDeleteTicketLink={removeTicketLink}
        onDeleteChainLink={removeChainLink}
      />
    </div>
  );
}
