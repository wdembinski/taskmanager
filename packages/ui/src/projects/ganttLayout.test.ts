import { describe, expect, it } from 'vitest';
import type { Milestone, Task } from '@tm/shared/model';
import {
  DAY_MS,
  GANTT_ROW_HEIGHT,
  clampSpan,
  collapsedEpicSet,
  ganttBar,
  ganttDependencyPath,
  ganttMarkers,
  ganttRange,
  ganttRows,
  ganttScale,
  ganttTicks,
  rescheduleTo,
  snapToDay,
  toggleCollapsedEpic,
  todayX,
} from './ganttLayout';

let seq = 0;
/** A minimal native-ticket fixture — only the fields this module reads are worth naming. */
function ticket(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    projectId: 'proj',
    phase: '',
    title: 'Untitled',
    status: 'pending',
    sessionId: null,
    order: 0,
    dependsOn: [],
    source: 'ticket',
    isContract: false,
    isScaffold: false,
    ...overrides,
  };
}

let mseq = 0;
function milestone(overrides: Partial<Milestone> = {}): Milestone {
  mseq += 1;
  return {
    id: `m${mseq}`,
    projectId: 'proj',
    name: 'Milestone',
    description: '',
    dueAt: null,
    color: '',
    closed: false,
    createdAt: 0,
    ...overrides,
  };
}

describe('ganttRange', () => {
  it('spans every ticket and milestone date, padded on each side', () => {
    const tickets = [ticket({ startAt: 10 * DAY_MS, dueAt: 20 * DAY_MS })];
    const milestones = [milestone({ dueAt: 30 * DAY_MS })];
    const range = ganttRange(tickets, milestones, 0);
    expect(range.start).toBeLessThan(10 * DAY_MS);
    expect(range.end).toBeGreaterThan(30 * DAY_MS);
  });

  it('floors the span so a project whose tickets all land on one day still draws', () => {
    const tickets = [ticket({ startAt: 5 * DAY_MS, dueAt: 5 * DAY_MS })];
    const range = ganttRange(tickets, [], 0);
    // 14-day floor from the module — asserted as a literal, the way `foldedSteps.test.ts`
    // asserts its own list shapes as literals rather than importing the constant.
    expect(range.end - range.start).toBe(14 * DAY_MS);
  });

  it('centres on `now` when nothing at all is dated', () => {
    const now = 100 * DAY_MS;
    const range = ganttRange([], [], now);
    expect(range.start).toBeLessThanOrEqual(now);
    expect(range.end).toBeGreaterThanOrEqual(now);
  });

  it('ignores undated tickets and milestones', () => {
    const tickets = [ticket({ startAt: null, dueAt: null })];
    const range = ganttRange(tickets, [milestone({ dueAt: null })], 50 * DAY_MS);
    expect(range.start).toBeLessThanOrEqual(50 * DAY_MS);
    expect(range.end).toBeGreaterThanOrEqual(50 * DAY_MS);
  });
});

describe('ganttScale', () => {
  it('is exactly invertible — msOf(xOf(t)) === t for sampled instants', () => {
    const range = { start: 0, end: 100 * DAY_MS };
    const scale = ganttScale(range, 1000);
    for (const t of [0, 1, DAY_MS, 37 * DAY_MS, 99.5 * DAY_MS, 100 * DAY_MS]) {
      expect(scale.msOf(scale.xOf(t))).toBeCloseTo(t, 6);
    }
  });

  it('maps the range edges onto the pixel edges', () => {
    const range = { start: 1000, end: 2000 };
    const scale = ganttScale(range, 500);
    expect(scale.xOf(1000)).toBe(0);
    expect(scale.xOf(2000)).toBe(500);
  });

  it('never divides by zero for a degenerate (zero-width) range', () => {
    const scale = ganttScale({ start: 5000, end: 5000 }, 200);
    expect(Number.isFinite(scale.xOf(5000))).toBe(true);
  });
});

describe('ganttTicks', () => {
  it('lays down one tick per calendar day across a 31-day month', () => {
    // A whole August, one calendar day per tick regardless of the timezone the suite runs in.
    const start = new Date(2026, 7, 1).getTime();
    const end = new Date(2026, 7, 31).getTime();
    const scale = ganttScale({ start, end }, 3100);
    const ticks = ganttTicks(scale);
    expect(ticks.days).toHaveLength(31);
  });

  it('derives the month band from where its own ticks land, not from a day count', () => {
    const start = new Date(2026, 7, 1).getTime();
    const end = new Date(2026, 8, 5).getTime();
    const scale = ganttScale({ start, end }, 3600);
    const { days, months } = ganttTicks(scale);
    const august = months.find((m) => m.label.startsWith('August'));
    const septFirstTick = days.find((d) => new Date(d.ms).getMonth() === 8);
    expect(august).toBeDefined();
    expect(septFirstTick).toBeDefined();
    // The band's right edge is exactly where September's first tick sits — derived from tick
    // positions, so a 23-/25-hour day inside the month could never pull the two apart.
    expect(august!.x + august!.width).toBeCloseTo(septFirstTick!.x, 6);
  });

  it('does not miscount calendar days across a DST boundary', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2026-03-08 is the US spring-forward date: a 23-hour local day sits inside this range.
      const start = new Date(2026, 2, 1).getTime();
      const end = new Date(2026, 2, 15).getTime();
      const scale = ganttScale({ start, end }, 1400);
      const ticks = ganttTicks(scale);
      // March 1 through March 15 inclusive — the calendar-day count, unmoved by the missing hour.
      expect(ticks.days).toHaveLength(15);
    } finally {
      process.env.TZ = originalTz;
    }
  });
});

describe('ganttBar', () => {
  const scale = ganttScale({ start: 0, end: 100 * DAY_MS }, 1000);

  it('returns null for an undated ticket', () => {
    expect(ganttBar(ticket({ startAt: null, dueAt: null }), scale)).toBeNull();
  });

  it('spans from startAt to dueAt', () => {
    const bar = ganttBar(ticket({ startAt: 10 * DAY_MS, dueAt: 20 * DAY_MS }), scale);
    expect(bar).not.toBeNull();
    expect(bar!.x).toBeCloseTo(scale.xOf(10 * DAY_MS), 6);
    expect(bar!.width).toBeGreaterThan(0);
  });

  it('draws a minimum-width bar for a ticket dated on a single instant', () => {
    const bar = ganttBar(ticket({ startAt: 10 * DAY_MS, dueAt: 10 * DAY_MS }), scale);
    expect(bar!.width).toBeGreaterThan(0);
  });

  it('uses whichever single date is set when the other is null', () => {
    const bar = ganttBar(ticket({ startAt: 10 * DAY_MS, dueAt: null }), scale);
    expect(bar).not.toBeNull();
    expect(bar!.x).toBeCloseTo(scale.xOf(10 * DAY_MS), 6);
  });
});

describe('ganttRows', () => {
  const scale = ganttScale({ start: 0, end: 100 * DAY_MS }, 1000);

  it('gives an expanded epic one row plus one per child', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic' });
    const c1 = ticket({ epicTaskId: 'e1', startAt: 10 * DAY_MS, dueAt: 12 * DAY_MS });
    const c2 = ticket({ epicTaskId: 'e1', startAt: 15 * DAY_MS, dueAt: 18 * DAY_MS });
    const rows = ganttRows([epic, c1, c2], scale, new Set());
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it('collapses an epic to one row whose bar unions its children', () => {
    const epic = ticket({ id: 'e1', issueType: 'epic', title: 'Epic' });
    const c1 = ticket({ epicTaskId: 'e1', startAt: 10 * DAY_MS, dueAt: 12 * DAY_MS });
    const c2 = ticket({ epicTaskId: 'e1', startAt: 15 * DAY_MS, dueAt: 18 * DAY_MS });
    const rows = ganttRows([epic, c1, c2], scale, new Set(['e1']));
    expect(rows).toHaveLength(1);
    expect(rows[0].bar!.x).toBeCloseTo(scale.xOf(10 * DAY_MS), 6);
    const rightEdge = rows[0].bar!.x + rows[0].bar!.width;
    expect(rightEdge).toBeCloseTo(scale.xOf(18 * DAY_MS), 6);
  });

  it('gives an epic-less ticket its own top-level row', () => {
    const orphan = ticket({ startAt: 1 * DAY_MS, dueAt: 2 * DAY_MS });
    const rows = ganttRows([orphan], scale, new Set());
    expect(rows).toEqual([{ id: orphan.id, ticket: orphan, depth: 0, bar: rows[0].bar }]);
  });

  it('carries a null bar through to the row for an undated ticket', () => {
    const orphan = ticket({ startAt: null, dueAt: null });
    const rows = ganttRows([orphan], scale, new Set());
    expect(rows[0].bar).toBeNull();
  });
});

describe('ganttMarkers', () => {
  const scale = ganttScale({ start: 0, end: 100 * DAY_MS }, 1000);

  it("places a marker at its milestone's day", () => {
    const m = milestone({ dueAt: 10 * DAY_MS + 3600_000 });
    const markers = ganttMarkers([m], scale);
    expect(markers).toHaveLength(1);
    expect(markers[0].stackIndex).toBe(0);
  });

  it('stacks two milestones due the same day instead of overprinting them', () => {
    const a = milestone({ dueAt: 10 * DAY_MS + 1000 });
    const b = milestone({ dueAt: 10 * DAY_MS + 2 * 3600_000 });
    const markers = ganttMarkers([a, b], scale);
    expect(markers).toHaveLength(2);
    expect(markers[0].x).toBe(markers[1].x);
    expect(new Set(markers.map((m) => m.stackIndex))).toEqual(new Set([0, 1]));
  });

  it('skips a milestone with no due date', () => {
    const markers = ganttMarkers([milestone({ dueAt: null })], scale);
    expect(markers).toHaveLength(0);
  });
});

describe('todayX', () => {
  const scale = ganttScale({ start: 0, end: 100 * DAY_MS }, 1000);

  it('returns the x for a now inside the range', () => {
    expect(todayX(scale, 50 * DAY_MS)).toBeCloseTo(scale.xOf(50 * DAY_MS), 6);
  });

  it('returns null for a now outside the range, rather than a clamped x', () => {
    expect(todayX(scale, -1 * DAY_MS)).toBeNull();
    expect(todayX(scale, 200 * DAY_MS)).toBeNull();
  });
});

describe('ganttDependencyPath', () => {
  it("starts at the predecessor's right edge and ends at the successor's left", () => {
    const d = ganttDependencyPath({ x: 10, width: 20, y: 5 }, { x: 80, y: 45 });
    expect(d.startsWith('M 30 5')).toBe(true);
    expect(d.endsWith('80 45')).toBe(true);
  });
});

describe('collapsedEpicSet / toggleCollapsedEpic', () => {
  it('folds an epic that was open', () => {
    expect(toggleCollapsedEpic([], 'e1', new Set(['e1']))).toEqual(['e1']);
  });

  it('unfolds an epic that was collapsed', () => {
    expect(toggleCollapsedEpic(['e1'], 'e1', new Set(['e1']))).toEqual([]);
  });

  it('drops epics that have left the board on write', () => {
    expect(toggleCollapsedEpic(['gone', 'e1'], 'e2', new Set(['e1', 'e2']))).toEqual(['e1', 'e2']);
  });

  it('reads back into a set', () => {
    const set = collapsedEpicSet(['e1']);
    expect(set.has('e1')).toBe(true);
    expect(set.has('e2')).toBe(false);
  });

  it('is empty when nothing has been saved yet', () => {
    expect(collapsedEpicSet(undefined).size).toBe(0);
  });
});

describe('GANTT_ROW_HEIGHT', () => {
  it('is a positive constant the drawing and the rows can share', () => {
    expect(GANTT_ROW_HEIGHT).toBeGreaterThan(0);
  });
});

describe('snapToDay', () => {
  it('snaps to the local midnight boundary, not the UTC one', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const localMidnight = new Date(2026, 2, 10).getTime();
      const twoHoursIn = localMidnight + 2 * 60 * 60 * 1000;
      // A UTC-boundary snap (`Math.round(ms / DAY_MS) * DAY_MS`) would land five hours off
      // local midnight here — this only passes for an implementation that snaps LOCALLY.
      expect(snapToDay(twoHoursIn)).toBe(localMidnight);
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('rounds to whichever of the two neighbouring local midnights is closer', () => {
    const day = new Date(2026, 0, 5).getTime();
    const nextDay = new Date(2026, 0, 6).getTime();
    expect(snapToDay(day + 1000)).toBe(day);
    expect(snapToDay(nextDay - 1000)).toBe(nextDay);
  });
});

describe('clampSpan', () => {
  it('clamps the left edge to the minimum span when dragged past the right edge', () => {
    const end = 10 * DAY_MS;
    const [s, e] = clampSpan(50 * DAY_MS, end, 'start');
    expect(e).toBe(end);
    expect(e - s).toBe(DAY_MS);
  });

  it('clamps the right edge to the minimum span when dragged past the left edge', () => {
    const start = 10 * DAY_MS;
    const [s, e] = clampSpan(start, -5 * DAY_MS, 'end');
    expect(s).toBe(start);
    expect(e - s).toBe(DAY_MS);
  });

  it('leaves a span alone once it is already at or above the minimum', () => {
    expect(clampSpan(0, 5 * DAY_MS, 'start')).toEqual([0, 5 * DAY_MS]);
  });
});

describe('rescheduleTo', () => {
  it('returns null for an undated ticket rather than inventing a start', () => {
    expect(rescheduleTo({ startAt: null, dueAt: null }, DAY_MS, 'move')).toBeNull();
    expect(rescheduleTo({ startAt: null, dueAt: 5 * DAY_MS }, DAY_MS, 'move')).toBeNull();
    expect(rescheduleTo({ startAt: 5 * DAY_MS, dueAt: null }, DAY_MS, 'move')).toBeNull();
  });

  it('shifts both dates by the same whole number of days on a move', () => {
    const startAt = new Date(2026, 5, 10).getTime();
    const dueAt = new Date(2026, 5, 15).getTime();
    const result = rescheduleTo({ startAt, dueAt }, 3 * DAY_MS + 1000, 'move');
    expect(result).toEqual({
      startAt: new Date(2026, 5, 13).getTime(),
      dueAt: new Date(2026, 5, 18).getTime(),
    });
  });

  it('moves exactly one day for a single-day keyboard nudge', () => {
    const startAt = new Date(2026, 5, 10).getTime();
    const dueAt = new Date(2026, 5, 12).getTime();
    const result = rescheduleTo({ startAt, dueAt }, DAY_MS, 'move');
    expect(result).toEqual({
      startAt: new Date(2026, 5, 11).getTime(),
      dueAt: new Date(2026, 5, 13).getTime(),
    });
  });

  it('preserves a bar’s day-duration exactly when a move crosses a DST boundary', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2026-03-08 is the US spring-forward date. A 5-day ticket entirely before it, dragged
      // 10 days forward, lands entirely after it — the raw ms between the new dates is one
      // hour short of 5 * DAY_MS, but the CALENDAR-day span a human reads must still be 5.
      const startAt = new Date(2026, 2, 1).getTime();
      const dueAt = new Date(2026, 2, 6).getTime();
      const result = rescheduleTo({ startAt, dueAt }, 10 * DAY_MS, 'move');
      expect(result).toEqual({
        startAt: new Date(2026, 2, 11).getTime(),
        dueAt: new Date(2026, 2, 16).getTime(),
      });
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('returns the unchanged pair when a move would invert an already-inverted ticket', () => {
    const startAt = 20 * DAY_MS;
    const dueAt = 10 * DAY_MS;
    const result = rescheduleTo({ startAt, dueAt }, DAY_MS, 'move');
    expect(result).toEqual({ startAt, dueAt });
  });

  it('clamps to the minimum span, rather than inverting, when the start edge is dragged past the due edge', () => {
    const startAt = 10 * DAY_MS;
    const dueAt = 15 * DAY_MS;
    const result = rescheduleTo({ startAt, dueAt }, 20 * DAY_MS, 'start');
    expect(result).not.toBeNull();
    expect(result!.dueAt).toBe(dueAt);
    expect(result!.dueAt - result!.startAt).toBe(DAY_MS);
  });

  it('clamps to the minimum span, rather than inverting, when the due edge is dragged past the start edge', () => {
    const startAt = 10 * DAY_MS;
    const dueAt = 15 * DAY_MS;
    const result = rescheduleTo({ startAt, dueAt }, -20 * DAY_MS, 'end');
    expect(result).not.toBeNull();
    expect(result!.startAt).toBe(startAt);
    expect(result!.dueAt - result!.startAt).toBe(DAY_MS);
  });
});
