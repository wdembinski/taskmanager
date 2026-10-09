/**
 * F1.7 — launch a card for a firing.
 *
 * This is the one place an {@link Automation} turns into an actual card and an actual run.
 * Everything upstream of it (the clock deciding it is time, the catch-up rule deciding how
 * many occurrences were missed, the tracker diff deciding a ticket qualifies) only ever
 * hands this module one {@link AutomationFiring} and expects a receipt back — `fire` never
 * looks at a clock or a tracker sync itself.
 *
 * Every dependency the engine needs is injected via {@link AutomationRunnerDeps} rather than
 * imported directly, so this stays testable with an in-memory store double and without a
 * real Scheduler — the same reason `delegate`/`startTaskNow`/`isTaskWorking` are passed in
 * instead of called on a concrete `Scheduler` instance.
 */
import { randomUUID } from 'node:crypto';
import type { Automation, AutomationRun, FiringKind } from '@shared/automation';
import { renderAutomationTemplate } from '@shared/automationTemplate';
import type { AssignAgentInput, Task } from '@shared/model';
import {
  isParkedRefusal,
  RUN_REFUSAL_MESSAGE,
  type RunOutcome,
  type RunRefusal,
} from '@shared/scheduler';
import type { Store } from './store';

/** How many consecutive non-starting firings disable an automation (step 6's "3 strikes"). */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How far back to look for an overlapping `started` receipt. Newest-first, so in practice a
 * match (if any) is almost always the first or second row; this just bounds the scan rather
 * than ever mattering in the common case.
 */
const OVERLAP_LOOKBACK = 20;

/**
 * One occurrence to run, handed to {@link fire} by the clock (`scheduled`/`catch-up`), a
 * human (`manual`), or a tracker diff (`tracker`).
 */
export interface AutomationFiring {
  kind: FiringKind;
  /** The idempotency key `reserveAutomationRun` is unique on, together with the automation. */
  occurrenceKey: string;
  /** Epoch ms — also the instant used as the template's `{{date}}`/`{{time}}`. */
  occurrenceAt: number;
  /** How many earlier occurrences this firing stands in for (0 outside a catch-up). */
  skippedCount: number;
  /** Tracker firings only: the ticket's own, already-existing card. */
  taskId?: string;
}

/**
 * Notified when an automation disables itself after {@link MAX_CONSECUTIVE_FAILURES}
 * consecutive non-starting firings. Its full shape belongs to a later task; `fire` only
 * ever calls the one method below.
 */
export interface AutomationAttentionSink {
  automationDisabled(automation: Automation, message: string): void;
}

/**
 * Everything {@link fire} needs from the running app, narrowed to exactly the methods it
 * calls — the same `Pick` discipline the rest of the IPC layer uses so a test double doesn't
 * have to implement the other hundred `Store` methods.
 */
export interface AutomationRunnerDeps {
  store: Pick<
    Store,
    | 'reserveAutomationRun'
    | 'updateAutomationRun'
    | 'getAutomationRuns'
    | 'getAutomations'
    | 'saveAutomation'
    | 'getTask'
    | 'getProject'
    | 'createTask'
    | 'updateTask'
    | 'addComment'
  >;
  /**
   * Step 2's shared fn, extracted from `task:assignAgent`'s own body with `start` forced to
   * `false` by this module's caller — `fire` never starts the run itself, `startTaskNow`
   * below does that once the delegation and the timeline note have landed.
   *
   * Contract this module relies on: a throw whose **cause** is the literal string
   * `'no-project'` means the agent project is missing or has no repository behind it; any
   * other throw is an unexpected failure and its `message` is recorded verbatim.
   */
  delegate: (taskId: string, input: AssignAgentInput) => Task;
  startTaskNow: (taskId: string) => RunOutcome;
  /** `canStopWork` + the live `activeRuns` set, collapsed to one question. */
  isTaskWorking: (taskId: string) => boolean;
  attention: AutomationAttentionSink;
  /** `task:changed` / board refresh — omitted in a test double that doesn't care. */
  onTaskChanged?: (task: Task) => void;
  now?: () => number;
  newId?: () => string;
}

/** What {@link fire} returns when the occurrence was already reserved by an earlier call. */
export interface AutomationRunDuplicate {
  status: 'duplicate';
}

/** The receipt-patch shape `updateAutomationRun` accepts — named once, used everywhere below. */
type RunPatch = Partial<
  Pick<AutomationRun, 'status' | 'taskId' | 'runId' | 'refusal' | 'skippedCount' | 'note' | 'at'>
>;

export class AutomationRunner {
  constructor(private readonly deps: AutomationRunnerDeps) {}

  fire(automation: Automation, firing: AutomationFiring): AutomationRun | AutomationRunDuplicate {
    return fireOne(this.deps, automation, firing);
  }
}

function isAgentProjectRefusal(err: unknown): boolean {
  return err instanceof Error && err.cause === 'no-project';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strike-counter transitions a landed receipt can cause (step 6's table, generalized to every refusal/error exit). */
type StrikeEffect = 'reset' | 'unchanged' | 'increment';

/**
 * Re-read the automation (a concurrent edit must not be clobbered), apply the strike
 * transition, and disable it once {@link MAX_CONSECUTIVE_FAILURES} is reached.
 *
 * `message` is the sentence `attention.automationDisabled` reports when this save is the one
 * that trips the limit — callers pass `RUN_REFUSAL_MESSAGE[refusal]` when the landed receipt
 * carries a {@link RunRefusal}, or the receipt's own `note` for an `error` outcome, which has
 * no `RunRefusal` to look up.
 */
function applyStrike(
  deps: AutomationRunnerDeps,
  automationId: string,
  effect: StrikeEffect,
  message?: string,
): void {
  if (effect === 'unchanged') return;
  const automation = deps.store.getAutomations().find((a) => a.id === automationId);
  if (!automation) return;
  const consecutiveFailures = effect === 'reset' ? 0 : automation.consecutiveFailures + 1;
  const disable = effect === 'increment' && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  deps.store.saveAutomation({
    ...automation,
    consecutiveFailures,
    enabled: disable ? false : automation.enabled,
    updatedAt: deps.now?.() ?? Date.now(),
  });
  if (disable) {
    deps.attention.automationDisabled(automation, message ?? '');
  }
}

function templateContext(automation: Automation, firing: AutomationFiring, ticket: Task | null) {
  return {
    automation: { name: automation.name, timeZone: automation.timeZone },
    at: firing.occurrenceAt,
    ticket,
  };
}

/** The "Started by automation…" sentence step 5 posts to the card's timeline. */
function startedNote(automation: Automation, firing: AutomationFiring): string {
  if (firing.kind !== 'catch-up' || firing.skippedCount <= 0) {
    return `Started by automation ‹${automation.name}›`;
  }
  const time = renderAutomationTemplate('{{time}}', templateContext(automation, firing, null));
  return `Started by automation ‹${automation.name}› (catch-up for ${time}, ${firing.skippedCount} skipped)`;
}

/**
 * Step 4: delegate the card with `start: false`. A missing/repo-less agent project settles
 * the receipt as `refused: 'no-project'`; any other throw settles it as `error` with
 * `note = message`. Both are strikes. Returns the delegated task on success, or the
 * already-settled receipt on failure — the caller tells the two apart with {@link isTask}.
 */
function delegateCard(
  deps: AutomationRunnerDeps,
  automation: Automation,
  settle: (patch: RunPatch) => AutomationRun,
  taskId: string,
  notes: string,
): Task | AutomationRun {
  try {
    return deps.delegate(taskId, {
      agentProjectId: automation.action.agentProjectId,
      mode: automation.action.mode,
      model: automation.action.model,
      planningModel: automation.action.planningModel,
      notes,
      start: false,
    });
  } catch (err) {
    if (isAgentProjectRefusal(err)) {
      const run = settle({
        status: 'refused',
        taskId,
        refusal: 'no-project',
        note: RUN_REFUSAL_MESSAGE['no-project'],
      });
      applyStrike(deps, automation.id, 'increment', RUN_REFUSAL_MESSAGE['no-project']);
      return run;
    }
    const message = errorMessage(err);
    const run = settle({ status: 'error', taskId, refusal: null, note: message });
    applyStrike(deps, automation.id, 'increment', message);
    return run;
  }
}

/** `Task` and `AutomationRun` never share this key — `AutomationRun` always has it, `Task` never does. */
function isTask(value: Task | AutomationRun): value is Task {
  return !('automationId' in value);
}

function fireOne(
  deps: AutomationRunnerDeps,
  automation: Automation,
  firing: AutomationFiring,
): AutomationRun | AutomationRunDuplicate {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? randomUUID;

  // 1. Reserve the receipt. A `false` means this occurrence already has one — there is
  // nothing else to write, since logging a duplicate as its own row would defeat the point
  // of the UNIQUE constraint it just tripped.
  const reserved: AutomationRun = {
    id: newId(),
    automationId: automation.id,
    revision: automation.revision,
    occurrenceKey: firing.occurrenceKey,
    kind: firing.kind,
    status: 'reserved',
    taskId: firing.taskId ?? null,
    runId: null,
    refusal: null,
    skippedCount: firing.skippedCount,
    note: null,
    at: now(),
  };
  if (!deps.store.reserveAutomationRun(reserved)) {
    return { status: 'duplicate' };
  }
  const settle = (patch: RunPatch): AutomationRun =>
    deps.store.updateAutomationRun(reserved.id, patch) ?? { ...reserved, ...patch };

  // 2. Overlap check. A previous `started` receipt whose task is still being worked means
  // this occurrence must not pile a second agent onto it — and for a tracker firing, the
  // ticket's own card being worked by anything (not only a prior automation run) is the same
  // hazard, even with no overlapping receipt at all. Not a strike either way.
  const previousStarted = deps.store
    .getAutomationRuns(automation.id, OVERLAP_LOOKBACK)
    .find((r) => r.status === 'started' && r.taskId);
  const overlapping =
    (previousStarted?.taskId && deps.isTaskWorking(previousStarted.taskId)) ||
    (firing.kind === 'tracker' && firing.taskId !== undefined && deps.isTaskWorking(firing.taskId));
  if (overlapping) {
    return settle({ status: 'skipped', note: 'previous run still working' });
  }

  // 3 + 4. Card, then delegate.
  let task: Task;
  if (firing.kind === 'tracker') {
    const ticket = firing.taskId ? deps.store.getTask(firing.taskId) : undefined;
    if (!ticket) {
      const run = settle({
        status: 'refused',
        refusal: 'unknown-task',
        note: RUN_REFUSAL_MESSAGE['unknown-task'],
      });
      applyStrike(deps, automation.id, 'increment', RUN_REFUSAL_MESSAGE['unknown-task']);
      return run;
    }
    const brief = renderAutomationTemplate(
      automation.action.briefTemplate,
      templateContext(automation, firing, ticket),
    );
    const delegated = delegateCard(deps, automation, settle, ticket.id, brief);
    if (!isTask(delegated)) return delegated;
    task = delegated;
  } else {
    const project = automation.action.boardProjectId
      ? deps.store.getProject(automation.action.boardProjectId)
      : undefined;
    if (!project) {
      const run = settle({
        status: 'refused',
        refusal: 'no-project',
        note: RUN_REFUSAL_MESSAGE['no-project'],
      });
      applyStrike(deps, automation.id, 'increment', RUN_REFUSAL_MESSAGE['no-project']);
      return run;
    }
    const ctx = templateContext(automation, firing, null);
    const created = deps.store.createTask(project.id, {
      title: renderAutomationTemplate(automation.action.titleTemplate, ctx),
      description: renderAutomationTemplate(automation.action.briefTemplate, ctx),
      projectTagId: automation.action.agentProjectId,
    });
    if (!created) {
      const run = settle({
        status: 'refused',
        refusal: 'no-project',
        note: RUN_REFUSAL_MESSAGE['no-project'],
      });
      applyStrike(deps, automation.id, 'increment', RUN_REFUSAL_MESSAGE['no-project']);
      return run;
    }
    const brief = renderAutomationTemplate(
      automation.action.briefTemplate,
      templateContext(automation, firing, created),
    );
    const delegated = delegateCard(deps, automation, settle, created.id, brief);
    if (!isTask(delegated)) return delegated;
    task = delegated;
  }

  // Both schedule and tracker cards: carry the origin forward, and the auto-PR/integrate
  // options the editor set — only the ones actually defined, mirroring `task:setAgentOptions`.
  deps.store.updateTask(task.id, {
    originAutomationId: automation.id,
    ...(automation.action.autoCreatePr !== undefined
      ? { autoCreatePr: automation.action.autoCreatePr }
      : {}),
    ...(automation.action.autoIntegrate !== undefined
      ? { autoIntegrate: automation.action.autoIntegrate }
      : {}),
  });

  // 5. Timeline note, before the attempt to start — so it explains the run whether or not
  // starting it actually succeeds.
  deps.store.addComment(task.projectId, task.id, startedNote(automation, firing));
  deps.onTaskChanged?.(task);

  // 6. Start, and map the outcome onto a receipt + the strike counter.
  const outcome = deps.startTaskNow(task.id);
  if ('runId' in outcome) {
    const run = settle({ status: 'started', taskId: task.id, runId: outcome.runId, refusal: null });
    applyStrike(deps, automation.id, 'reset');
    return run;
  }
  const refusal: RunRefusal = outcome.refused;
  if (refusal === 'shutting-down') {
    // The app is quitting — not a strike, there is nothing wrong with the automation.
    return settle({
      status: 'refused',
      taskId: task.id,
      refusal,
      note: RUN_REFUSAL_MESSAGE[refusal],
    });
  }
  if (isParkedRefusal(refusal)) {
    const run = settle({
      status: 'parked',
      taskId: task.id,
      refusal,
      note: RUN_REFUSAL_MESSAGE[refusal],
    });
    applyStrike(deps, automation.id, 'unchanged');
    return run;
  }
  const run = settle({
    status: 'refused',
    taskId: task.id,
    refusal,
    note: RUN_REFUSAL_MESSAGE[refusal],
  });
  applyStrike(deps, automation.id, 'increment', RUN_REFUSAL_MESSAGE[refusal]);
  return run;
}
