/**
 * `AutomationEditor`'s form state and the pure logic around it — no React.
 *
 * `AutomationDraft` keeps the fields for BOTH trigger kinds at once, so a human picking
 * schedule, filling it in, then trying tracker and coming back loses nothing they typed.
 * Only `automationFromDraft`'s active-kind branch decides what actually gets saved.
 *
 * `draftErrors` is just `validateAutomation(automationFromDraft(draft, null))` — the editor
 * and the `automation:save` IPC handler share that one validator rather than growing two
 * slightly different ideas of "valid".
 */
import type { Task } from '@tm/shared/model';
import {
  HOUR_INTERVALS,
  TRACKER_EVENT_KINDS,
  TRACKER_SOURCES,
  validateAutomation,
  type Automation,
  type AutomationAction,
  type AutomationTrigger,
  type HourInterval,
  type ScheduleShape,
  type TrackerEventKind,
  type TrackerSource,
  type TrackerTrigger,
} from '@tm/shared/automation';
import { nextOccurrence, scheduleLabel } from '@tm/shared/automationSchedule';
import { renderAutomationTemplate, type TemplateContext } from '@tm/shared/automationTemplate';
import { PERMISSION_MODE_LABELS, type ClaudeModel, type PermissionMode } from '@tm/shared/session';

/** The literal `ScheduleShape.type` values, named once so the draft and the UI share them. */
export type ScheduleType = ScheduleShape['type'];

/** The form state behind {@link AutomationEditor} — see the file header for why it carries
 *  both trigger kinds' fields at once. */
export interface AutomationDraft {
  name: string;
  enabled: boolean;
  timeZone: string;
  triggerKind: AutomationTrigger['kind'];

  // Schedule fields — kept even while `triggerKind` is `'tracker'`.
  scheduleType: ScheduleType;
  hour: number;
  minute: number;
  day: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  every: HourInterval;

  // Tracker fields — kept even while `triggerKind` is `'schedule'`. The label lists are
  // comma-separated text here, exactly as the human types them; parsed on save.
  source: TrackerSource;
  event: TrackerEventKind;
  status: string;
  label: string;
  anyLabels: string;
  allLabels: string;
  excludeLabels: string;

  // Action fields.
  boardProjectId: string;
  agentProjectId: string;
  titleTemplate: string;
  briefTemplate: string;
  mode: PermissionMode;
  /** `''` means "project default" — the same empty-string sentinel `ModelField` renders. */
  model: string;
  planningModel: ClaudeModel | null;
  autoCreatePr: boolean | null;
  autoIntegrate: boolean | null;
}

export interface NewAutomationDraftOptions {
  timeZone: string;
  agentProjectId?: string;
  boardProjectId?: string;
}

/** A fresh draft's defaults — weekdays at 04:00, `acceptEdits`, and a PR rather than an
 *  auto-merge (plan open question 3: a human reviews what an unattended run did in the
 *  morning, before it lands). */
export function newAutomationDraft({
  timeZone,
  agentProjectId = '',
  boardProjectId = '',
}: NewAutomationDraftOptions): AutomationDraft {
  return {
    name: '',
    enabled: true,
    timeZone,
    triggerKind: 'schedule',

    scheduleType: 'weekdays',
    hour: 4,
    minute: 0,
    day: 1,
    every: 1,

    source: 'jira',
    event: 'entered-status',
    status: '',
    label: '',
    anyLabels: '',
    allLabels: '',
    excludeLabels: '',

    boardProjectId,
    agentProjectId,
    titleTemplate: '{{automation.name}} — {{date}}',
    briefTemplate: '',
    mode: 'acceptEdits',
    model: '',
    planningModel: null,
    autoCreatePr: true,
    autoIntegrate: null,
  };
}

/** `draft.anyLabels`/`allLabels`/`excludeLabels` → the label lists `TrackerTrigger` wants. */
function parseLabelList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The schedule's own fields → `ScheduleShape` — pure, no validation (an out-of-range value
 *  is the validator's job; this only picks which fields the active `scheduleType` means). */
function scheduleShapeFromDraft(draft: AutomationDraft): ScheduleShape {
  switch (draft.scheduleType) {
    case 'daily':
    case 'weekdays':
      return { type: draft.scheduleType, hour: draft.hour, minute: draft.minute };
    case 'weekly':
      return { type: 'weekly', day: draft.day, hour: draft.hour, minute: draft.minute };
    case 'hours':
      return { type: 'hours', every: draft.every };
  }
}

/** The tracker's own fields → `TrackerTrigger`. `status`/`label` and the label lists are
 *  emitted only where they apply/are non-empty — see the file header. */
function trackerFromDraft(draft: AutomationDraft): TrackerTrigger {
  const tracker: TrackerTrigger = { source: draft.source, event: draft.event };
  if (draft.event === 'entered-status') tracker.status = draft.status;
  if (draft.event === 'labeled') tracker.label = draft.label;
  const anyLabels = parseLabelList(draft.anyLabels);
  const allLabels = parseLabelList(draft.allLabels);
  const excludeLabels = parseLabelList(draft.excludeLabels);
  if (anyLabels.length) tracker.anyLabels = anyLabels;
  if (allLabels.length) tracker.allLabels = allLabels;
  if (excludeLabels.length) tracker.excludeLabels = excludeLabels;
  return tracker;
}

/** `Automation` → the draft that edits it, filling in defaults for the trigger kind it is
 *  NOT currently using — see the file header for why both kinds' fields always exist. */
export function draftFromAutomation(a: Automation): AutomationDraft {
  const schedule = a.trigger.kind === 'schedule' ? a.trigger.schedule : null;
  const tracker = a.trigger.kind === 'tracker' ? a.trigger.tracker : null;

  return {
    name: a.name,
    enabled: a.enabled,
    timeZone: a.timeZone,
    triggerKind: a.trigger.kind,

    scheduleType: schedule?.type ?? 'weekdays',
    hour: schedule && schedule.type !== 'hours' ? schedule.hour : 4,
    minute: schedule && schedule.type !== 'hours' ? schedule.minute : 0,
    day: schedule?.type === 'weekly' ? schedule.day : 1,
    every: schedule?.type === 'hours' ? schedule.every : 1,

    source: tracker?.source ?? 'jira',
    event: tracker?.event ?? 'entered-status',
    status: tracker?.status ?? '',
    label: tracker?.label ?? '',
    anyLabels: (tracker?.anyLabels ?? []).join(', '),
    allLabels: (tracker?.allLabels ?? []).join(', '),
    excludeLabels: (tracker?.excludeLabels ?? []).join(', '),

    boardProjectId: a.action.boardProjectId ?? '',
    agentProjectId: a.action.agentProjectId,
    titleTemplate: a.action.titleTemplate,
    briefTemplate: a.action.briefTemplate,
    mode: a.action.mode,
    model: a.action.model ?? '',
    planningModel: a.action.planningModel ?? null,
    autoCreatePr: a.action.autoCreatePr ?? null,
    autoIntegrate: a.action.autoIntegrate ?? null,
  };
}

/**
 * The draft → an `Automation` ready to save. Only the active trigger kind is emitted; the
 * other kind's fields stay in the draft (so switching back loses nothing) but never reach
 * the stored shape. Bookkeeping — id, revision, ownerClientId, enabledAt, nextRunAt,
 * consecutiveFailures, createdAt, updatedAt — comes from `base`, since `automation:save`
 * (F1.11) mints and stamps those itself; `base: null` (a new automation) gets `id: ''` and
 * zero/null bookkeeping.
 */
export function automationFromDraft(draft: AutomationDraft, base: Automation | null): Automation {
  const trigger: AutomationTrigger =
    draft.triggerKind === 'schedule'
      ? { kind: 'schedule', schedule: scheduleShapeFromDraft(draft) }
      : { kind: 'tracker', tracker: trackerFromDraft(draft) };

  const action: AutomationAction = {
    agentProjectId: draft.agentProjectId,
    titleTemplate: draft.titleTemplate,
    briefTemplate: draft.briefTemplate,
    mode: draft.mode,
  };
  if (draft.triggerKind === 'schedule' && draft.boardProjectId) {
    action.boardProjectId = draft.boardProjectId;
  }
  if (draft.model) action.model = draft.model;
  if (draft.planningModel) action.planningModel = draft.planningModel;
  if (draft.autoCreatePr !== null) action.autoCreatePr = draft.autoCreatePr;
  if (draft.autoIntegrate !== null) action.autoIntegrate = draft.autoIntegrate;
  // The editor has no field for this yet (it is set by the composer's trigger section, a
  // later task) — carry it through from `base` so editing an attached automation here
  // doesn't silently detach it.
  if (base?.action.taskId) action.taskId = base.action.taskId;

  return {
    id: base?.id ?? '',
    revision: base?.revision ?? 0,
    name: draft.name,
    enabled: draft.enabled,
    ownerClientId: base?.ownerClientId ?? null,
    timeZone: draft.timeZone,
    trigger,
    action,
    enabledAt: base?.enabledAt ?? null,
    nextRunAt: base?.nextRunAt ?? null,
    consecutiveFailures: base?.consecutiveFailures ?? 0,
    createdAt: base?.createdAt ?? 0,
    updatedAt: base?.updatedAt ?? 0,
  };
}

/** Every validation message `draft` would hit on save — the editor's one source of truth,
 *  shared with the `automation:save` handler via {@link validateAutomation} itself. */
export function draftErrors(draft: AutomationDraft): string[] {
  return validateAutomation(automationFromDraft(draft, null));
}

/** Shown next to `manual` wherever an automation offers a permission mode — a headless run
 *  has no one to answer a permission prompt, so the editor explains the restriction instead
 *  of just hiding or silently rejecting the option. */
export const MANUAL_MODE_EXPLANATION =
  'Manual permission mode is not allowed for an automation — a headless run has no one to ' +
  'answer a permission prompt.';

export interface AutomationModeOption {
  value: PermissionMode;
  label: string;
  disabled: boolean;
  explanation?: string;
}

/** Every `PermissionMode`, for the mode dropdown — `manual` included but disabled, with
 *  {@link MANUAL_MODE_EXPLANATION} as its reason. */
export function automationModeOptions(): AutomationModeOption[] {
  return (Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[]).map((mode) => ({
    value: mode,
    label: PERMISSION_MODE_LABELS[mode],
    disabled: mode === 'manual',
    explanation: mode === 'manual' ? MANUAL_MODE_EXPLANATION : undefined,
  }));
}

export interface NextRunPreview {
  at: number;
  label: string;
}

/**
 * The next `count` occurrences of a schedule draft, from `now` — the same math the clock
 * fires on (`nextOccurrence`, `@tm/shared/automationSchedule`), each labelled in the
 * automation's own time zone. `[]` for a tracker trigger (nothing to preview), or for an
 * unknown time zone or an unsatisfiable shape — both `Intl` and `nextOccurrence` throw for
 * those, caught here so a half-filled form never crashes the preview.
 */
export function nextRunsPreview(draft: AutomationDraft, now: number, count = 5): NextRunPreview[] {
  if (draft.triggerKind !== 'schedule') return [];

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: draft.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return [];
  }

  const shape = scheduleShapeFromDraft(draft);
  const result: NextRunPreview[] = [];
  let after = now;
  for (let i = 0; i < count; i++) {
    let at: number;
    try {
      at = nextOccurrence(shape, after, draft.timeZone);
    } catch {
      break;
    }
    result.push({ at, label: formatter.format(at) });
    after = at;
  }
  return result;
}

/** A sample ticket for the template preview's `{{ticket.*}}` variables — a tracker draft has
 *  no real ticket yet, so this is what shows the human what those variables will carry. */
const SAMPLE_TICKET: Pick<Task, 'title' | 'externalKey' | 'externalUrl' | 'ticketKey'> = {
  title: 'Example ticket',
  externalKey: 'PROJ-123',
  externalUrl: 'https://example.atlassian.net/browse/PROJ-123',
  ticketKey: 'PROJ-123',
};

export interface TemplatePreview {
  title: string;
  brief: string;
}

/** `draft`'s title/brief templates, rendered at `now` — a tracker draft also gets
 *  {@link SAMPLE_TICKET} so its `{{ticket.*}}` variables show something. */
export function templatePreview(draft: AutomationDraft, now: number): TemplatePreview {
  const ctx: TemplateContext = {
    automation: { name: draft.name, timeZone: draft.timeZone },
    at: now,
    ticket: draft.triggerKind === 'tracker' ? SAMPLE_TICKET : null,
  };
  return {
    title: renderAutomationTemplate(draft.titleTemplate, ctx),
    brief: renderAutomationTemplate(draft.briefTemplate, ctx),
  };
}

/** How the trigger reads in one line — reused by the F1.15 automations list. */
export function triggerSummary(draft: AutomationDraft): string {
  if (draft.triggerKind === 'schedule') {
    return `${scheduleLabel(scheduleShapeFromDraft(draft))} · ${draft.timeZone}`;
  }
  const source = draft.source === 'jira' ? 'Jira' : 'GitHub';
  switch (draft.event) {
    case 'appeared':
      return `${source} · new ticket appears`;
    case 'entered-status':
      return `${source} · entered "${draft.status}"`;
    case 'labeled':
      return `${source} · label ${draft.label}`;
  }
}

/** The schedule shapes offered in the shape dropdown — exported so the editor doesn't
 *  invent its own list that could drift from what {@link scheduleShapeFromDraft} knows. */
export const SCHEDULE_TYPES: readonly ScheduleType[] = ['daily', 'weekdays', 'weekly', 'hours'];

export { HOUR_INTERVALS, TRACKER_EVENT_KINDS, TRACKER_SOURCES };
