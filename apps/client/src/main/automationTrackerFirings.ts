/**
 * F1.9 — fire tracker automations from the sync sweep.
 *
 * `trackerFirings` is the pure glue between a JIRA/GitHub sync's before/after card sets and
 * `AutomationRunner.fire`: it owns the eligibility filter (enabled, tracker-triggered, owned by
 * this desktop) and the trigger match (`detectTrackerEvents` + `matchesTrackerTrigger`), and
 * hands back the firings as data — nothing here touches the Store or starts a run.
 * `fireTrackerSweep` is the thin impure wrapper both sync paths call to actually fire them.
 */
import type { Automation } from '@shared/automation';
import type { Task } from '@shared/model';
import {
  detectTrackerEvents,
  matchesTrackerTrigger,
  trackerReceiptKey,
} from '@shared/automationTracker';
import type { AutomationFiring, AutomationRunner } from './automationRunner';

export interface TrackerFiring {
  automation: Automation;
  firing: AutomationFiring;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ownedLocally(automation: Automation, localClientId: string): boolean {
  return automation.ownerClientId === null || automation.ownerClientId === localClientId;
}

/**
 * The tracker firings one sync sweep produces, pure. `[]` short-circuits both when the sweep
 * was truncated (an incomplete before/after diff can't be trusted) and, before ever touching
 * `detectTrackerEvents`, when no automation is eligible — the common case with no tracker
 * automations configured at all.
 *
 * At most one firing per (automation, taskId): the first matching event wins, later events for
 * the same automation and card in this sweep are dropped rather than queued twice.
 */
export function trackerFirings(
  automations: Automation[],
  before: Task[],
  upserts: Task[],
  opts: { now: number; localClientId: string; truncated?: boolean },
): TrackerFiring[] {
  if (opts.truncated) return [];

  const eligible = automations.filter(
    (a) => a.enabled && a.trigger.kind === 'tracker' && ownedLocally(a, opts.localClientId),
  );
  if (eligible.length === 0) return [];

  const events = detectTrackerEvents(before, upserts, opts.now);
  const firings: TrackerFiring[] = [];
  const seen = new Set<string>();

  for (const automation of eligible) {
    if (automation.trigger.kind !== 'tracker') continue;
    const { tracker } = automation.trigger;
    for (const event of events) {
      if (!matchesTrackerTrigger(event, tracker, automation.enabledAt)) continue;
      const dedupeKey = `${automation.id}:${event.taskId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      firings.push({
        automation,
        firing: {
          kind: 'tracker',
          occurrenceKey: trackerReceiptKey(event),
          occurrenceAt: opts.now,
          skippedCount: 0,
          taskId: event.taskId,
        },
      });
    }
  }

  return firings;
}

/** One sync's before/after card sets, or `null` to fire nothing (e.g. the sync itself failed). */
export interface TrackerSweep {
  source: 'JIRA' | 'GitHub';
  before: Task[];
  upserts: Task[];
  truncated?: boolean;
  now: number;
}

export interface FireTrackerSweepDeps {
  runner: Pick<AutomationRunner, 'fire'>;
  getAutomations: () => Automation[];
  localClientId: string;
  log: (message: string, err?: unknown) => void;
}

/**
 * The thin impure wrapper both the JIRA and GitHub sweeps call: compute `trackerFirings` and
 * fire each one through `deps.runner`. Nothing here may escape to the caller — one firing (or
 * even `getAutomations` itself) throwing must not stop the rest of the sweep, let alone the
 * sync it rode in on.
 */
export function fireTrackerSweep(deps: FireTrackerSweepDeps, sweep: TrackerSweep | null): void {
  if (!sweep) return;

  try {
    const automations = deps.getAutomations();
    const firings = trackerFirings(automations, sweep.before, sweep.upserts, {
      now: sweep.now,
      localClientId: deps.localClientId,
      truncated: sweep.truncated,
    });

    for (const { automation, firing } of firings) {
      try {
        const result = deps.runner.fire(automation, firing);
        deps.log(
          `${sweep.source} sync: automation ‹${automation.name}› → ${result.status} for ${firing.taskId}`,
        );
      } catch (err) {
        deps.log(
          `${sweep.source} sync: automation ‹${automation.name}› → error for ${firing.taskId}`,
          err,
        );
      }
    }
  } catch (err) {
    deps.log(`${sweep.source} sync: automation firing failed — ${errorMessage(err)}`, err);
  }
}
