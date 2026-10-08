/**
 * The catch-up age rule (F1.3): turns a schedule occurrence that was `due` in the past —
 * because the app was asleep or closed — into what the clock should actually do about it
 * *now*. See `docs/plan/feature-roadmap/F1-automation-triggers.md` for the full design —
 * this file is `decideFire` only; resolving a `ScheduleShape` to UTC instants is
 * `automationSchedule.ts` (`nextOccurrence`/`occurrencesBetween`, F1.2), and wiring this
 * into a real timer is `automationClock.ts`, a later task on the same plan.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **`due > now` means nothing is due yet.** `decideFire` returns `null` and the caller
 *   just keeps waiting on its existing timer — this is not a missed-occurrence case at all.
 * - **"Missed" is `due` itself plus every later occurrence up to `now`.** That is the
 *   half-open-on-the-left set `{due} ∪ occurrencesBetween(shape, due, now, tz]`, i.e. every
 *   occurrence in `(due, now]` in addition to `due`. `occurrenceAt` is always the *latest*
 *   one of that set — the one the clock would have fired last — and `lateness = now -
 *   occurrenceAt` measures only from that latest instant, never from `due`.
 * - **Three-way split on `lateness`, in order:**
 *   1. `lateness <= graceMs` → `'scheduled'`: close enough to on-time that it is not a
 *      catch-up at all, just a slightly-late normal fire.
 *   2. else, when the shape is **not** `hours`, `lateness <= catchUpMs` → `'catch-up'`: one
 *      card fires for the latest missed occurrence; everything earlier in the missed set is
 *      reported as skipped, never fired.
 *   3. otherwise → `'skip'`: too late to be worth a catch-up fire at all; nothing fires.
 * - **`hours` schedules never catch up, by design.** Even inside `catchUpMs`, an `hours`
 *   shape goes straight from `'scheduled'` to `'skip'` once it is past `graceMs` — there is
 *   no `'catch-up'` outcome for it. Its own cadence is at most every 12 h (`HOUR_INTERVALS`,
 *   `./automation`), so by the time a catch-up would fire, the *next* regular occurrence is
 *   already due or close to it; a catch-up card would just be noise ahead of the real one.
 * - **`skippedCount`.** A fired decision (`'scheduled'` or `'catch-up'`) counts every missed
 *   occurrence *before* the one that fired: `skippedCount = missed.length - 1` (zero when
 *   `due` itself is the only missed occurrence). `'skip'` fires nothing, so every missed
 *   occurrence is skipped: `skippedCount = missed.length`.
 * - **`nextRunAt` is always strictly after `now`**, regardless of outcome — the whole point
 *   of the age rule is that the clock never bursts through a backlog, it decides once and
 *   re-arms once. Computed as `nextOccurrence(shape, max(occurrenceAt, now), tz)`
 *   (`./automationSchedule`): seeding from `occurrenceAt` alone would be wrong once
 *   `occurrenceAt <= now` (it could return an instant that is not after `now`), so the seed
 *   is whichever of the two is later.
 * - **The 10,000-occurrence cap, and why `occurrenceAt` does not read it directly.**
 *   `occurrencesBetween` (`./automationSchedule`) hard-caps its result at 10,000 entries. An
 *   hourly schedule asleep for over a year has more than 10,000 missed occurrences in
 *   `(due, now]`, so a single `occurrencesBetween(shape, due, now, tz)` call would stop
 *   10,000 occurrences past `due` — nowhere near `now` — and its last entry would silently
 *   be the wrong, stale `occurrenceAt`. To keep `occurrenceAt` correct regardless of how long
 *   the gap is, it is found from a **separate, bounded** query over the window
 *   `[max(due, now - 8 days), now]` (8 days comfortably exceeds every shape's own cadence —
 *   the longest is `weekly` — so the window always contains at least one real occurrence and
 *   its last entry is always the true latest). The **count** used for `missed.length` /
 *   `skippedCount`, by contrast, comes from the *full* `(due, now]` range and inherits the
 *   cap honestly: at 10,000 it is a **documented lower bound**, not an exact count, for that
 *   edge case alone.
 */
import type { ScheduleShape } from './automation';
import { nextOccurrence } from './automationSchedule';

/** On-time tolerance: late by this much or less is `'scheduled'`, not a catch-up. */
export const DEFAULT_GRACE_MS = 10 * 60_000;

/** How late a non-`hours` schedule may be and still get one `'catch-up'` fire. */
export const DEFAULT_CATCH_UP_MS = 24 * 60 * 60_000;

/**
 * What `decideFire` resolved a missed (or on-time) occurrence to. `'hours'` shapes never
 * produce `'catch-up'` — see the module header.
 */
export type FireDecisionKind = 'scheduled' | 'catch-up' | 'skip';

/** The outcome of `decideFire` for one evaluation of a schedule automation's clock. */
export interface FireDecision {
  kind: FireDecisionKind;
  /** The latest occurrence in the missed set `{due} ∪ (due, now]` — see the module header. */
  occurrenceAt: number;
  /** Missed occurrences that did not fire: `missed.length - 1` when fired, else `missed.length`. */
  skippedCount: number;
  /** The next arm point for the clock. Always strictly after `now`. */
  nextRunAt: number;
}

/**
 * Resolves what a schedule automation's clock should do about a `due` occurrence being
 * evaluated at `now`: fire it normally, fire it once as a catch-up, or skip it — and what to
 * arm the clock for next. Returns `null` when `due > now` (nothing is due yet; the caller
 * keeps waiting). See the module header for the full grace/catch-up/skip rule, the `hours`
 * exception, and the 10,000-occurrence cap edge case. Throws `RangeError` for an unknown
 * `tz`, propagated from `nextOccurrence` (`./automationSchedule`).
 */
export function decideFire(input: {
  due: number;
  now: number;
  shape: ScheduleShape;
  tz: string;
  graceMs?: number;
  catchUpMs?: number;
}): FireDecision | null {
  throw new Error(
    `decideFire is not implemented yet (F1.3): due=${input.due}, now=${input.now}, ` +
      `shape=${JSON.stringify(input.shape)}, tz=${input.tz}`,
  );
}
