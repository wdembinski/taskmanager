/**
 * Pure layout math for the Automations week calendar (F1.15) — no React, no DOM, so it is
 * unit-tested directly. Resolves a week's `schedule`-kind occurrences
 * (`@tm/shared/automationSchedule`'s `occurrencesBetween`) to grid cells, and the receipts
 * already recorded for them (`@tm/shared/automation`'s `AutomationRun`) to an outcome per
 * past cell.
 *
 * The viewer's own time zone (`viewTz`) and an automation's time zone
 * (`Automation.timeZone`) are two different things on purpose: an occurrence fires on the
 * automation's own clock, but it is *placed* on the grid by what day/hour that instant reads
 * as for whoever is looking at the calendar — which can be a different zone, or even a
 * different desktop over the web mirror. Everything here resolves wall time through
 * `Intl.DateTimeFormat`/`wallToUtc`, never the host's own local zone, for the same reason
 * `automationSchedule.ts` does.
 */
import type { Automation, AutomationRun, AutomationRunStatus } from '@tm/shared/automation';
import { occurrencesBetween, wallToUtc } from '@tm/shared/automationSchedule';

const DAY_MS = 24 * 60 * 60 * 1000;

interface WallDate {
  year: number;
  month: number;
  day: number;
}

interface WallDateTime extends WallDate {
  hour: number;
  minute: number;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = dateFormatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(tz, formatter);
  }
  return formatter;
}

function dateTimeFormatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateTimeFormatterCache.set(tz, formatter);
  }
  return formatter;
}

function partsOf(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  const byType: Record<string, string> = {};
  for (const part of parts) byType[part.type] = part.value;
  return byType;
}

/** `ms`'s wall-clock calendar date in `tz`. Throws `RangeError` for an unknown `tz`. */
function wallDateOf(ms: number, tz: string): WallDate {
  const p = partsOf(dateFormatterFor(tz).formatToParts(new Date(ms)));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** `ms`'s wall-clock date and hour/minute in `tz`. Throws `RangeError` for an unknown `tz`. */
function wallDateTimeOf(ms: number, tz: string): WallDateTime {
  const p = partsOf(dateTimeFormatterFor(tz).formatToParts(new Date(ms)));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** `date` shifted by `deltaDays` whole calendar days — pure date arithmetic, zone-independent. */
function addCalendarDays(date: WallDate, deltaDays: number): WallDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + deltaDays * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Whole calendar days from `from` to `to` — both pure dates, so this is exact regardless of
 *  what happens to the clock (DST) on any day in between. */
function calendarDaysBetween(from: WallDate, to: WallDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      DAY_MS,
  );
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a pure calendar date — zone-independent. */
function isoWeekdayOf(date: WallDate): number {
  const jsDay = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * The epoch ms instant of Monday 00:00, in `viewTz`, for the week containing `nowMs`.
 *
 * Found from `nowMs`'s wall-clock *date* in `viewTz` (not the instant itself) walked back to
 * that date's Monday, then resolved to a real UTC instant with `wallToUtc` — the same
 * wall-time-first discipline `automationSchedule.ts` uses throughout, so a Monday that lands
 * on a DST transition still resolves to the correct instant rather than an assumed offset.
 */
export function weekStartOf(nowMs: number, viewTz: string): number {
  const today = wallDateOf(nowMs, viewTz);
  const monday = addCalendarDays(today, -(isoWeekdayOf(today) - 1));
  return wallToUtc(monday.year, monday.month, monday.day, 0, 0, viewTz);
}

/**
 * The epoch ms instant of the *next* Monday 00:00 after `weekStartMs`, in `viewTz` — i.e. the
 * half-open week's exclusive end. Computed by wall-clock date, **not** `weekStartMs + 7 *
 * 24h`: a week spanning a DST transition is 167 or 169 real hours, and adding a fixed offset
 * would land on the wrong wall time (and, across a spring-forward gap, on a Monday at 01:00
 * or 23:00 instead of 00:00).
 */
function weekEndOf(weekStartMs: number, viewTz: string): number {
  const monday = addCalendarDays(wallDateOf(weekStartMs, viewTz), 7);
  return wallToUtc(monday.year, monday.month, monday.day, 0, 0, viewTz);
}

/** One of the week's 7 columns, Monday first. */
export interface DayColumn {
  /** Epoch ms of this day's midnight, in `viewTz`. */
  date: number;
  /** ISO weekday this column is — 1 = Monday … 7 = Sunday, matching `ScheduleShape.weekly.day`. */
  isoDay: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** One schedule occurrence placed on the grid. */
export interface CalendarCell {
  automationId: string;
  name: string;
  /** The occurrence's own UTC instant. */
  at: number;
  /** 0 = Monday … 6 = Sunday, in `viewTz`. */
  day: number;
  /** 0–23, in `viewTz`. */
  hour: number;
  past: boolean;
  /** The matching run's status, `'missed'` when past with no receipt at all, or `null` for a
   *  future occurrence — see {@link outcomeTone}. */
  outcome: AutomationRunStatus | 'missed' | null;
  /** Disabled automations are still drawn (rendered muted), never dropped from the grid. */
  enabled: boolean;
}

export interface WeekLayout {
  /** Always exactly 7 entries, Monday through Sunday. */
  days: DayColumn[];
  cells: CalendarCell[];
  /** Tracker-triggered automations — they have no clock, so they sit beside the grid instead. */
  trackerStrip: Automation[];
}

/** The `AutomationRun.occurrenceKey` the clock writes for a schedule firing at `at`. */
function scheduleOccurrenceKey(at: number): string {
  return `schedule:${new Date(at).toISOString()}`;
}

/** Where an instant falls on a grid anchored at `weekStartMs`, in `viewTz` — day `0` =
 *  Monday (the same day a week starting at `weekStartMs` starts on) through `6` = Sunday,
 *  with `hour`/`minute` its wall clock within that day. `day` outside `[0, 6]` means `ms` is
 *  not actually in that week — the caller's cue to hide a "now" line rather than draw one off
 *  the grid. Used both to place an occurrence (`layoutWeek`) and to place "now" (`WeekCalendar`'s
 *  current-hour line), so the two agree pixel-for-pixel by construction. */
export function gridPositionOf(
  ms: number,
  weekStartMs: number,
  viewTz: string,
): { day: number; hour: number; minute: number } {
  const placed = wallDateTimeOf(ms, viewTz);
  const day = calendarDaysBetween(wallDateOf(weekStartMs, viewTz), placed);
  return { day, hour: placed.hour, minute: placed.minute };
}

export interface LayoutWeekInput {
  automations: Automation[];
  runs: AutomationRun[];
  weekStartMs: number;
  nowMs: number;
  viewTz: string;
}

/**
 * Lays out one week of the Automations calendar: every `schedule`-kind automation's
 * occurrences in `[weekStartMs, weekEndOf(weekStartMs, viewTz))`, placed by wall-clock day and
 * hour **in `viewTz`** regardless of the automation's own `timeZone`, each paired with its
 * recorded outcome if the occurrence is in the past. `tracker`-kind automations have no
 * occurrences to place and go to `trackerStrip` instead; disabled automations of either kind
 * are still included (`enabled: false`), never filtered out of the layout.
 *
 * An automation with an unresolvable time zone (should not happen past `validateAutomation`,
 * but the clock's own `evaluate()` guards the same way) is skipped rather than failing the
 * whole week, so one bad automation cannot blank the calendar for every other one.
 */
export function layoutWeek(input: LayoutWeekInput): WeekLayout {
  const { automations, runs, weekStartMs, nowMs, viewTz } = input;
  const weekEndMs = weekEndOf(weekStartMs, viewTz);
  const weekStartDate = wallDateOf(weekStartMs, viewTz);

  const days: DayColumn[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addCalendarDays(weekStartDate, i);
    days.push({
      date: wallToUtc(date.year, date.month, date.day, 0, 0, viewTz),
      isoDay: (i + 1) as DayColumn['isoDay'],
    });
  }

  const runByOccurrenceKey = new Map<string, AutomationRun>();
  for (const run of runs) runByOccurrenceKey.set(run.occurrenceKey, run);

  const cells: CalendarCell[] = [];
  const trackerStrip: Automation[] = [];

  for (const automation of automations) {
    if (automation.trigger.kind !== 'schedule') {
      trackerStrip.push(automation);
      continue;
    }

    let occurrences: number[];
    try {
      occurrences = occurrencesBetween(
        automation.trigger.schedule,
        weekStartMs,
        weekEndMs,
        automation.timeZone,
      );
    } catch {
      continue;
    }

    for (const at of occurrences) {
      const { day, hour } = gridPositionOf(at, weekStartMs, viewTz);
      const past = at <= nowMs;
      const run = past ? runByOccurrenceKey.get(scheduleOccurrenceKey(at)) : undefined;

      cells.push({
        automationId: automation.id,
        name: automation.name,
        at,
        day,
        hour,
        past,
        outcome: !past ? null : run ? run.status : 'missed',
        enabled: automation.enabled,
      });
    }
  }

  return { days, cells, trackerStrip };
}

/** A Fluent tone name, not a literal colour — the single place a run's outcome is mapped to
 *  the app's colour budget (memory: *board-colour-budget*), so the mapping is tested once
 *  here instead of copied into every surface that draws an outcome chip. */
export type OutcomeTone = 'brand' | 'warning' | 'danger' | 'neutral';

/**
 * The tone for one outcome: `'started'`/`'reserved'` are a firing under way (`'brand'`, the
 * same "in motion" tone running/in-progress cards get); `'parked'` is waiting behind a gate
 * that resolves itself and `'missed'` is a gap nothing has explained yet, both `'warning'`;
 * `'refused'`/`'error'` are the two outcomes that count toward auto-disable, `'danger'`;
 * `'skipped'`/`'duplicate'` are benign no-ops and a future occurrence (`null`) has not
 * happened yet — none of those are worth a colour, so all three are `'neutral'`.
 */
export function outcomeTone(outcome: AutomationRunStatus | 'missed' | null): OutcomeTone {
  switch (outcome) {
    case 'started':
    case 'reserved':
      return 'brand';
    case 'parked':
    case 'missed':
      return 'warning';
    case 'refused':
    case 'error':
      return 'danger';
    case 'skipped':
    case 'duplicate':
    case null:
      return 'neutral';
  }
}
