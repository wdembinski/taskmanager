/**
 * Tracker-triggered automations (F1) fire off a diff of the cards a sync already writes,
 * not a dedicated webhook — see `docs/plan/feature-roadmap/F1-automation-triggers.md`. This
 * module is the pure diff itself (`detectTrackerEvents`), the trigger match
 * (`matchesTrackerTrigger`), and the receipt key that keeps a re-synced tracker from
 * double-firing (`trackerReceiptKey`). No React, no Electron, no DB.
 */
import {
  TRACKER_SOURCES,
  type TrackerSource,
  type TrackerEventKind,
  type TrackerTrigger,
} from './automation';
import type { Task } from './model';

/** One tracker-sourced change found between a sync's before/after card sets. */
export interface TrackerEvent {
  kind: TrackerEventKind;
  source: TrackerSource;
  taskId: string;
  externalKey: string;
  /** The new status (`entered-status`) or the added label (`labeled`); null for `appeared`. */
  value: string | null;
  /** The card's labels after the sync, for a trigger's label filters to match against. */
  labels: string[];
  at: number;
}

function isTrackerCard(task: Task): task is Task & { source: TrackerSource; externalKey: string } {
  return (TRACKER_SOURCES as readonly string[]).includes(task.source) && !!task.externalKey?.trim();
}

function identityKey(source: TrackerSource, externalKey: string): string {
  return `${source}:${externalKey}`;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * The before/after diff tracker automations fire on. Only cards from a tracker source
 * (`TRACKER_SOURCES`) with a non-empty `externalKey` are considered — `plan`/`adhoc`/`ticket`
 * cards have no tracker to have fired an event. Identity is `source + externalKey`, since a
 * card can in principle be re-keyed without its app `id` changing.
 *
 * A card new to `after` fires a single `appeared` and nothing else in the same sweep, even if
 * it also arrives with a status or labels — those are the FIRST status/labels this app has
 * ever seen for it, not a change. An existing card can fire `entered-status` and any number of
 * `labeled` events together.
 */
export function detectTrackerEvents(before: Task[], after: Task[], now: number): TrackerEvent[] {
  const beforeByKey = new Map<string, Task>();
  for (const task of before) {
    if (!isTrackerCard(task)) continue;
    beforeByKey.set(identityKey(task.source, task.externalKey), task);
  }

  const events: TrackerEvent[] = [];

  for (const task of after) {
    if (!isTrackerCard(task)) continue;
    const key = identityKey(task.source, task.externalKey);
    const labelsAfter = task.labels ?? [];
    const prior = beforeByKey.get(key);

    if (!prior) {
      events.push({
        kind: 'appeared',
        source: task.source,
        taskId: task.id,
        externalKey: task.externalKey,
        value: null,
        labels: labelsAfter,
        at: now,
      });
      continue;
    }

    if (
      normalize(task.externalStatus) !== normalize(prior.externalStatus) &&
      task.externalStatus?.trim()
    ) {
      events.push({
        kind: 'entered-status',
        source: task.source,
        taskId: task.id,
        externalKey: task.externalKey,
        value: task.externalStatus,
        labels: labelsAfter,
        at: now,
      });
    }

    const labelsBefore = new Set((prior.labels ?? []).map((l) => l.toLowerCase()));
    for (const label of labelsAfter) {
      if (labelsBefore.has(label.toLowerCase())) continue;
      events.push({
        kind: 'labeled',
        source: task.source,
        taskId: task.id,
        externalKey: task.externalKey,
        value: label,
        labels: labelsAfter,
        at: now,
      });
    }
  }

  return events;
}

function hasEveryLabel(labels: string[], required: string[] | undefined): boolean {
  if (!required?.length) return true;
  const have = new Set(labels.map((l) => l.toLowerCase()));
  return required.every((label) => have.has(label.toLowerCase()));
}

function hasAnyLabel(labels: string[], wanted: string[] | undefined): boolean {
  if (!wanted?.length) return true;
  const have = new Set(labels.map((l) => l.toLowerCase()));
  return wanted.some((label) => have.has(label.toLowerCase()));
}

function hasNoExcludedLabel(labels: string[], excluded: string[] | undefined): boolean {
  if (!excluded?.length) return true;
  const have = new Set(labels.map((l) => l.toLowerCase()));
  return !excluded.some((label) => have.has(label.toLowerCase()));
}

/**
 * Whether `event` is the one `trigger` is watching for.
 *
 * `enabledAt` is the automation's own baseline (`Automation.enabledAt`): null means the
 * automation was never armed, and an event timestamped before it predates the automation
 * caring, so both are refused before anything else is checked. Source and kind must match
 * exactly; `entered-status` then compares `trigger.status` to `event.value`
 * case-insensitively, and `labeled` compares `trigger.label` to `event.value` the same way.
 * The three label filters apply on top of that, against `event.labels` (the card's labels
 * after the sync, not just the one that was added) — an empty or undefined filter always
 * passes.
 */
export function matchesTrackerTrigger(
  event: TrackerEvent,
  trigger: TrackerTrigger,
  enabledAt: number | null,
): boolean {
  if (enabledAt === null || event.at < enabledAt) return false;
  if (event.source !== trigger.source) return false;
  if (event.kind !== trigger.event) return false;

  if (trigger.event === 'entered-status' && normalize(event.value) !== normalize(trigger.status)) {
    return false;
  }
  if (trigger.event === 'labeled' && normalize(event.value) !== normalize(trigger.label)) {
    return false;
  }

  return (
    hasAnyLabel(event.labels, trigger.anyLabels) &&
    hasEveryLabel(event.labels, trigger.allLabels) &&
    hasNoExcludedLabel(event.labels, trigger.excludeLabels)
  );
}

/**
 * The `AutomationRun.occurrenceKey` for a tracker event — `tracker:<taskId>:<kind>:<value>`,
 * value lower-cased and trimmed (empty for `appeared`). Re-entering a status an automation
 * already fired on produces the same key, so it never refires (open question 2 on the plan).
 */
export function trackerReceiptKey(event: TrackerEvent): string {
  return `tracker:${event.taskId}:${event.kind}:${normalize(event.value)}`;
}
