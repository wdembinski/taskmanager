/**
 * Pure state behind `AutomationsView`'s list and `NextRunsRail` — no React, no transport.
 */
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { nextOccurrence } from '@tm/shared/automationSchedule';
import { draftFromAutomation, triggerSummary } from './automationEditorModel';

export interface NextRun {
  automationId: string;
  name: string;
  at: number;
}

/**
 * The next `count` firings across every enabled, `schedule`-kind automation, merged and
 * sorted ascending by `at`. Each automation contributes at most `count` of its own next
 * occurrences — enough, because the global k-th soonest occurrence (k ≤ count) can never be
 * later than the k-th soonest occurrence of its own source automation, so the true top
 * `count` is always found within each automation's own first `count` candidates.
 *
 * An automation whose time zone throws (should not happen past `validateAutomation`, but
 * mirrors the clock's own defensiveness — see `weekCalendarLayout.layoutWeek`) stops
 * contributing further occurrences rather than failing the whole rail.
 */
export function nextRuns(
  automations: readonly Automation[],
  now: number,
  count: number,
): NextRun[] {
  const candidates: NextRun[] = [];

  for (const automation of automations) {
    if (!automation.enabled || automation.trigger.kind !== 'schedule') continue;

    let after = now;
    for (let i = 0; i < count; i++) {
      let at: number;
      try {
        at = nextOccurrence(automation.trigger.schedule, after, automation.timeZone);
      } catch {
        break;
      }
      candidates.push({ automationId: automation.id, name: automation.name, at });
      after = at;
    }
  }

  candidates.sort((a, b) => a.at - b.at);
  return candidates.slice(0, count);
}

/** The most recent run per automation, by `AutomationRun.at` — independent of whatever order
 *  `runs` arrived in (the IPC contract says newest first, but this does not trust that). */
export function lastRunByAutomation(runs: readonly AutomationRun[]): Map<string, AutomationRun> {
  const latest = new Map<string, AutomationRun>();
  for (const run of runs) {
    const current = latest.get(run.automationId);
    if (!current || run.at > current.at) {
      latest.set(run.automationId, run);
    }
  }
  return latest;
}

/**
 * One line describing what fires an automation: `"daily at 04:00 · Europe/Warsaw"` for a
 * schedule, or a tracker summary — the same line F1.14's editor renders for a draft
 * (`automationEditorModel.triggerSummary`), via the same `draftFromAutomation` the editor
 * uses to open an existing automation.
 */
export function triggerLabel(automation: Automation): string {
  return triggerSummary(draftFromAutomation(automation));
}
