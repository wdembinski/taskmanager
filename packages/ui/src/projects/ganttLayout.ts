/**
 * The Gantt's own view logic — range, scale, ticks, rows and markers — kept pure and apart
 * from `TimelinePane` for the reason `backlogView.ts` and `board/chainArrows.ts` are: the
 * maths is what breaks, and it is the one half of a chart you can test without a browser.
 *
 * Coordinates are the pane's own content space, exactly like `chainArrows.ts`'s "board content
 * space" — an absolutely-positioned `<svg>` laid over a list of rows sharing one scroll
 * container, so a bar only has to be computed once and then it scrolls with the row it belongs
 * to. `GANTT_ROW_HEIGHT` is that space's row pitch, read by both the row list and the bars, the
 * same way `gitGraphView.ts`'s `ROW_HEIGHT` is.
 *
 * The scale is deliberately LINEAR ms→px — invertible in closed form, which is what makes
 * `msOf(xOf(t)) === t` provable rather than merely observed. Ticks are laid out by walking
 * **calendar days** (`Date#setDate`), never by adding a fixed millisecond step: a day that
 * DST shortens to 23 hours or lengthens to 25 must still be exactly one tick, and a month band
 * is the span BETWEEN two tick positions rather than `daysInMonth * a day's assumed width`, or
 * the header and the bars underneath it would drift apart across exactly the boundary a
 * calendar actually has.
 */
import type { Milestone, Task } from '@tm/shared/model';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Breathing room on each side of the dated tickets, in days. */
const PAD_DAYS = 3;
/** However narrow the dated tickets cluster, the range never draws shorter than this. */
const MIN_SPAN_DAYS = 14;
/** A bar always has SOME width, even a same-day ticket with nothing between its two dates. */
const MIN_BAR_WIDTH_PX = 4;

/** One row's height in px — the row list's CSS height and the bars' vertical pitch at once. */
export const GANTT_ROW_HEIGHT = 32;

export interface GanttRange {
  /** Epoch ms of the range's left edge. */
  start: number;
  /** Epoch ms of the range's right edge. */
  end: number;
}

/** A linear ms→px mapping over one {@link GanttRange}, and its exact inverse. */
export interface GanttScale {
  range: GanttRange;
  width: number;
  xOf(ms: number): number;
  msOf(x: number): number;
}

export interface GanttBar {
  x: number;
  width: number;
}

export interface GanttRow {
  id: string;
  ticket: Task;
  /** 0 — an epic or an epic-less ticket; 1 — a child under an EXPANDED epic. */
  depth: 0 | 1;
  /**
   * The bar to draw, or null for an undated ticket (→ the unscheduled tray). A collapsed
   * epic's row carries the UNION of its children's bars, not its own dates.
   */
  bar: GanttBar | null;
}

export interface GanttTick {
  ms: number;
  x: number;
  label: string;
  weekend: boolean;
}

/** One calendar month's header band, sized from where its OWN ticks actually landed. */
export interface GanttMonthBand {
  label: string;
  x: number;
  width: number;
}

export interface GanttTicks {
  days: GanttTick[];
  months: GanttMonthBand[];
}

export interface GanttMarker {
  milestoneId: string;
  x: number;
  label: string;
  /** How many other milestones already claimed this same day — 0 for the first. */
  stackIndex: number;
}

/** Midnight, in local time, of the day `ms` falls in. */
function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The window the timeline draws — every ticket's `startAt`/`dueAt` and every milestone's
 * `dueAt`, padded and floored to a minimum span.
 *
 * `now` is the fallback centre for a project with nothing dated at all, not merely a tie-
 * breaker: a fresh project's timeline still has to draw SOMETHING, and "today" is the only
 * instant that means anything with no ticket to anchor on.
 *
 * The floor is what keeps a project whose tickets all land on one day from drawing a bar a
 * pixel wide — `PAD_DAYS` alone would still leave a span far short of readable.
 */
export function ganttRange(
  tickets: readonly Task[],
  milestones: readonly Milestone[],
  now: number,
): GanttRange {
  const instants: number[] = [];
  for (const t of tickets) {
    if (t.startAt != null) instants.push(t.startAt);
    if (t.dueAt != null) instants.push(t.dueAt);
  }
  for (const m of milestones) {
    if (m.dueAt != null) instants.push(m.dueAt);
  }
  if (instants.length === 0) instants.push(now);

  const pad = PAD_DAYS * DAY_MS;
  let start = Math.min(...instants) - pad;
  let end = Math.max(...instants) + pad;

  const minSpan = MIN_SPAN_DAYS * DAY_MS;
  if (end - start < minSpan) {
    const mid = (start + end) / 2;
    start = mid - minSpan / 2;
    end = mid + minSpan / 2;
  }
  return { start, end };
}

/** A linear ms→px scale over `range`, exactly invertible — see the module header. */
export function ganttScale(range: GanttRange, width: number): GanttScale {
  const span = Math.max(1, range.end - range.start);
  return {
    range,
    width,
    xOf: (ms: number): number => ((ms - range.start) / span) * width,
    msOf: (x: number): number => range.start + (x / width) * span,
  };
}

/**
 * One tick per calendar day in `scale`'s range, plus the month bands they fall into.
 *
 * Walked with `Date#setDate` rather than `ms + DAY_MS`, and the bands sized from the ticks'
 * own `x` — see the module header for why either shortcut would desynchronise a bar from its
 * own header across a DST boundary.
 */
export function ganttTicks(scale: GanttScale): GanttTicks {
  const days: GanttTick[] = [];
  const months: GanttMonthBand[] = [];

  let cursor = startOfLocalDay(scale.range.start);
  let monthKey = '';
  let monthLabel = '';
  let monthStartX = 0;

  while (cursor.getTime() <= scale.range.end) {
    const ms = cursor.getTime();
    const x = scale.xOf(ms);
    const day = cursor.getDay();
    days.push({ ms, x, label: String(cursor.getDate()), weekend: day === 0 || day === 6 });

    const key = `${cursor.getFullYear()}-${cursor.getMonth()}`;
    if (key !== monthKey) {
      if (monthKey !== '')
        months.push({ label: monthLabel, x: monthStartX, width: x - monthStartX });
      monthKey = key;
      monthStartX = x;
      monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cursor = next;
  }
  if (monthKey !== '') {
    months.push({
      label: monthLabel,
      x: monthStartX,
      width: scale.xOf(scale.range.end) - monthStartX,
    });
  }

  return { days, months };
}

/** The `[start, end]` a ticket's bar spans, or null when neither date is set. */
function ticketSpan(ticket: Pick<Task, 'startAt' | 'dueAt'>): [number, number] | null {
  if (ticket.startAt == null && ticket.dueAt == null) return null;
  const s = ticket.startAt ?? ticket.dueAt!;
  const e = ticket.dueAt ?? ticket.startAt!;
  return s <= e ? [s, e] : [e, s];
}

/** A ticket's own bar, or null for an undated ticket — the caller sends those to the tray. */
export function ganttBar(
  ticket: Pick<Task, 'startAt' | 'dueAt'>,
  scale: GanttScale,
): GanttBar | null {
  const span = ticketSpan(ticket);
  if (!span) return null;
  const x1 = scale.xOf(span[0]);
  const x2 = scale.xOf(span[1]);
  return { x: x1, width: Math.max(MIN_BAR_WIDTH_PX, x2 - x1) };
}

/** The union of every dated child's span, as one bar — or null when none of them are dated. */
function unionBar(children: readonly Task[], scale: GanttScale): GanttBar | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const child of children) {
    const span = ticketSpan(child);
    if (!span) continue;
    min = min === null ? span[0] : Math.min(min, span[0]);
    max = max === null ? span[1] : Math.max(max, span[1]);
  }
  if (min === null || max === null) return null;
  const x1 = scale.xOf(min);
  const x2 = scale.xOf(max);
  return { x: x1, width: Math.max(MIN_BAR_WIDTH_PX, x2 - x1) };
}

/**
 * Every row the timeline draws, in the tickets' own order: each epic (one row, or, expanded,
 * one row plus a row per child), then every ticket with no resolvable epic.
 *
 * A collapsed epic's bar is the UNION of its children's — the whole point of collapsing being
 * "show me when this epic runs", not "show me when it happens to be dated itself" — falling
 * back to the epic ticket's own dates only when none of its children carry any.
 */
export function ganttRows(
  tickets: readonly Task[],
  scale: GanttScale,
  collapsedEpicIds: ReadonlySet<string>,
): GanttRow[] {
  const epicsById = new Map<string, Task>();
  for (const t of tickets) if (t.issueType === 'epic') epicsById.set(t.id, t);

  const childrenByEpic = new Map<string, Task[]>();
  for (const t of tickets) {
    if (t.issueType === 'epic') continue;
    const epicId = t.epicTaskId && epicsById.has(t.epicTaskId) ? t.epicTaskId : null;
    if (!epicId) continue;
    const list = childrenByEpic.get(epicId);
    if (list) list.push(t);
    else childrenByEpic.set(epicId, [t]);
  }

  const rows: GanttRow[] = [];
  for (const t of tickets) {
    if (t.issueType === 'epic') {
      const children = childrenByEpic.get(t.id) ?? [];
      const collapsed = collapsedEpicIds.has(t.id);
      rows.push({
        id: t.id,
        ticket: t,
        depth: 0,
        bar: collapsed ? (unionBar(children, scale) ?? ganttBar(t, scale)) : ganttBar(t, scale),
      });
      if (!collapsed) {
        for (const child of children) {
          rows.push({ id: child.id, ticket: child, depth: 1, bar: ganttBar(child, scale) });
        }
      }
      continue;
    }
    if (!t.epicTaskId || !epicsById.has(t.epicTaskId)) {
      rows.push({ id: t.id, ticket: t, depth: 0, bar: ganttBar(t, scale) });
    }
  }
  return rows;
}

/**
 * Every dated milestone as a vertical marker — one per calendar day it falls on, so two
 * milestones due the same day get the same `x` and are told apart by `stackIndex` instead of
 * landing on top of each other.
 */
export function ganttMarkers(milestones: readonly Milestone[], scale: GanttScale): GanttMarker[] {
  const dated = milestones.filter((m): m is Milestone & { dueAt: number } => m.dueAt != null);
  const sorted = [...dated].sort((a, b) => a.dueAt - b.dueAt);
  const stackByX = new Map<number, number>();
  return sorted.map((m) => {
    const x = scale.xOf(startOfLocalDay(m.dueAt).getTime());
    const stackIndex = stackByX.get(x) ?? 0;
    stackByX.set(x, stackIndex + 1);
    return { milestoneId: m.id, x, label: m.name, stackIndex };
  });
}

/** Today's `x`, or null while "today" falls outside the drawn range — never a clamped guess. */
export function todayX(scale: GanttScale, now: number): number | null {
  if (now < scale.range.start || now > scale.range.end) return null;
  return scale.xOf(now);
}

/**
 * The path from a "blocks" predecessor's bar to its successor's — same convention as
 * `board/chainArrows.ts`'s `arrowRoute`: horizontal at both ends, so the line always leaves
 * one bar's edge and lands square on the other's.
 *
 * The successor can start before the predecessor ends (an optimistic schedule, or a bar
 * dragged since); the curve still leaves the predecessor's right edge and arrives at the
 * successor's left, bowing forward rather than cutting back through the rows between them.
 */
export function ganttDependencyPath(
  from: { x: number; width: number; y: number },
  to: { x: number; y: number },
): string {
  const x1 = from.x + from.width;
  const y1 = from.y;
  const x2 = to.x;
  const y2 = to.y;
  const bow = Math.max(10, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x2 - bow} ${y2}, ${x2} ${y2}`;
}

/** The set a row's collapse toggle reads from — see `board/foldedSteps.ts`'s `foldedCardSet`. */
export function collapsedEpicSet(collapsed: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(collapsed ?? []);
}

/**
 * Add or remove one epic, and forget every epic that has left the board — the same operation
 * `board/foldedSteps.ts`'s `toggleFoldedCard` performs for a card's folded steps, and for the
 * same reason: without the prune, `AppSettings.gantt.collapsedEpicIds` would only ever grow.
 */
export function toggleCollapsedEpic(
  collapsed: readonly string[],
  epicId: string,
  epicIdsOnBoard: ReadonlySet<string>,
): string[] {
  const kept = collapsed.filter((id, i) => epicIdsOnBoard.has(id) && collapsed.indexOf(id) === i);
  const next = kept.filter((id) => id !== epicId);
  return collapsed.includes(epicId) ? next : [...next, epicId];
}
