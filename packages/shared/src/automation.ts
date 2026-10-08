/**
 * The automation model (F1): a run that starts because a clock said so, or because a
 * tracker did, instead of a human pressing something. See
 * `docs/plan/feature-roadmap/F1-automation-triggers.md` for the full design — this file is
 * the data model and its validator only; the pure evaluation engine
 * (`automationSchedule`/`automationFire`/`automationTracker`) and the IPC channels are later
 * tasks on the same plan.
 */
import type { RunRefusal } from './scheduler';
import type { ClaudeModel, PermissionMode } from './session';

/**
 * The hour intervals an `{ type: 'hours' }` schedule may fire on. Exported as the literal
 * list rather than just the union type so the validator and the editor's picker share one
 * source of truth.
 */
export const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12] as const;
export type HourInterval = (typeof HOUR_INTERVALS)[number];

/** Where a tracker trigger watches. GitLab has no card source yet (v1 out of scope). */
export const TRACKER_SOURCES = ['jira', 'github'] as const;
export type TrackerSource = (typeof TRACKER_SOURCES)[number];

/**
 * What a tracker trigger watches for, detected as a before/after diff of the cards a sync
 * already writes (`detectTrackerEvents`, a later task): a ticket appearing on the board for
 * the first time, its `externalStatus` changing, or a label being added.
 */
export const TRACKER_EVENT_KINDS = ['appeared', 'entered-status', 'labeled'] as const;
export type TrackerEventKind = (typeof TRACKER_EVENT_KINDS)[number];

/** A time-based trigger. Wall-time, evaluated in the automation's own `Automation.timeZone`. */
export type ScheduleShape =
  | { type: 'daily' | 'weekdays'; hour: number; minute: number }
  | { type: 'weekly'; day: 1 | 2 | 3 | 4 | 5 | 6 | 7; hour: number; minute: number }
  | { type: 'hours'; every: HourInterval };

/** A tracker-based trigger: fires on a diff of the cards the existing sync already writes. */
export interface TrackerTrigger {
  source: TrackerSource;
  event: TrackerEventKind;
  /** `entered-status` only: matches `Task.externalStatus`, case-insensitively. */
  status?: string;
  /** `labeled` only: the label whose addition fires this trigger. */
  label?: string;
  anyLabels?: string[];
  allLabels?: string[];
  excludeLabels?: string[];
}

/**
 * What a firing does. For a schedule trigger this creates a new card on `boardProjectId`
 * from the templates; for a tracker trigger the ticket's own, already-existing card is
 * worked and the templates are unused.
 */
export interface AutomationAction {
  /** Schedule only — the board the new card is created on. */
  boardProjectId?: string;
  agentProjectId: string;
  /** Schedule only, e.g. `"Nightly triage — {{date}}"`. */
  titleTemplate: string;
  /** Prepended to the card brief / notes. */
  briefTemplate: string;
  /** `'manual'` is rejected by {@link validateAutomation} — see its comment for why. */
  mode: PermissionMode;
  model?: ClaudeModel;
  planningModel?: ClaudeModel;
  autoCreatePr?: boolean | null;
  autoIntegrate?: boolean | null;
}

/** The schedule|tracker union an {@link Automation} fires on. */
export type AutomationTrigger =
  { kind: 'schedule'; schedule: ScheduleShape } | { kind: 'tracker'; tracker: TrackerTrigger };

/** A stored, user-authored automation. */
export interface Automation {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  /** The desktop that created it, and the only one that evaluates/fires it. Null = this one. */
  ownerClientId: string | null;
  /** IANA zone, captured at creation; shown in the editor. */
  timeZone: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** The baseline: tracker events for cards from before this moment are ignored. */
  enabledAt: number | null;
  /** Schedule only; null means "recompute". */
  nextRunAt: number | null;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

/** How a run was triggered. */
export type FiringKind = 'scheduled' | 'catch-up' | 'manual' | 'tracker';

/** What happened to one firing. See `automationRunner.ts` (a later task) for the mapping. */
export type AutomationRunStatus =
  'reserved' | 'started' | 'parked' | 'refused' | 'skipped' | 'duplicate' | 'error';

/** One receipt of a firing, keyed so a re-armed timer or a re-synced tracker can't double-fire. */
export interface AutomationRun {
  id: string;
  automationId: string;
  revision: number;
  /** `'schedule:<iso>'` | `'tracker:<taskId>:<event>:<value>'` | `'manual:<uuid>'`. */
  occurrenceKey: string;
  kind: FiringKind;
  status: AutomationRunStatus;
  taskId: string | null;
  runId: string | null;
  refusal: RunRefusal | null;
  skippedCount: number;
  note: string | null;
  at: number;
}

function validateHourMinute(hour: number, minute: number, errors: string[]): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    errors.push('Hour must be a whole number between 0 and 23.');
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    errors.push('Minute must be a whole number between 0 and 59.');
  }
}

/**
 * Every rule the editor and the IPC handler both enforce, as human-readable messages —
 * empty means valid. Pure and synchronous so the editor can call it on every keystroke.
 *
 * The `mode !== 'manual'` rule is the one surprising entry: a headless, unattended run has
 * no human to answer a permission prompt, so `'manual'` — which pauses on every tool call —
 * can never complete one (memory: *a-headless-turn-has-no-next-turn*). The editor should
 * explain this rather than just reject it.
 */
export function validateAutomation(a: Automation): string[] {
  const errors: string[] = [];

  if (!a.name.trim()) {
    errors.push('Name is required.');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: a.timeZone });
  } catch {
    errors.push(`Unknown time zone "${a.timeZone}".`);
  }

  if (a.trigger.kind === 'schedule') {
    const schedule = a.trigger.schedule;
    if (!schedule) {
      errors.push('A schedule is required.');
    } else {
      switch (schedule.type) {
        case 'daily':
        case 'weekdays':
          validateHourMinute(schedule.hour, schedule.minute, errors);
          break;
        case 'weekly':
          validateHourMinute(schedule.hour, schedule.minute, errors);
          if (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 7) {
            errors.push('Weekly day must be a whole number between 1 and 7.');
          }
          break;
        case 'hours':
          if (!(HOUR_INTERVALS as readonly number[]).includes(schedule.every)) {
            errors.push(`Hour interval must be one of ${HOUR_INTERVALS.join(', ')}.`);
          }
          break;
      }
    }
    if (!a.action.titleTemplate.trim()) {
      errors.push('A title template is required for a schedule automation.');
    }
  } else {
    const tracker = a.trigger.tracker;
    if (!tracker) {
      errors.push('A tracker trigger is required.');
    } else {
      if (!(TRACKER_SOURCES as readonly string[]).includes(tracker.source)) {
        errors.push(`Tracker source must be one of ${TRACKER_SOURCES.join(', ')}.`);
      }
      if (!(TRACKER_EVENT_KINDS as readonly string[]).includes(tracker.event)) {
        errors.push(`Tracker event must be one of ${TRACKER_EVENT_KINDS.join(', ')}.`);
      }
      if (tracker.event === 'entered-status' && !tracker.status?.trim()) {
        errors.push('A status is required for an "entered status" trigger.');
      }
      if (tracker.event === 'labeled' && !tracker.label?.trim()) {
        errors.push('A label is required for a "labeled" trigger.');
      }
    }
  }

  if (!a.action.agentProjectId.trim()) {
    errors.push('An agent project is required.');
  }
  if (a.action.mode === 'manual') {
    errors.push(
      'Manual permission mode is not allowed for an automation — a headless run has no one ' +
        'to answer a permission prompt.',
    );
  }

  return errors;
}
