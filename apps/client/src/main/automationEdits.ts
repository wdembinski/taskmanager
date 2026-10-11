/**
 * F1.11 step 2 — the automation edit rules.
 *
 * Pure functions over `Automation` that `ipc.ts`'s `automation:save`/`automation:setEnabled`/
 * `automation:runNow` handlers (a later step) call instead of re-deriving any of this. See
 * `docs/plan/feature-roadmap/F1-automation-triggers.md`'s "F1.11 — decisions taken" section
 * for why each rule is shaped the way it is; this file has no Electron or Store import so it
 * stays testable the same way `automationTrackerFirings.ts` is.
 */
import type { Automation, ScheduleShape } from '@shared/automation';
import { validateAutomation } from '@shared/automation';
import type { AutomationFiring } from './automationRunner';

export function isOwnedHere(a: Automation, localClientId: string): boolean {
  return a.ownerClientId === null || a.ownerClientId === localClientId;
}

export function assertOwnedHere(a: Automation, localClientId: string): void {
  if (!isOwnedHere(a, localClientId)) {
    throw new Error(`‹${a.name}› is owned by another desktop — edit it there.`);
  }
}

/** Shallow-safe for `ScheduleShape`'s plain numeric/string fields; no nested objects to miss. */
function scheduleShapeEqual(a: ScheduleShape, b: ScheduleShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a save's schedule (shape or time zone) differs from what is stored. */
function scheduleChanged(existing: Automation, input: Automation): boolean {
  if (existing.timeZone !== input.timeZone) return true;
  if (existing.trigger.kind !== 'schedule' || input.trigger.kind !== 'schedule') return true;
  return !scheduleShapeEqual(existing.trigger.schedule, input.trigger.schedule);
}

export interface PrepareSaveContext {
  now: number;
  localClientId: string;
  newId: () => string;
}

/**
 * Turn a save's raw draft into the `Automation` actually persisted. `existing` is the
 * stored copy looked up by `input.id` (undefined means create) — the caller's job, not
 * this function's, per the plan's "create vs. edit is a stored match on id" decision.
 *
 * Every server-owned field (`revision`, `ownerClientId`, `createdAt`, `enabledAt`,
 * `nextRunAt`, `consecutiveFailures`) is computed here and never taken from `input`.
 */
export function prepareAutomationSave(
  input: Automation,
  existing: Automation | undefined,
  ctx: PrepareSaveContext,
): Automation {
  const errors = validateAutomation(input);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }
  if (existing) {
    assertOwnedHere(existing, ctx.localClientId);
  }

  const justEnabled = input.enabled && !(existing?.enabled ?? false);
  const id = existing?.id ?? (input.id.trim() ? input.id : ctx.newId());

  let nextRunAt: number | null;
  if (input.trigger.kind !== 'schedule' || !existing || justEnabled) {
    nextRunAt = null;
  } else if (scheduleChanged(existing, input)) {
    nextRunAt = null;
  } else {
    nextRunAt = existing.nextRunAt;
  }

  return {
    ...input,
    id,
    revision: existing ? existing.revision + 1 : 1,
    ownerClientId: existing?.ownerClientId ?? ctx.localClientId,
    createdAt: existing?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
    enabledAt: justEnabled ? ctx.now : (existing?.enabledAt ?? null),
    nextRunAt,
    consecutiveFailures: !existing || justEnabled ? 0 : existing.consecutiveFailures,
  };
}

/** `automation:setEnabled`'s thin wrapper — the enable/disable toggle is just a save. */
export function prepareSetEnabled(
  existing: Automation,
  enabled: boolean,
  ctx: PrepareSaveContext,
): Automation {
  return prepareAutomationSave({ ...existing, enabled }, existing, ctx);
}

/** A human pressing "Run now". `occurrenceKey` is unique per press — see `automation.ts`. */
export function manualFiring(now: number, newId: () => string): AutomationFiring {
  return {
    kind: 'manual',
    occurrenceKey: `manual:${newId()}`,
    occurrenceAt: now,
    skippedCount: 0,
  };
}

/**
 * `automation:runNow`'s guard: owned here, and not a tracker automation — `fire` has no
 * card to attach a manual tracker firing to (see the plan's "runNow refuses a tracker
 * automation" decision).
 */
export function assertCanRunNow(a: Automation, localClientId: string): void {
  assertOwnedHere(a, localClientId);
  if (a.trigger.kind !== 'schedule') {
    throw new Error(`‹${a.name}› is a tracker automation — it has no manual trigger.`);
  }
}
