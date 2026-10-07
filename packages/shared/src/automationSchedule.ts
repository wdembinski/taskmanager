/**
 * Pure schedule occurrence math (F1.2): resolves a `ScheduleShape` (`./automation`), a
 * wall-clock schedule in an automation's own IANA time zone, to UTC instants. See
 * `docs/plan/feature-roadmap/F1-automation-triggers.md` for the full design — this file is
 * `nextOccurrence`/`occurrencesBetween` (what the clock and the week calendar query) and
 * `scheduleLabel`/`cronOf` (display only). The catch-up age rule that turns a late
 * occurrence into `scheduled`/`catch-up`/`skip` is `automationFire.ts`, a later task on the
 * same plan.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Weekday numbering is ISO.** `weekly.day`: 1 = Monday … 7 = Sunday. Computed from the
 *   *local calendar date* via `new Date(Date.UTC(y, m - 1, d)).getUTCDay()` (remapped from
 *   JS's native 0 = Sunday). That is pure calendar arithmetic and does not depend on the
 *   zone — only the wall-clock date does.
 * - **`hours` is aligned to wall-clock time, not elapsed time.** `{ type: 'hours', every: N
 *   }` fires at local `HH:00` where `HH % N === 0` — `00:00, 06:00, 12:00, 18:00` for `N =
 *   6` — never "N hours after whenever the automation happened to be enabled". This matches
 *   `cronOf`'s `0 * /N * * *` rendering and gives the week calendar UI stable cells.
 * - **Wall time → UTC** goes through a cached-per-zone `Intl.DateTimeFormat('en-US', {
 *   timeZone, hourCycle: 'h23', year, month, day, hour, minute, second })` and
 *   `formatToParts` — never the platform's local-zone `Date` constructor, which only knows
 *   the *host's* zone, not the automation's.
 *   - `offsetAt(ms, tz)` reads that zone's wall-clock parts at `ms` and returns
 *     `Date.UTC(<those parts>) - ms`: the zone's UTC offset, in ms, at that instant.
 *   - `wallToUtc(y, mo, d, h, mi, tz)` guesses a UTC instant `W = Date.UTC(y, mo - 1, d, h,
 *     mi)` and refines it, because the offset *at* `W` is exactly what's ambiguous near a
 *     DST transition: the candidates are `W - offsetAt(W - 1 day, tz)` and `W - offsetAt(W +
 *     1 day, tz)`. Keep whichever candidate's local parts (read back through the same
 *     formatter) round-trip to the same wall time.
 *     - **One or two candidates valid** → return the **earliest** (fall-back: the wall time
 *       occurs twice; by convention it fires once, at the first).
 *     - **None valid** (spring-forward gap) → return the **transition instant** itself, the
 *       first instant after the gap, found by a binary search between the two candidates for
 *       the first `ms` whose offset equals the post-gap offset. (Warsaw 2026-03-29 02:30 CET
 *       does not exist; the automation fires at 03:00 CEST = 01:00 UTC.)
 * - **`nextOccurrence(shape, afterMs, tz)`** is the first occurrence **strictly after**
 *   `afterMs`. It takes the local calendar date of `afterMs` and walks dates from one day
 *   before to eight days after — wide enough that a weekly schedule and a DST shift both
 *   always land inside the window. For each date it lists the shape's wall times (`daily` /
 *   `weekdays` → one; `weekly` → one, only if the date's ISO weekday matches; `hours` → `24 /
 *   every`), resolves each with `wallToUtc`, and returns the first one greater than
 *   `afterMs`.
 * - **`occurrencesBetween(shape, fromMs, toMs, tz)`** is the half-open range `[fromMs,
 *   toMs)`, built by looping `t = nextOccurrence(shape, t, tz)` starting one instant before
 *   `fromMs`. The result is strictly increasing, so a gap-collapsed duplicate (an hourly
 *   schedule's 02:00 and 03:00 both resolving to the same instant across a fall-back)
 *   appears once, not twice. Hard-capped at 10,000 results as a safety net against a
 *   pathological shape looping forever.
 * - **`scheduleLabel(shape)`** renders `"daily at 04:00"`, `"weekdays at 04:00"`, `"every
 *   Sunday at 04:00"`, `"every hour"` / `"every 6 hours"`. The time zone is deliberately
 *   *not* included — the list UI appends `" · <tz>"` itself (plan doc, UI section).
 * - **`cronOf(shape)`** is display-only, never parsed back: `m h * * *` (daily), `m h * *
 *   1-5` (weekdays), `m h * * D` (weekly — cron's Sunday is `0`, so ISO day `7` maps to `0`
 *   and every other day is unchanged), `0 * * * *` / `0 * /N * * *` (hours).
 * - **An unknown IANA zone throws.** `new Intl.DateTimeFormat(..., { timeZone })` raises a
 *   `RangeError` for a zone it does not recognise, and every function here lets that
 *   propagate rather than catching it — `validateAutomation` (`./automation`) is the one
 *   place a bad zone is meant to be caught, before an automation is ever saved.
 */
import type { ScheduleShape } from './automation';

const DAY_MS = 24 * 60 * 60 * 1000;

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(tz);
  if (!formatter) {
    // Throws RangeError for an unknown zone — the one validation point every exported
    // function here relies on; see the module header.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, formatter);
  }
  return formatter;
}

function wallPartsAt(ms: number, tz: string): WallParts {
  const parts = getFormatter(tz).formatToParts(new Date(ms));
  const byType: Record<string, string> = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

/**
 * This zone's UTC offset, in ms, at `ms` — i.e. `Date.UTC(<ms>'s wall-clock parts in `tz`) -
 * ms`. Backed by a per-zone-cached `Intl.DateTimeFormat`; see the module header for why this
 * (not the platform's local-zone `Date`) is the only correct way to read a non-host zone.
 * Throws `RangeError` for an unknown `tz` — see the module header.
 */
export function offsetAt(ms: number, tz: string): number {
  // `formatToParts` has only whole-second resolution, so it reads the same wall-clock
  // parts for every `ms` within a second. Floor to that second before subtracting, or a
  // sub-second `ms` (as a binary search midpoint produces) would compare against a `second`
  // field that silently dropped its own fractional part, drifting the result by up to 999ms.
  const flooredMs = Math.floor(ms / 1000) * 1000;
  const p = wallPartsAt(flooredMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - flooredMs;
}

/**
 * The UTC instant for the wall-clock date/time `year`-`month`-`day` `hour`:`minute` in
 * `tz`, resolving DST ambiguity per the module header: the earliest of one or two valid
 * candidates, or the post-gap transition instant when the wall time does not exist. `month`
 * and `day` are 1-based (so `month: 3` is March). Throws `RangeError` for an unknown `tz`.
 */
export function wallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const preOffset = offsetAt(guess - DAY_MS, tz);
  const postOffset = offsetAt(guess + DAY_MS, tz);

  const candidates = Array.from(new Set([guess - preOffset, guess - postOffset])).sort(
    (a, b) => a - b,
  );

  const matchesWallTime = (ms: number): boolean => {
    const p = wallPartsAt(ms, tz);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    );
  };

  const valid = candidates.filter(matchesWallTime);
  if (valid.length > 0) {
    return Math.min(...valid);
  }

  // Spring-forward gap: this wall time never happens. Binary search between the two
  // candidates for the first instant whose offset is the post-gap one — the transition
  // instant itself.
  let lo = candidates[0];
  let hi = candidates[candidates.length - 1];
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(mid, tz) === preOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

function isoWeekdayOf(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** The wall-clock hour/minute pairs `shape` fires at on a date whose ISO weekday is `isoDay`. */
function wallTimesFor(
  shape: ScheduleShape,
  isoDay: number,
): Array<{ hour: number; minute: number }> {
  switch (shape.type) {
    case 'daily':
      return [{ hour: shape.hour, minute: shape.minute }];
    case 'weekdays':
      return isoDay >= 1 && isoDay <= 5 ? [{ hour: shape.hour, minute: shape.minute }] : [];
    case 'weekly':
      return isoDay === shape.day ? [{ hour: shape.hour, minute: shape.minute }] : [];
    case 'hours': {
      const count = 24 / shape.every;
      return Array.from({ length: count }, (_, i) => ({ hour: i * shape.every, minute: 0 }));
    }
  }
}

/**
 * The first occurrence of `shape` strictly after `afterMs`, resolved in `tz`. See the
 * module header for the walk-the-calendar-dates algorithm. Throws `RangeError` for an
 * unknown `tz`.
 */
export function nextOccurrence(shape: ScheduleShape, afterMs: number, tz: string): number {
  const base = wallPartsAt(afterMs, tz);
  const baseDate = new Date(Date.UTC(base.year, base.month - 1, base.day));

  for (let dayOffset = -1; dayOffset <= 8; dayOffset++) {
    const d = new Date(baseDate.getTime() + dayOffset * DAY_MS);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const isoDay = isoWeekdayOf(year, month, day);

    for (const { hour, minute } of wallTimesFor(shape, isoDay)) {
      const instant = wallToUtc(year, month, day, hour, minute, tz);
      if (instant > afterMs) {
        return instant;
      }
    }
  }

  throw new Error(
    `nextOccurrence found no occurrence within the search window: shape=${JSON.stringify(shape)}, afterMs=${afterMs}, tz=${tz}`,
  );
}

const OCCURRENCES_BETWEEN_CAP = 10_000;

/**
 * Every occurrence of `shape` in the half-open range `[fromMs, toMs)`, resolved in `tz`:
 * strictly increasing, de-duplicated across DST fall-back, capped at 10,000. See the module
 * header. Throws `RangeError` for an unknown `tz`.
 */
export function occurrencesBetween(
  shape: ScheduleShape,
  fromMs: number,
  toMs: number,
  tz: string,
): number[] {
  const result: number[] = [];
  let t = fromMs - 1;
  while (result.length < OCCURRENCES_BETWEEN_CAP) {
    const next = nextOccurrence(shape, t, tz);
    if (next >= toMs) {
      break;
    }
    result.push(next);
    t = next;
  }
  return result;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmm(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/**
 * A human-readable trigger label for `shape`, time-zone-free — the caller appends
 * `" · <tz>"` (plan doc, UI section). See the module header for the exact wording per shape.
 */
export function scheduleLabel(shape: ScheduleShape): string {
  switch (shape.type) {
    case 'daily':
      return `daily at ${hhmm(shape.hour, shape.minute)}`;
    case 'weekdays':
      return `weekdays at ${hhmm(shape.hour, shape.minute)}`;
    case 'weekly':
      return `every ${WEEKDAY_NAMES[shape.day - 1]} at ${hhmm(shape.hour, shape.minute)}`;
    case 'hours':
      return shape.every === 1 ? 'every hour' : `every ${shape.every} hours`;
  }
}

/**
 * Display-only cron rendering of `shape` — never parsed back into a `ScheduleShape`. See
 * the module header for the exact mapping per shape, including the cron-Sunday remap.
 */
export function cronOf(shape: ScheduleShape): string {
  switch (shape.type) {
    case 'daily':
      return `${shape.minute} ${shape.hour} * * *`;
    case 'weekdays':
      return `${shape.minute} ${shape.hour} * * 1-5`;
    case 'weekly': {
      const cronDay = shape.day === 7 ? 0 : shape.day;
      return `${shape.minute} ${shape.hour} * * ${cronDay}`;
    }
    case 'hours':
      return shape.every === 1 ? '0 * * * *' : `0 */${shape.every} * * *`;
  }
}
