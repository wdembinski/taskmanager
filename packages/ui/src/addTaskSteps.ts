/**
 * What Add actually writes, as DATA rather than as a sequence of awaited calls — and what
 * the dialog says once that sequence has run.
 *
 * `AddTaskDialog`'s own `save()` used to inline every write it makes (create, JIRA link,
 * attachments, chain, schedule, assign) with its own `onNotice` excuses scattered across three local
 * helpers. That made the one rule actually governing it — "the card is never rolled back,
 * whatever happens after it exists" — something you had to read the whole function to
 * believe rather than something a test could pin down. `addTaskSteps` turns a settled
 * `AddTaskPlan` into that ordered list; `executeAddTaskSteps` runs it against an injected
 * `invoke`, so the no-rollback rule is a unit test over a fake transport instead of a
 * click-through.
 */
import type { Automation, AutomationAction, AutomationTrigger } from '@tm/shared/automation';
import type { Task } from '@tm/shared/model';
import { RUN_REFUSAL_MESSAGE, type ParkedRefusal, type RunRefusal } from '@tm/shared/scheduler';
import { LINK_REFUSAL_MESSAGE } from '@tm/shared/taskChain';
import type { AddTaskAssign, AddTaskPlan } from './AddTaskDialog';
import type { Transport } from './transport';

/** `useTransport()`'s own call shape — the one thing {@link executeAddTaskSteps} needs
 *  from a transport, named so a fake for it in a test is a one-line type to satisfy. */
export type TransportInvoke = Transport['invoke'];

type CardPlan = Extract<AddTaskPlan, { kind: 'card' }>;
type TicketPlan = Extract<AddTaskPlan, { kind: 'ticket' }>;
type StepPlan = Extract<AddTaskPlan, { kind: 'step' }>;

/**
 * One write `addTaskSteps` would otherwise make inline, in the order {@link addTaskSteps}
 * emits them: create, JIRA link, attachments, chain, schedule, assign.
 *
 * `create-step` / `create-card` / `create-ticket` are mutually exclusive and always first —
 * nothing else here carries an id of its own, because none exists until whichever of these
 * three resolves. `link-jira` and `chain-after` apply only to a `card`/`ticket` plan (a step
 * is never ticketed, chained, or assigned separately — see {@link AddTaskPlan}); `attach`
 * applies to any of the three. `schedule` (F5.12) saves the F1 automation the plan's
 * `trigger` becomes, pointed at the new card — see {@link attachedAutomation}; like the
 * chain it is a `card`/`ticket`-only step, because `addTaskPlan` refuses a trigger on a step. `assign` is always last — attachments must land before it,
 * because a started agent's first prompt quotes the brief's `@name`s, and the files must
 * already be on disk when that prompt is built rather than racing it.
 */
export type AddTaskStep =
  | { kind: 'create-step'; parentId: string; step: StepPlan['step'] }
  | { kind: 'create-card'; board: string; card: CardPlan['card'] }
  | { kind: 'create-ticket'; board: string; ticket: TicketPlan['ticket'] }
  | { kind: 'link-jira'; ticket: NonNullable<CardPlan['ticket']> }
  | { kind: 'attach'; paths: string[] }
  | { kind: 'chain-after'; fromTaskId: string }
  | { kind: 'schedule'; trigger: AutomationTrigger; assign: AddTaskAssign; timeZone: string }
  | { kind: 'assign'; assign: AddTaskAssign; start: boolean };

/**
 * Turn a settled plan into the writes `save()` makes today, as data. `extras` carries what
 * `AddTaskPlan` itself does not — the staged files, the chain pick and the time zone a
 * schedule runs in live on the dialog's own state, not on the plan.
 */
export function addTaskSteps(
  plan: Exclude<AddTaskPlan, { kind: 'incomplete' }>,
  extras: { attachments: readonly string[]; runsAfterId: string | null; timeZone: string },
): AddTaskStep[] {
  const steps: AddTaskStep[] = [];

  if (plan.kind === 'step') {
    steps.push({ kind: 'create-step', parentId: plan.parentId, step: plan.step });
    if (extras.attachments.length) steps.push({ kind: 'attach', paths: [...extras.attachments] });
    return steps;
  }

  if (plan.kind === 'card') {
    steps.push({ kind: 'create-card', board: plan.board, card: plan.card });
    if (plan.ticket) steps.push({ kind: 'link-jira', ticket: plan.ticket });
  } else {
    steps.push({ kind: 'create-ticket', board: plan.board, ticket: plan.ticket });
  }

  if (extras.attachments.length) steps.push({ kind: 'attach', paths: [...extras.attachments] });
  if (extras.runsAfterId) steps.push({ kind: 'chain-after', fromTaskId: extras.runsAfterId });
  // `plan.assign` is never null once `plan.trigger` is set — `addTaskPlan` refuses a trigger
  // with no agent project before anything is written — but the guard keeps that a type fact.
  if (plan.trigger && plan.assign) {
    steps.push({
      kind: 'schedule',
      trigger: plan.trigger,
      assign: plan.assign,
      timeZone: extras.timeZone,
    });
  }
  if (plan.assign) steps.push({ kind: 'assign', assign: plan.assign, start: plan.startNow });

  return steps;
}

/**
 * The automation `trigger` attaches to `card` — never saved by this function itself.
 * `automation:save` (F1.11 decisions) mints `id`, stamps `revision`/`createdAt`/`updatedAt`/
 * `enabledAt`/`nextRunAt`/`consecutiveFailures`, and takes ownership (`ownerClientId`); `now`
 * is only here so this already returns a complete, individually valid `Automation` — the
 * same shape {@link validateAutomation} sees — rather than one with holes a save fills in.
 *
 * `assign` is the plan's own, already-refused-if-missing assignment (see `addTaskPlan`), so
 * `mode` defaults to `'acceptEdits'` the same way a fresh automation in the editor does
 * (`newAutomationDraft`) rather than carrying a `null` the action has no room for.
 */
export function attachedAutomation(
  trigger: AutomationTrigger,
  card: Task,
  assign: AddTaskAssign,
  { now, timeZone }: { now: number; timeZone: string },
): Automation {
  const action: AutomationAction = {
    taskId: card.id,
    agentProjectId: assign.agentProjectId,
    titleTemplate: card.title,
    briefTemplate: '',
    mode: assign.mode ?? 'acceptEdits',
  };
  if (assign.model) action.model = assign.model;

  return {
    id: '',
    revision: 0,
    name: `${card.title} — schedule`,
    enabled: true,
    ownerClientId: null,
    timeZone,
    trigger,
    action,
    enabledAt: now,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * What the (possible) `assign` step did.
 *
 * `'none'` — no agent was picked, so the step was never built. `'assigned'` — Add without
 * Start. `'started'` — the agent is running. `{ kind: 'parked' }` — the limit gate
 * (`task:assignAgent` does not throw for this; it resolves with the task carrying
 * `blocked-by-limit`) or the sign-out gate (which throws, and writes no status — see
 * {@link runFromAssignError}). `{ kind: 'not-started' }` — the assign call threw for any
 * other reason, known ({@link RunRefusal}) or not.
 */
export type AddTaskRun =
  | 'none'
  | 'assigned'
  | 'started'
  | { kind: 'parked'; refusal: ParkedRefusal }
  | { kind: 'not-started'; reason: string; refusal: RunRefusal | null };

/** What {@link executeAddTaskSteps} settles to. */
export interface AddTaskResult {
  created: 'card' | 'ticket' | 'step';
  problems: string[];
  run: AddTaskRun;
}

/** The reverse of {@link RUN_REFUSAL_MESSAGE} — an exact-string lookup, `null` for anything
 *  that is not one of its six entries. */
export function refusalFromMessage(message: string): RunRefusal | null {
  const found = (Object.entries(RUN_REFUSAL_MESSAGE) as Array<[RunRefusal, string]>).find(
    ([, text]) => text === message,
  );
  return found ? found[0] : null;
}

/** Reads the TASK `task:assignAgent` resolved with, for a call that did not throw. */
export function runFromAssign(task: Pick<Task, 'status'>, start: boolean): AddTaskRun {
  if (!start) return 'assigned';
  if (task.status === 'blocked-by-limit') return { kind: 'parked', refusal: 'limit' };
  return 'started';
}

/**
 * Reads the message a REJECTED `task:assignAgent` call threw. A sign-out park writes no
 * status onto the task (`CARD_RECORDS_PARK['signed-out']` is `false`), so the catch here
 * has nothing useful to read off a task — only the message, which is why this is a message
 * lookup rather than a second `runFromAssign`.
 */
export function runFromAssignError(message: string): AddTaskRun {
  const refusal = refusalFromMessage(message);
  if (refusal === 'signed-out') return { kind: 'parked', refusal: 'signed-out' };
  return { kind: 'not-started', reason: message, refusal };
}

/**
 * The one banner the dialog shows after Add, in place of three separate `onNotice` calls.
 *
 * `started`/`assigned`/`none` with no `problems` is `null` — nothing to say, close quietly,
 * exactly as today. A `parked` run reads as success: the engine is doing exactly what Start
 * promised, not failing to. A `not-started` run names the reason verbatim, which for a known
 * refusal already names the fix (`RUN_REFUSAL_MESSAGE['no-project']` says to assign an agent
 * project). Every `problems` entry is appended, space-joined, and its presence alone forces
 * `warning` even over an otherwise-successful run.
 */
export function outcomeMessage(
  result: AddTaskResult,
): { tone: 'success' | 'warning'; text: string } | null {
  const { run, problems } = result;
  let tone: 'success' | 'warning' = 'warning';
  let text: string | null = null;

  if (typeof run !== 'string') {
    if (run.kind === 'parked') {
      tone = 'success';
      text = `Created and queued — ${RUN_REFUSAL_MESSAGE[run.refusal]}`;
    } else {
      text = `Created, not started: ${run.reason}`;
    }
  }

  if (!text && !problems.length) return null;
  return {
    tone: problems.length ? 'warning' : tone,
    text: (text ? [text, ...problems] : problems).join(' '),
  };
}

/**
 * Run `steps` against `invoke`, pure over the injected transport call.
 *
 * The first step is always one of the three `create-*` kinds; its call is awaited OUTSIDE
 * any try — a throw here propagates straight to the caller, because nothing exists yet and
 * the dialog's existing inline error (stays open, nothing to roll back) is still exactly
 * right. Its id is threaded into every later step, none of which carry one of their own.
 *
 * Every step after that is awaited inside its OWN try. A caught throw from `assign` sets
 * `run` via {@link runFromAssignError}; a caught throw from anything else is worded onto
 * `problems` and the loop carries on — nothing here ever calls `task:delete`, because the
 * row that already exists is the one thing every branch keeps.
 */
export async function executeAddTaskSteps(
  steps: readonly AddTaskStep[],
  invoke: TransportInvoke,
): Promise<AddTaskResult> {
  const [first, ...rest] = steps;
  if (!first) throw new Error('addTaskSteps produced no steps to run.');

  let created: AddTaskResult['created'];
  // The whole row, not just its id: a `schedule` step names its automation after the title.
  let row: Task;
  if (first.kind === 'create-step') {
    created = 'step';
    row = await invoke('task:addSubtask', first.parentId, first.step);
  } else if (first.kind === 'create-ticket') {
    created = 'ticket';
    row = await invoke('ticket:create', first.board, first.ticket);
  } else if (first.kind === 'create-card') {
    created = 'card';
    row = await invoke('task:create', first.board, first.card);
  } else {
    throw new Error(`addTaskSteps must start with a create step, got "${first.kind}".`);
  }
  const createdId = row.id;

  const problems: string[] = [];
  let run: AddTaskRun = 'none';

  for (const step of rest) {
    try {
      if (step.kind === 'link-jira') {
        await invoke('jira:createTask', { ...step.ticket, adoptTaskId: createdId });
      } else if (step.kind === 'attach') {
        await invoke('attachment:add', createdId, step.paths);
      } else if (step.kind === 'chain-after') {
        const result = await invoke('chain:link', step.fromTaskId, createdId);
        if (result.status === 'refused') {
          problems.push(
            `The card was created, but it could not be chained — ${LINK_REFUSAL_MESSAGE[result.reason]}.`,
          );
        }
      } else if (step.kind === 'schedule') {
        await invoke(
          'automation:save',
          attachedAutomation(step.trigger, row, step.assign, {
            now: Date.now(),
            timeZone: step.timeZone,
          }),
        );
      } else if (step.kind === 'assign') {
        const task = await invoke('task:assignAgent', createdId, {
          agentProjectId: step.assign.agentProjectId,
          mode: step.assign.mode ?? undefined,
          model: step.assign.model ?? undefined,
          start: step.start,
        });
        run = runFromAssign(task, step.start);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (step.kind === 'assign') {
        run = runFromAssignError(message);
      } else if (step.kind === 'link-jira') {
        problems.push(`The card was created, but its JIRA ticket was not — ${message}`);
      } else if (step.kind === 'attach') {
        problems.push(
          `The ${created === 'step' ? 'step' : 'card'} was created, but its files were not attached — ${message}`,
        );
      } else if (step.kind === 'chain-after') {
        problems.push(`The card was created, but it could not be chained — ${message}.`);
      } else if (step.kind === 'schedule') {
        problems.push(`The card was created, but its schedule was not saved — ${message}`);
      }
    }
  }

  return { created, problems, run };
}
