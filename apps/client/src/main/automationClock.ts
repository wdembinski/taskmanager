/**
 * F1.8 — the schedule clock.
 *
 * `AutomationRunner.fire` only ever turns one already-decided {@link AutomationFiring} into
 * a card and a run; this module is what decides WHEN that happens for every `schedule`
 * automation this desktop owns. See `docs/plan/feature-roadmap/F1-automation-triggers.md`
 * for the full design — this file wires `nextOccurrence`/`decideFire` (both pure, both in
 * `@shared`) to a real timer, the way `syncPoller.ts` wires a pure tick to `setInterval`.
 *
 * Every dependency is injected, the same discipline `AutomationRunner` and `SyncPoller`
 * follow: `fire` so a test never needs a real Scheduler, `isOwnedHere` so a test never needs
 * `Store.loadCloudClientId`, and `onResume` so a test never needs Electron's `powerMonitor` —
 * the caller (`ipc.ts`) is the only place that wires any of the three to the real thing.
 *
 * **One `setTimeout`, capped at 60 s (`MAX_WAIT_MS`).** The same 32-bit `setTimeout` overflow
 * `syncPoller.ts` documents — a `nextRunAt` days away would otherwise silently clamp to
 * ~1 ms — plus it is what notices a wall-clock jump (sleep, a changed system clock) without
 * anything telling it to look. With nothing due, `evaluate()` still re-arms for 60 s rather
 * than sitting idle forever.
 *
 * **`evaluate()` is public.** Boot, `powerMonitor`'s `resume`, the timer itself, and a
 * later task's save handler (clearing `nextRunAt` on a schedule-changing edit) all call it
 * the same way. It always clears whatever timer is pending first, then walks every `enabled`
 * `schedule` automation this desktop owns, each wrapped in its own `try`/`catch` — a bad time
 * zone or a throwing `fire` is logged and never stops the automations after it:
 *
 *  - `nextRunAt === null` (never armed, or just edited) → compute the next occurrence and
 *    save it. This alone is "editing a schedule re-arms": clearing `nextRunAt` on save is a
 *    later task's job, not this module's.
 *  - `nextRunAt <= now` → due. Re-read the automation first (a concurrent edit must not be
 *    clobbered), then `decideFire` it. Its `nextRunAt` is saved BEFORE firing — so a `fire`
 *    that throws cannot burst-fire the same occurrence again on the very next `evaluate()`.
 *    A `'scheduled'`/`'catch-up'` decision calls `fire`; a `'skip'` instead reserves its own
 *    `'skipped'` receipt directly (there is no card to delegate to), carrying the decision's
 *    `skippedCount` and a note saying so — "the log says so" even though nothing ran.
 *
 * `dispose()` clears the timer, unsubscribes from `onResume`, and makes any later call to
 * `evaluate()` (a straggling resume event, a timer that was already queued) a deliberate
 * no-op rather than a slow leak into a desktop that has quit evaluating.
 */
import { randomUUID } from 'node:crypto';
import type { Automation, AutomationRun } from '@shared/automation';
import { decideFire } from '@shared/automationFire';
import { nextOccurrence } from '@shared/automationSchedule';
import { logMain } from './log';
import type { AutomationFiring, AutomationRunDuplicate } from './automationRunner';
import type { Store } from './store';

/** Guards the 32-bit `setTimeout` overflow, and bounds how stale a wall-clock jump gets. */
const MAX_WAIT_MS = 60_000;

export interface AutomationClockDeps {
  store: Pick<Store, 'getAutomations' | 'saveAutomation' | 'reserveAutomationRun'>;
  /** The same `AutomationRunner.fire`, with its dependencies already bound. */
  fire: (
    automation: Automation,
    firing: AutomationFiring,
  ) => AutomationRun | AutomationRunDuplicate;
  /** `a.ownerClientId === null || a.ownerClientId === store.loadCloudClientId()` in `ipc.ts`. */
  isOwnedHere: (automation: Automation) => boolean;
  /** `powerMonitor.on('resume', cb)` in `ipc.ts`, returning the matching `.off`. */
  onResume: (cb: () => void) => () => void;
  now?: () => number;
  newId?: () => string;
}

export class AutomationClock {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopResume: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: AutomationClockDeps) {}

  /** Subscribe to resume, then run the first evaluation. */
  start(): void {
    this.stopResume = this.deps.onResume(() => this.evaluate());
    this.evaluate();
  }

  /** Re-decide every owned schedule automation and re-arm. See the module header. */
  evaluate(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const now = this.deps.now?.() ?? Date.now();
    const newId = this.deps.newId ?? randomUUID;
    let earliest: number | null = null;
    const noteEarliest = (at: number): void => {
      earliest = earliest === null ? at : Math.min(earliest, at);
    };

    for (const automation of this.deps.store.getAutomations()) {
      if (!automation.enabled || automation.trigger.kind !== 'schedule') continue;
      if (!this.deps.isOwnedHere(automation)) continue;

      try {
        const tz = automation.timeZone;

        if (automation.nextRunAt === null) {
          const nextRunAt = nextOccurrence(automation.trigger.schedule, now, tz);
          this.deps.store.saveAutomation({ ...automation, nextRunAt, updatedAt: now });
          noteEarliest(nextRunAt);
          continue;
        }

        if (automation.nextRunAt > now) {
          noteEarliest(automation.nextRunAt);
          continue;
        }

        // Due. Re-read so a concurrent edit (e.g. a disable, or a schedule change) is not
        // clobbered by a decision made against a now-stale copy.
        const fresh = this.deps.store.getAutomations().find((a) => a.id === automation.id);
        if (!fresh || fresh.trigger.kind !== 'schedule' || fresh.nextRunAt === null) continue;

        const decision = decideFire({
          due: fresh.nextRunAt,
          now,
          shape: fresh.trigger.schedule,
          tz: fresh.timeZone,
        });
        if (!decision) continue; // raced back to "not due yet" between the two reads

        // Saved BEFORE firing/skipping — see the module header.
        this.deps.store.saveAutomation({ ...fresh, nextRunAt: decision.nextRunAt, updatedAt: now });
        noteEarliest(decision.nextRunAt);

        const occurrenceKey = `schedule:${new Date(decision.occurrenceAt).toISOString()}`;
        if (decision.kind === 'skip') {
          this.deps.store.reserveAutomationRun({
            id: newId(),
            automationId: fresh.id,
            revision: fresh.revision,
            occurrenceKey,
            kind: 'scheduled',
            status: 'skipped',
            taskId: null,
            runId: null,
            refusal: null,
            skippedCount: decision.skippedCount,
            note: `Missed ${decision.skippedCount} occurrence(s) — too late to catch up`,
            at: now,
          });
          continue;
        }

        this.deps.fire(fresh, {
          kind: decision.kind,
          occurrenceKey,
          occurrenceAt: decision.occurrenceAt,
          skippedCount: decision.skippedCount,
        });
      } catch (err) {
        logMain(`automationClock: automation "${automation.id}" failed to evaluate`, err);
      }
    }

    if (this.disposed) return;
    const delay =
      earliest === null ? MAX_WAIT_MS : Math.min(MAX_WAIT_MS, Math.max(0, earliest - now));
    this.timer = setTimeout(() => this.evaluate(), delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopResume?.();
    this.stopResume = null;
  }
}
