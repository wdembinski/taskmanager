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
 *   `cronOf`'s `0 */N * * *` rendering and gives the week calendar UI stable cells.
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
 *   and every other day is unchanged), `0 * * * *` / `0 */N * * *` (hours).
 * - **An unknown IANA zone throws.** `new Intl.DateTimeFormat(..., { timeZone })` raises a
 *   `RangeError` for a zone it does not recognise, and every function here lets that
 *   propagate rather than catching it — `validateAutomation` (`./automation`) is the one
 *   place a bad zone is meant to be caught, before an automation is ever saved.
 */
import type { ScheduleShape } from './automation';

/**
 * This zone's UTC offset, in ms, at `ms` — i.e. `Date.UTC(<ms>'s wall-clock parts in `tz`) -
 * ms`. Backed by a per-zone-cached `Intl.DateTimeFormat`; see the module header for why this
 * (not the platform's local-zone `Date`) is the only correct way to read a non-host zone.
 * Throws `RangeError` for an unknown `tz` — see the module header.
 */
export function offsetAt(ms: number, tz: string): number {
  throw new Error(`offsetAt is not implemented yet (F1.2): ms=${ms}, tz=${tz}`);
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
  throw new Error(
    `wallToUtc is not implemented yet (F1.2): ${year}-${month}-${day} ${hour}:${minute} ${tz}`,
  );
}

/**
 * The first occurrence of `shape` strictly after `afterMs`, resolved in `tz`. See the
 * module header for the walk-the-calendar-dates algorithm. Throws `RangeError` for an
 * unknown `tz`.
 */
export function nextOccurrence(shape: ScheduleShape, afterMs: number, tz: string): number {
  throw new Error(
    `nextOccurrence is not implemented yet (F1.2): shape=${JSON.stringify(shape)}, ` +
      `afterMs=${afterMs}, tz=${tz}`,
  );
}

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
  throw new Error(
    `occurrencesBetween is not implemented yet (F1.2): shape=${JSON.stringify(shape)}, ` +
      `fromMs=${fromMs}, toMs=${toMs}, tz=${tz}`,
  );
}

/**
 * A human-readable trigger label for `shape`, time-zone-free — the caller appends
 * `" · <tz>"` (plan doc, UI section). See the module header for the exact wording per shape.
 */
export function scheduleLabel(shape: ScheduleShape): string {
  throw new Error(`scheduleLabel is not implemented yet (F1.2): shape=${JSON.stringify(shape)}`);
}

/**
 * Display-only cron rendering of `shape` — never parsed back into a `ScheduleShape`. See
 * the module header for the exact mapping per shape, including the cron-Sunday remap.
 */
export function cronOf(shape: ScheduleShape): string {
  throw new Error(`cronOf is not implemented yet (F1.2): shape=${JSON.stringify(shape)}`);
}
