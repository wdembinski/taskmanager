/**
 * Pure state behind `AutomationsView`'s list and `NextRunsRail` — no React, no transport.
 *
 * `triggerLabel`'s tracker-kind branch deliberately re-derives what F1.14's
 * `automationEditorModel.triggerSummary` already renders for a draft, rather than importing
 * it: that module lives on the (separate, not-yet-merged) F1.14 branch, and this one has to
 * typecheck and test on its own before that lands. Once F1.11/F1.14 are in this branch the
 * two can be reconciled; until then the tracker-label wording below is kept identical to
 * `triggerSummary`'s on purpose, so there is nothing to reconcile *to* a different string.
 */
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { nextOccurrence, scheduleLabel } from '@tm/shared/automationSchedule';

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
 * schedule, or a tracker summary — see the file header for why the tracker branch is a local
 * copy of F1.14's `triggerSummary` rather than an import of it.
 */
export function triggerLabel(automation: Automation): string {
  if (automation.trigger.kind === 'schedule') {
    return `${scheduleLabel(automation.trigger.schedule)} · ${automation.timeZone}`;
  }

  const { tracker } = automation.trigger;
  const source = tracker.source === 'jira' ? 'Jira' : 'GitHub';
  switch (tracker.event) {
    case 'appeared':
      return `${source} · new ticket appears`;
    case 'entered-status':
      return `${source} · entered "${tracker.status}"`;
    case 'labeled':
      return `${source} · label ${tracker.label}`;
  }
}
