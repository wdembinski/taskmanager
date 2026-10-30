/**
 * GraphPane — the Graph view of one project's tickets (Phase 24, chaining-tickets plan step 10).
 * A React Flow canvas, mounted alongside `BacklogTable` and `TimelinePane` as the third view in
 * `Projects.tsx`'s switch — never all three at once, the same reasoning `TimelinePane`'s own
 * doc gives for why a project switch remounts rather than reconciles.
 *
 * Loads its own tickets the same way `BacklogTable`/`TimelinePane` do: seed via `board:tasks`,
 * then stay live off `task:changed` (per-ticket patch) and `tasks:changed` (a delta merged in
 * — a ticket can also leave this way).
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
 * cyan for a chain — `FLUO_VAR.cyan` is the app's one colour for "moving", the same one
 * `TimelinePane`'s own `chain` style and `ChainOverlay`'s `releasing` state use (and
 * `GRAPH_INK.live`'s own budget for the commit graph). A link whose
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
 *
 * **Archived stubs (F14.6).** `tickets` from the seed still holds every ticket, archived or
 * not — `visible` (`visibleTickets`) is what actually reaches `layoutNodes`, so a hidden
 * ticket's own node, and an archived epic's whole zone, simply stop being drawn. A hidden
 * ticket that is one end of a `blocks` dependency or chain link to a ticket still ON screen
 * does not just vanish, though — a dangling edge would be confusing in a way an absent node
 * is not, so `archivedStubs` picks those out and `layoutNodes` draws each as a compact,
 * read-only `archivedStub` node (`ArchivedStubNode`) instead: never nested under an epic zone
 * even if it has one, not draggable into a link (`connectable: false`) and not erasable from
 * the canvas (`deletable: false` — the ticket itself still exists, only restoring it from the
 * Archived view brings its real node back). The edge touching it draws dashed and in
 * `tokens.colorNeutralStroke3` regardless of its own kind — cyan is this pane's one colour for
 * "moving" (see above), and an edge ending at a stub is not something that can move. With
 * `includeArchived` on, `visible` already holds everything, so `hidden` — and therefore
 * `archivedStubs` — is empty: nothing is a stub, every ticket draws as its ordinary node.
 * `handleConnect`/`handleEdgeClick` still resolve against the full `tickets` list rather than
 * `visible`, so editing or deleting the link a stub is drawn for keeps working the same way it
 * always has.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Caption1,
  MessageBar,
  MessageBarBody,
  ToggleButton,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
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
import type { Milestone, Project, TicketGraphPosition, TicketLink } from '@tm/shared/model';
import type { TaskSummary } from '@tm/shared/taskSummary';
import type { TaskLink } from '@tm/shared/taskChain';
import { isEpic, typeIconKeyFor } from '@tm/shared/tickets';
import { archiveIndexOf, visibleTickets } from '@tm/shared/trackerArchive';
import { PaneLoading } from '../PaneLoading';
import { FLUO_VAR } from '../tokens';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import { useTaskSummaries } from '../useTaskSummaries';
import { GraphLinkPicker, type EditingGraphLink } from './GraphLinkPicker';
import { issueTypeGlyph } from './issueTypeGlyph';

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
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
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
  /** An archived stub's own card — `card`'s dashed twin, declared after it so Griffel resolves
   *  the `border` clash in this class's favour. Same footprint, so a stub never reads as a
   *  smaller or more important node than the ordinary ticket it is standing in for. */
  stubCard: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
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
  /** A stub's key and its "Archived" caption — both muted, declared after `key` so Griffel
   *  resolves the `color` clash in this class's favour. */
  muted: { color: tokens.colorNeutralForeground3 },
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

type TicketNodeData = { ticket: TaskSummary };

function TicketNode({ data }: NodeProps<Node<TicketNodeData>>): JSX.Element {
  const styles = useStyles();
  const { ticket } = data;
  return (
    <div className={styles.card}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.head}>
        <span className={styles.type}>{issueTypeGlyph(typeIconKeyFor(ticket))}</span>
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
type EpicZoneData = { epic: TaskSummary; width: number; height: number };

function EpicZoneNode({ data }: NodeProps<Node<EpicZoneData>>): JSX.Element {
  const styles = useStyles();
  const { epic, width, height } = data;
  return (
    <div className={styles.zone} style={{ width, height }}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.zoneHead}>
        <span className={styles.type}>{issueTypeGlyph(typeIconKeyFor(epic))}</span>
        <span className={styles.key}>{epic.ticketKey ?? '—'}</span>
        <Caption1 className={styles.zoneTitle}>{epic.title}</Caption1>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** An archived ticket that is one end of a link to a still-visible one (F14.6) — never a
 *  "real" node for the ticket (that would mean it isn't hidden), only a stand-in so the link
 *  stays drawn instead of silently dropping. `card`'s own layout, dashed and muted, with the
 *  same type glyph `TicketNode` draws — a stub is still THAT ticket, not an anonymous dot. */
type ArchivedStubData = { ticket: TaskSummary };

function ArchivedStubNode({ data }: NodeProps<Node<ArchivedStubData>>): JSX.Element {
  const styles = useStyles();
  const { ticket } = data;
  return (
    <div className={mergeClasses(styles.card, styles.stubCard)}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.head}>
        <span className={styles.type}>{issueTypeGlyph(typeIconKeyFor(ticket))}</span>
        <span className={mergeClasses(styles.key, styles.muted)}>{ticket.ticketKey ?? '—'}</span>
      </div>
      <Caption1 className={styles.muted}>Archived</Caption1>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { ticket: TicketNode, epicZone: EpicZoneNode, archivedStub: ArchivedStubNode };

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

export type GraphNode =
  | Node<TicketNodeData, 'ticket'>
  | Node<EpicZoneData, 'epicZone'>
  | Node<ArchivedStubData, 'archivedStub'>;

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
 *
 * `stubs` (F14.6, see {@link archivedStubs}) are archived tickets that did not make it into
 * `tickets` at all but still need a node so the link they are drawn for has somewhere to land —
 * each becomes a top-level `archivedStub` node, laid out AFTER every ordinary top-level ticket
 * so the two share one "others" grid-fallback sequence rather than two independent ones that
 * could land on the same slot. Never nested under an epic zone, even when the stub's own
 * `epicTaskId` would otherwise have put it there — the zone itself is either drawn (the epic is
 * visible) or it isn't (gone along with every one of its children), and a stub does not belong
 * inside a zone that may not even be on screen. `connectable: false`/`deletable: false` on every
 * stub — it is not really here, only standing in for a ticket this view has chosen to hide.
 */
export function layoutNodes(
  tickets: TaskSummary[],
  saved: Record<string, { x: number; y: number }>,
  stubs: TaskSummary[] = [],
): GraphNode[] {
  const epics = tickets.filter((t) => isEpic(t));
  const epicIds = new Set(epics.map((e) => e.id));
  const childrenByEpic = new Map<string, TaskSummary[]>();
  const others: TaskSummary[] = [];
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

  for (const ticket of stubs) {
    const position = saved[ticket.id];
    if (position) {
      nodes.push({
        id: ticket.id,
        type: 'archivedStub',
        position,
        data: { ticket },
        connectable: false,
        deletable: false,
      });
      continue;
    }
    const fallback = gridPosition(otherGridIndex++);
    nodes.push({
      id: ticket.id,
      type: 'archivedStub',
      position: { x: fallback.x + OTHER_GRID_OFFSET_X, y: fallback.y },
      data: { ticket },
      connectable: false,
      deletable: false,
    });
  }

  return nodes;
}

/** Grey `blocks` dependency — `TimelinePane.dependency`'s own colour, `tokens.colorNeutralStroke1`. */
const DEPENDENCY_STROKE = tokens.colorNeutralStroke1;
/** Cyan execution chain — `TimelinePane.chain`'s own colour, `FLUO_VAR.cyan` (`GRAPH_INK.live`'s
 *  own budget: the one coloured thing on an otherwise monochrome drawing). */
const CHAIN_STROKE = FLUO_VAR.cyan;
/** An edge touching an archived stub (F14.6) — muted and dashed regardless of its own kind,
 *  `tokens.colorNeutralStroke3`: cyan is this pane's one colour for "moving", and an edge
 *  ending at a stub is not something that can. Outranks {@link CHAIN_STROKE} as much as
 *  {@link DEPENDENCY_STROKE}. */
const STUB_STROKE = tokens.colorNeutralStroke3;
const STUB_DASH = '4 3';

/**
 * The hidden tickets `layoutNodes` should still draw a node for — one end of a `blocks`
 * dependency or chain link whose OTHER end is still visible. A hidden ticket with no such link
 * (or whose links are to other hidden tickets only) yields no stub: there is nothing left on
 * screen for a dangling edge to reach. Each qualifying ticket is returned once, in `hidden`'s
 * own order, even if it is the hidden end of several such links.
 */
export function archivedStubs(
  hidden: TaskSummary[],
  links: TicketLink[],
  chainLinks: TaskLink[],
  visibleIds: Set<string>,
): TaskSummary[] {
  const hiddenIds = new Set(hidden.map((t) => t.id));
  const stubIds = new Set<string>();
  const note = (fromId: string, toId: string): void => {
    if (hiddenIds.has(fromId) && visibleIds.has(toId)) stubIds.add(fromId);
    if (hiddenIds.has(toId) && visibleIds.has(fromId)) stubIds.add(toId);
  };
  for (const link of links) {
    if (link.type === 'blocks') note(link.fromTaskId, link.toTaskId);
  }
  for (const link of chainLinks) {
    note(link.fromTaskId, link.toTaskId);
  }
  return hidden.filter((ticket) => stubIds.has(ticket.id));
}

/** One `blocks` dependency edge per link of that type — the others (`relates`, `duplicates`,
 *  …) are documentary and drawn nowhere in this app yet. Dropped, not just unstyled, if either
 *  end is not among `nodeIds` — a React Flow edge naming a missing node warns to the console.
 *  An edge with either end in `stubIds` draws muted and dashed instead of its ordinary grey
 *  (see {@link STUB_STROKE}). */
export function dependencyEdges(
  links: TicketLink[],
  nodeIds: Set<string>,
  stubIds: Set<string>,
): Edge[] {
  return links
    .filter((l) => l.type === 'blocks' && nodeIds.has(l.fromTaskId) && nodeIds.has(l.toTaskId))
    .map((l) => {
      const toStub = stubIds.has(l.fromTaskId) || stubIds.has(l.toTaskId);
      const stroke = toStub ? STUB_STROKE : DEPENDENCY_STROKE;
      return {
        id: l.id,
        source: l.fromTaskId,
        target: l.toTaskId,
        style: toStub
          ? { stroke, strokeWidth: 1.5, strokeDasharray: STUB_DASH }
          : { stroke, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
}

/** One execution-chain edge per chain link — same shape as {@link dependencyEdges}, cyan unless
 *  it touches a stub, in which case {@link STUB_STROKE} wins over the cyan too. */
export function chainEdges(links: TaskLink[], nodeIds: Set<string>, stubIds: Set<string>): Edge[] {
  return links
    .filter((l) => nodeIds.has(l.fromTaskId) && nodeIds.has(l.toTaskId))
    .map((l) => {
      const toStub = stubIds.has(l.fromTaskId) || stubIds.has(l.toTaskId);
      const stroke = toStub ? STUB_STROKE : CHAIN_STROKE;
      return {
        id: l.id,
        source: l.fromTaskId,
        target: l.toTaskId,
        style: toStub
          ? { stroke, strokeWidth: 1.5, strokeDasharray: STUB_DASH }
          : { stroke, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
}

export interface GraphPaneProps {
  projectId: string;
  /** The ticket open in `Projects.tsx`'s own shared detail pane. React Flow's own node
   *  `selected` is not kept in sync with it — the canvas's own click/drag selection is
   *  a separate concern from which ticket the detail pane is showing. */
  selectedTicketId?: string | null;
  /** Open a ticket in the shared detail pane. */
  onSelectTicket: (id: string) => void;
  /** `Projects.tsx`'s own `registries.milestones` — `TimelinePane`'s own prop, for this pane's
   *  `ArchiveIndex` (F14.6), built the same way `TimelinePane.archiveIndex` is. */
  milestones?: Milestone[];
  /** `Projects.tsx`'s own ticket-project list, for the archive lookup (F14.6). */
  projects?: Project[] | null;
  /** The "Include archived" toggle (F14.6), shared with the Backlog's and Timeline's own —
   *  drops hidden nodes (`visibleTickets`) and stubs the links a still-visible one keeps
   *  (`archivedStubs`) when off. */
  includeArchived?: boolean;
  onIncludeArchivedChange?: (includeArchived: boolean) => void;
}

export function GraphPane({
  projectId,
  onSelectTicket,
  milestones,
  projects,
  includeArchived = false,
  onIncludeArchivedChange,
}: GraphPaneProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  // Card summaries (F29.2), merged from deltas — a ticket leaving (deleted) arrives as a
  // delta's `removed`, which no per-task patch would ever say.
  const summaries = useTaskSummaries(projectId, { clearOnScopeChange: true });
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  // Held back until the layout has landed too, so `positions` is already populated the first
  // time `tickets` goes non-null.
  const tickets = layoutLoaded ? summaries.tasks : null;
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [chainLinks, setChainLinks] = useState<TaskLink[]>([]);
  // The pending connect gesture — `GraphLinkPicker`'s own controlled-open prop, `null` while
  // its dialog is closed. Resolved from `tickets` (not the raw ids `onConnect` hands back) so
  // the picker gets full `Task`s to show titles from and run `canLinkTickets`/`canLink` against.
  const [pendingConnection, setPendingConnection] = useState<{
    from: TaskSummary;
    to: TaskSummary;
  } | null>(null);
  // The edge an `onEdgeClick` resolved a kind for — `GraphLinkPicker`'s own edit-mode prop,
  // `null` while its dialog is closed the same way `pendingConnection` is for create mode.
  const [editingLink, setEditingLink] = useState<EditingGraphLink | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Both in one seed so `positions` is already populated the first time `tickets` goes
  // non-null — otherwise a node would render at its grid slot for one frame and then jump
  // to its saved one.
  const seed = useCallback(async () => {
    setLayoutLoaded(false);
    const layout = await transport.invoke('ticketGraph:getLayout', projectId);
    setPositions(Object.fromEntries(layout.map((p) => [p.taskId, { x: p.x, y: p.y }])));
    setLayoutLoaded(true);
  }, [transport, projectId]);
  const layoutLoad = useInitialLoad(seed);
  const initial = {
    error: layoutLoad.error ?? summaries.error,
    retry: () => {
      layoutLoad.retry();
      summaries.retry();
    },
  };

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

  /** This pane's own archive lookup (F14.6) — `TimelinePane.archiveIndex`'s own shape, over
   *  `milestones`, epics from this project's own `tickets`, and tracker projects from
   *  `projects`. */
  const archiveIndex = useMemo(
    () => archiveIndexOf(milestones ?? [], tickets ?? [], projects ?? []),
    [milestones, tickets, projects],
  );
  /** `tickets`, with every archived-hidden row dropped unless `includeArchived` is set — the
   *  only list `layoutNodes`'s ordinary (non-stub) pass ever sees. */
  const visible = useMemo(
    () => visibleTickets(tickets ?? [], archiveIndex, { includeArchived }),
    [tickets, archiveIndex, includeArchived],
  );
  const visibleIds = useMemo(() => new Set(visible.map((t) => t.id)), [visible]);
  /** Everything `visible` left out — empty whenever `includeArchived` is set, since `visible`
   *  then holds every ticket `tickets` does. */
  const hidden = useMemo(
    () => (tickets ?? []).filter((t) => !visibleIds.has(t.id)),
    [tickets, visibleIds],
  );
  const stubs = useMemo(
    () => archivedStubs(hidden, links, chainLinks, visibleIds),
    [hidden, links, chainLinks, visibleIds],
  );
  const stubIds = useMemo(() => new Set(stubs.map((t) => t.id)), [stubs]);

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
    const laidOut = layoutNodes(visible, positions, stubs);
    setNodes((current) => {
      const currentById = new Map(current.map((n) => [n.id, n]));
      return laidOut.map((n) => {
        const existing = currentById.get(n.id);
        return existing
          ? ({ ...n, position: existing.position, selected: existing.selected } as GraphNode)
          : n;
      });
    });
  }, [visible, stubs, positions, setNodes]);
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(
    () => [
      ...dependencyEdges(links, nodeIds, stubIds),
      ...chainEdges(chainLinks, nodeIds, stubIds),
    ],
    [links, chainLinks, nodeIds, stubIds],
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
      <div className={styles.toolbar}>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={includeArchived}
          onClick={() => onIncludeArchivedChange?.(!includeArchived)}
        >
          Include archived
        </ToggleButton>
      </div>
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
            onNodeClick={(_e, node) => onSelectTicket(node.id)}
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
