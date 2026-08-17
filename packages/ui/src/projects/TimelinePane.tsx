/**
 * TimelinePane — the Gantt view of one project's tickets (Phase 24 steps 6-7). A bar shows
 * where a ticket is planned, and — since step 7 — can be dragged to move it, dragged by
 * either edge to resize it, or nudged a day at a time from the keyboard.
 *
 * Loads its own tickets and links the same way `BacklogTable` loads its own tickets — the two
 * panes are a Backlog/Timeline SWITCH in `Projects.tsx`, never mounted together, so there is
 * nothing for two independent seeds to disagree about.
 *
 * **Layout, without a line of position math in this file.** The header (`GanttHeader`) and
 * every row sit in ONE normal document flow, stacked top to bottom at their natural heights —
 * `GANTT_ROW_HEIGHT` from `ganttLayout.ts` is every row's CSS height, so row `i`'s vertical
 * centre is simply `i * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2` with nothing to keep in sync.
 * The header is `position: sticky; top: 0` and the label cells are `position: sticky; left: 0`,
 * both against the one scrolling element (`scroll`) — that is what lets the row labels and the
 * month/day header stay put while the chart scrolls under them, with no scroll-event listener
 * anywhere in this file.
 *
 * The bars, the milestone guide-lines, the "today" line and the dependency arrows are ONE
 * `<svg>` laid over the rows — the same arrangement `ChainOverlay`/`GitGraphPane` use, and for
 * the same reason: a curve from one bar to another has nowhere to be drawn but a layer that
 * spans every row it might cross. It takes fixed pixel `width`/`height`, no `viewBox` — see
 * `ganttLayout.ts`'s header for why a Gantt has to stay 1px = 1px.
 *
 * An undated ticket (`ganttBar` → null) never gets a bar; it is listed in the unscheduled
 * tray below the chart instead, which is what "→ the unscheduled tray" in `ganttLayout.ts`'s
 * own docs refers to.
 *
 * **The drag gesture is native pointer events, not HTML5 DnD** — the board's own drag
 * (`board/chainDrag.ts`) reuses `dataTransfer` because it is choosing between two DnD
 * payloads; a bar has no payload to carry, only a pixel delta, and DnD cannot report one
 * mid-drag the way `pointermove` does. `setPointerCapture` is released on BOTH `pointerup`
 * and `pointercancel` — a plain browser tab (the web mirror, `web-mirrors-the-desktop`) can
 * lose the pointer to the page's own scroll gesture in a way an Electron window never will,
 * and a capture that is only released on `pointerup` would leave the next click starting a
 * phantom drag.
 *
 * Committing a drag follows `moveTask`'s optimistic shape in `MyTasks.tsx`: paint the
 * rescheduled dates the instant the gesture ends, await `ticket:update`, paint what came
 * back, and on a throw paint the ticket this pane had before the drag and surface the
 * message. On the web that await is a relayed round trip through the desktop's own poll —
 * seconds, not milliseconds — so the optimistic paint is what makes the drag read as a drag
 * there, not merely a nicety.
 *
 * A collapsed epic's row draws the UNION of its children's bars (see `ganttRows`), which is
 * not `row.ticket`'s own `startAt`/`dueAt` — there is nothing coherent to reschedule TO, so
 * that one row's bar stays inert; expand it and its children drag individually.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Caption1,
  MessageBar,
  MessageBarBody,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { Milestone, Person, Task, TicketLabel, TicketLink } from '@tm/shared/model';
import type { AppSettings } from '@tm/shared/settings';
import { FoldToggle } from '../FoldToggle';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import {
  DAY_MS,
  GANTT_ROW_HEIGHT,
  collapsedEpicSet,
  ganttDependencyPath,
  ganttMarkers,
  ganttRange,
  ganttRows,
  ganttScale,
  ganttTicks,
  rescheduleTo,
  todayX,
  toggleCollapsedEpic,
  type GanttBar,
  type GanttRow,
  type RescheduleEdge,
} from './ganttLayout';
import { GanttHeader } from './GanttHeader';
import { TicketDrawer } from './TicketDrawer';

/** How far a pointer has to move, in px, before a press on a bar counts as a drag. Below
 *  this it is a click — opening the drawer — the same threshold a native DnD would apply. */
const DRAG_THRESHOLD_PX = 3;
/** A resize handle's width, in px — thin strips at each end of a bar, `ew-resize` cursored. */
const HANDLE_WIDTH_PX = 6;

/** One in-flight drag gesture, tracked from the `pointerdown` that started it. */
interface DragState {
  ticketId: string;
  edge: RescheduleEdge;
  pointerId: number;
  startClientX: number;
  /** How far the pointer has moved since `startClientX` — px, screen space, not chart space. */
  deltaPx: number;
}

/** `bar`, shifted by an in-flight drag's live `deltaPx` — a pure preview, nothing snapped or
 *  clamped yet (that happens once on release, in `ganttLayout.ts`'s `rescheduleTo`). */
function previewBar(bar: GanttBar, drag: DragState | null, rowId: string): GanttBar {
  if (!drag || drag.ticketId !== rowId) return bar;
  if (drag.edge === 'move') return { x: bar.x + drag.deltaPx, width: bar.width };
  if (drag.edge === 'start') {
    const width = Math.max(HANDLE_WIDTH_PX, bar.width - drag.deltaPx);
    return { x: bar.x + bar.width - width, width };
  }
  return { x: bar.x, width: Math.max(HANDLE_WIDTH_PX, bar.width + drag.deltaPx) };
}

/** The row label column's fixed width — everything to its right is the scrollable chart. */
const LABEL_WIDTH = 260;
/** How many px one calendar day gets. Wide enough for a two-digit day label under it. */
const PX_PER_DAY = 28;
/** The bar's top/bottom margin inside its row. */
const BAR_INSET = 6;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, height: '100%' },
  scroll: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  headerRow: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
  },
  corner: {
    position: 'sticky',
    left: 0,
    zIndex: 3,
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { position: 'relative' },
  row: {
    display: 'flex',
    height: `${GANTT_ROW_HEIGHT}px`,
    boxSizing: 'border-box',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  label: {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '0 8px',
    boxSizing: 'border-box',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
  },
  labelChild: { paddingLeft: '24px' },
  key: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chart: { position: 'absolute', top: 0, pointerEvents: 'none' },
  bar: {
    fill: tokens.colorBrandBackground2,
    stroke: tokens.colorBrandStroke1,
    strokeWidth: '1px',
    pointerEvents: 'auto',
    cursor: 'grab',
  },
  barStatic: { cursor: 'pointer' },
  barEpic: { fill: tokens.colorBrandBackground, opacity: 0.85 },
  handle: {
    fill: 'transparent',
    pointerEvents: 'auto',
    cursor: 'ew-resize',
  },
  barText: {
    fill: tokens.colorNeutralForegroundOnBrand,
    fontSize: '11px',
    pointerEvents: 'none',
  },
  guide: { stroke: tokens.colorNeutralStroke2, strokeDasharray: '3 3' },
  today: { stroke: tokens.colorBrandStroke1, strokeWidth: '1.5px', strokeDasharray: '4 3' },
  dependency: { fill: 'none', stroke: tokens.colorNeutralStroke1, strokeWidth: '1.5px' },
  tray: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxHeight: '140px',
    overflowY: 'auto',
  },
  trayRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
  },
  empty: { color: tokens.colorNeutralForeground3, padding: '8px 0' },
  muted: { color: tokens.colorNeutralForeground3 },
});

export interface TimelinePaneProps {
  projectId: string;
  people: Person[];
  labels: TicketLabel[];
  milestones: Milestone[];
}

function rowLabel(ticket: Pick<Task, 'ticketKey' | 'title'>): {
  key: string | null;
  title: string;
} {
  return { key: ticket.ticketKey ?? null, title: ticket.title };
}

export function TimelinePane({
  projectId,
  people,
  labels,
  milestones,
}: TimelinePaneProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const [tickets, setTickets] = useState<Task[] | null>(null);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  // Set the instant a drag's pointer movement clears `DRAG_THRESHOLD_PX`, and read once by
  // the bar's `onClick` right after — a real drag must not also open the drawer the way a
  // plain click does, and `pointerup` cannot itself suppress the `click` that follows it.
  const justDraggedRef = useRef(false);

  /** Replace one ticket in `tickets` with the server's own copy — `moveTask`'s `patchTask`
   *  in `MyTasks.tsx`, for this pane's own list. */
  const patchTicket = useCallback((updated: Task) => {
    setTickets((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
  }, []);

  const seed = useCallback(async () => {
    const [ownTickets, allSettings] = await Promise.all([
      transport.invoke('board:tasks', projectId),
      transport.invoke('settings:get'),
    ]);
    setTickets(ownTickets);
    setSettings(allSettings);
  }, [transport, projectId]);
  const initial = useInitialLoad(seed);

  useEffect(() => {
    const offTask = transport.on('task:changed', ({ task }) => {
      if (task.projectId !== projectId) return;
      patchTicket(task);
    });
    const offTasks = transport.on('project:tasksChanged', ({ projectId: changed, tasks }) => {
      if (changed !== projectId) return;
      setTickets(tasks);
    });
    const offSettings = transport.on('settings:changed', setSettings);
    return () => {
      offTask();
      offTasks();
      offSettings();
    };
  }, [transport, projectId, patchTicket]);

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

  const now = useMemo(() => Date.now(), [tickets, milestones]);
  const collapsedEpicIds = useMemo(
    () => collapsedEpicSet(settings?.gantt.collapsedEpicIds),
    [settings],
  );

  const toggleEpic = useCallback(
    (epicId: string) => {
      const onBoard = new Set(
        (tickets ?? []).filter((t) => t.issueType === 'epic').map((t) => t.id),
      );
      setSettings((prev) => {
        if (!prev) return prev;
        const next: AppSettings = {
          ...prev,
          gantt: {
            collapsedEpicIds: toggleCollapsedEpic(prev.gantt.collapsedEpicIds, epicId, onBoard),
          },
        };
        void transport.invoke('settings:save', next);
        return next;
      });
    },
    [tickets, transport],
  );

  // Two passes: the calendar-day COUNT depends only on the range, not on how many pixels one
  // day gets — so the first scale (any width at all) is purely to learn that count, and the
  // second is the one actually drawn from. See `ganttLayout.ts`'s `ganttTicks`.
  const range = useMemo(
    () => ganttRange(tickets ?? [], milestones, now),
    [tickets, milestones, now],
  );
  const dayCount = useMemo(() => ganttTicks(ganttScale(range, 1)).days.length, [range]);
  const chartWidth = Math.max(1, dayCount) * PX_PER_DAY;
  const scale = useMemo(() => ganttScale(range, chartWidth), [range, chartWidth]);

  /**
   * `moveTask`'s optimistic shape (`MyTasks.tsx`), for a ticket's dates instead of its column:
   * paint the rescheduled ticket immediately, await `ticket:update`, paint what came back —
   * and on a throw, paint the ticket this pane held before the drag and surface the message,
   * rather than leaving the optimistic (and now possibly wrong) guess on screen.
   */
  const commitReschedule = useCallback(
    async (ticket: Task, deltaMs: number, edge: RescheduleEdge) => {
      const result = rescheduleTo(ticket, deltaMs, edge);
      if (!result) return;
      setDragError(null);
      patchTicket({ ...ticket, startAt: result.startAt, dueAt: result.dueAt });
      try {
        const saved = await transport.invoke('ticket:update', ticket.id, {
          startAt: result.startAt,
          dueAt: result.dueAt,
        });
        patchTicket(saved);
      } catch (e) {
        patchTicket(ticket);
        setDragError(e instanceof Error ? e.message : String(e));
      }
    },
    [transport, patchTicket],
  );

  const handleBarPointerDown = useCallback(
    (e: React.PointerEvent<SVGRectElement>, ticketId: string, edge: RescheduleEdge) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ ticketId, edge, pointerId: e.pointerId, startClientX: e.clientX, deltaPx: 0 });
    },
    [],
  );

  const handleBarPointerMove = useCallback((e: React.PointerEvent<SVGRectElement>) => {
    setDrag((prev) => {
      if (!prev || prev.pointerId !== e.pointerId) return prev;
      return { ...prev, deltaPx: e.clientX - prev.startClientX };
    });
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<SVGRectElement>, commit: boolean) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setDrag((prev) => {
        if (!prev || prev.pointerId !== e.pointerId) return prev;
        if (commit && Math.abs(prev.deltaPx) >= DRAG_THRESHOLD_PX) {
          justDraggedRef.current = true;
          const ticket = (tickets ?? []).find((t) => t.id === prev.ticketId);
          // The linear scale's own affine offset cancels out of a DIFFERENCE of two `msOf`
          // calls, leaving exactly the ms a px DELTA represents — see `rescheduleTo`'s doc.
          const deltaMs = scale.msOf(prev.deltaPx) - scale.msOf(0);
          if (ticket) void commitReschedule(ticket, deltaMs, prev.edge);
        }
        return null;
      });
    },
    [tickets, scale, commitReschedule],
  );

  const handleBarKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGRectElement>, ticket: Task) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      void commitReschedule(ticket, e.key === 'ArrowLeft' ? -DAY_MS : DAY_MS, 'move');
    },
    [commitReschedule],
  );

  const ticks = useMemo(() => ganttTicks(scale), [scale]);
  const markers = useMemo(() => ganttMarkers(milestones, scale), [milestones, scale]);
  const today = todayX(scale, now);

  const rows = useMemo(
    () => ganttRows(tickets ?? [], scale, collapsedEpicIds),
    [tickets, scale, collapsedEpicIds],
  );
  const scheduledRows = useMemo(() => rows.filter((r) => r.bar !== null), [rows]);
  const unscheduledRows = useMemo(() => rows.filter((r) => r.bar === null), [rows]);

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    scheduledRows.forEach((r, i) => map.set(r.id, i));
    return map;
  }, [scheduledRows]);

  const dependencyPaths = useMemo(() => {
    const out: { key: string; d: string }[] = [];
    for (const link of links) {
      if (link.type !== 'blocks') continue;
      const fromIdx = rowIndexById.get(link.fromTaskId);
      const toIdx = rowIndexById.get(link.toTaskId);
      if (fromIdx === undefined || toIdx === undefined) continue;
      const fromBar = scheduledRows[fromIdx].bar;
      const toBar = scheduledRows[toIdx].bar;
      if (!fromBar || !toBar) continue;
      const d = ganttDependencyPath(
        {
          x: fromBar.x,
          width: fromBar.width,
          y: fromIdx * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2,
        },
        { x: toBar.x, y: toIdx * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2 },
      );
      out.push({ key: link.id, d });
    }
    return out;
  }, [links, rowIndexById, scheduledRows]);

  if (tickets === null) {
    return (
      <PaneLoading
        label="Loading timeline…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) ?? null;
  const chartHeight = scheduledRows.length * GANTT_ROW_HEIGHT;

  return (
    <div className={styles.root}>
      {dragError && (
        <MessageBar intent="error">
          <MessageBarBody>{dragError}</MessageBarBody>
        </MessageBar>
      )}
      {rows.length === 0 ? (
        <Body1 className={styles.empty}>No tickets in this project yet.</Body1>
      ) : (
        <div className={styles.scroll}>
          <div style={{ width: `${LABEL_WIDTH + chartWidth}px` }}>
            <div className={styles.headerRow}>
              <div className={styles.corner} style={{ width: `${LABEL_WIDTH}px` }} />
              <GanttHeader ticks={ticks} markers={markers} width={chartWidth} />
            </div>

            {scheduledRows.length > 0 && (
              <div className={styles.body} style={{ height: `${chartHeight}px` }}>
                {scheduledRows.map((row) => (
                  <RowLabel
                    key={row.id}
                    row={row}
                    labelWidth={LABEL_WIDTH}
                    collapsed={collapsedEpicIds.has(row.ticket.id)}
                    onToggle={toggleEpic}
                    onSelect={setSelectedTicketId}
                  />
                ))}

                <svg
                  className={styles.chart}
                  style={{ left: `${LABEL_WIDTH}px` }}
                  width={chartWidth}
                  height={chartHeight}
                >
                  {markers.map((m) => (
                    <line
                      key={m.milestoneId}
                      className={styles.guide}
                      x1={m.x}
                      y1={0}
                      x2={m.x}
                      y2={chartHeight}
                      aria-hidden="true"
                    />
                  ))}
                  {today != null && (
                    <line
                      className={styles.today}
                      x1={today}
                      y1={0}
                      x2={today}
                      y2={chartHeight}
                      aria-hidden="true"
                    />
                  )}
                  {dependencyPaths.map((p) => (
                    <path key={p.key} className={styles.dependency} d={p.d} aria-hidden="true" />
                  ))}
                  {scheduledRows.map((row, i) => {
                    const isEpic = row.ticket.issueType === 'epic';
                    // A collapsed epic's bar unions its children's — it is not the epic
                    // ticket's own dates, so there is nothing coherent to drag it TO.
                    const draggable = !(isEpic && collapsedEpicIds.has(row.ticket.id));
                    const bar = draggable ? previewBar(row.bar!, drag, row.id) : row.bar!;
                    const y = i * GANTT_ROW_HEIGHT + BAR_INSET;
                    const height = GANTT_ROW_HEIGHT - BAR_INSET * 2;
                    const label = row.ticket.ticketKey
                      ? `${row.ticket.ticketKey} ${row.ticket.title}`
                      : row.ticket.title;
                    return (
                      <g
                        key={row.id}
                        onClick={() => {
                          if (justDraggedRef.current) {
                            justDraggedRef.current = false;
                            return;
                          }
                          setSelectedTicketId(row.id);
                        }}
                      >
                        <title>{label}</title>
                        <rect
                          x={bar.x}
                          y={y}
                          width={bar.width}
                          height={height}
                          rx={4}
                          className={mergeClasses(
                            styles.bar,
                            !draggable && styles.barStatic,
                            isEpic && styles.barEpic,
                          )}
                          tabIndex={draggable ? 0 : undefined}
                          role={draggable ? 'button' : undefined}
                          aria-label={
                            draggable
                              ? `${label} — drag or use arrow keys to reschedule`
                              : undefined
                          }
                          onPointerDown={
                            draggable ? (e) => handleBarPointerDown(e, row.id, 'move') : undefined
                          }
                          onPointerMove={draggable ? handleBarPointerMove : undefined}
                          onPointerUp={draggable ? (e) => endDrag(e, true) : undefined}
                          onPointerCancel={draggable ? (e) => endDrag(e, false) : undefined}
                          onKeyDown={draggable ? (e) => handleBarKeyDown(e, row.ticket) : undefined}
                        />
                        {bar.width > 24 && (
                          <text
                            x={bar.x + 6}
                            y={y + height / 2}
                            dominantBaseline="central"
                            className={styles.barText}
                            aria-hidden="true"
                          >
                            {row.ticket.title}
                          </text>
                        )}
                        {draggable && (
                          <>
                            <rect
                              x={bar.x}
                              y={y}
                              width={HANDLE_WIDTH_PX}
                              height={height}
                              className={styles.handle}
                              aria-hidden="true"
                              onPointerDown={(e) => handleBarPointerDown(e, row.id, 'start')}
                              onPointerMove={handleBarPointerMove}
                              onPointerUp={(e) => endDrag(e, true)}
                              onPointerCancel={(e) => endDrag(e, false)}
                            />
                            <rect
                              x={bar.x + bar.width - HANDLE_WIDTH_PX}
                              y={y}
                              width={HANDLE_WIDTH_PX}
                              height={height}
                              className={styles.handle}
                              aria-hidden="true"
                              onPointerDown={(e) => handleBarPointerDown(e, row.id, 'end')}
                              onPointerMove={handleBarPointerMove}
                              onPointerUp={(e) => endDrag(e, true)}
                              onPointerCancel={(e) => endDrag(e, false)}
                            />
                          </>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
          </div>
        </div>
      )}

      {unscheduledRows.length > 0 && (
        <div className={styles.tray}>
          <Caption1 className={styles.muted}>Unscheduled — {unscheduledRows.length}</Caption1>
          {unscheduledRows.map((row) => {
            const label = rowLabel(row.ticket);
            return (
              <div
                key={row.id}
                className={styles.trayRow}
                onClick={() => setSelectedTicketId(row.id)}
              >
                {label.key && <Badge appearance="tint">{label.key}</Badge>}
                <Body1>{label.title}</Body1>
              </div>
            );
          })}
        </div>
      )}

      <TicketDrawer
        ticket={selectedTicket}
        tickets={tickets}
        people={people}
        labels={labels}
        milestones={milestones}
        onClose={() => setSelectedTicketId(null)}
      />
    </div>
  );
}

/** One row's sticky label cell — the epic's own fold toggle, or a plain (possibly indented) title. */
function RowLabel({
  row,
  labelWidth,
  collapsed,
  onToggle,
  onSelect,
}: {
  row: GanttRow;
  labelWidth: number;
  collapsed: boolean;
  onToggle: (epicId: string) => void;
  onSelect: (ticketId: string) => void;
}): JSX.Element {
  const styles = useStyles();
  const label = rowLabel(row.ticket);
  const isEpic = row.ticket.issueType === 'epic';

  // An epic's row reads as ONE control — the fold toggle — the same way `FoldToggle`'s own
  // header does everywhere else it is used; clicking it collapses the row rather than opening
  // the drawer, which stays reachable from any of its (still-clickable) child rows instead.
  return (
    <div
      className={mergeClasses(styles.row, styles.label, row.depth === 1 && styles.labelChild)}
      style={{ width: `${labelWidth}px` }}
      onClick={isEpic ? undefined : () => onSelect(row.ticket.id)}
    >
      {isEpic ? (
        <FoldToggle open={!collapsed} onToggle={() => onToggle(row.ticket.id)}>
          <span className={styles.title}>{label.title}</span>
        </FoldToggle>
      ) : (
        <>
          {label.key && <span className={styles.key}>{label.key}</span>}
          <span className={styles.title}>{label.title}</span>
        </>
      )}
    </div>
  );
}
