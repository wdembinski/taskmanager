/**
 * What "Add to board" and "Hand to agent" actually write, as DATA rather than as a sequence of
 * awaited calls — the same split `addTaskSteps.ts` draws for the Add dialog, applied to F5.8's
 * Issues screen.
 *
 * `IssuesScreen.tsx` used to inline `issues:import` and `task:assignAgent` directly in its own
 * `addToBoard`/`handToAgent` handlers. `handOffSteps` turns an issue plus what the panel asked
 * for into that ordered list; `executeHandOffSteps` runs it against an injected `invoke`, so
 * the screen's one rule — the imported card is never rolled back, whatever the assign call
 * does afterwards — is a unit test over a fake transport instead of a click-through. The
 * refusal/park bookkeeping is `addTaskSteps`'s own (`runFromAssign`/`runFromAssignError`); an
 * assign refusal here means exactly what it means for Add, so it is reused rather than
 * re-derived, and `assign` itself is the same {@link AddTaskAssign} the Add dialog fills in.
 */
import type { AddTaskAssign } from '../AddTaskDialog';
import {
  runFromAssign,
  runFromAssignError,
  type AddTaskRun,
  type TransportInvoke,
} from '../addTaskSteps';
import type { IssueProviderId, IssueSummary } from '@tm/shared/issues';
import { RUN_REFUSAL_MESSAGE } from '@tm/shared/scheduler';

/** What the hand-off panel asked for: a plain import, or an import-then-assign-and-start. */
export type HandOffRequest =
  | { action: 'add' }
  | {
      action: 'hand';
      assign: AddTaskAssign;
      /** The prompt box's raw text — trimmed, and dropped entirely when blank, by
       *  {@link handOffSteps} rather than by the caller. */
      prompt: string;
    };

/**
 * One write `handOffSteps` would otherwise make inline, in the order it emits them: import,
 * then assign. `import` is omitted for an issue already on the board (`onBoardTaskId` is not
 * null) — the same card is reused rather than imported a second time. `assign` is omitted for
 * a plain `'add'` request, and always starts the agent — the Issues screen has no "assign
 * without starting" affordance the way the Add dialog does.
 */
export type HandOffStep =
  | { kind: 'import'; provider: IssueProviderId; key: string }
  | { kind: 'assign'; assign: AddTaskAssign & { notes: string | null }; start: true };

/**
 * Turn an issue and what the panel asked for into the writes `handToAgent`/`addToBoard` make
 * today, as data.
 */
export function handOffSteps(
  issue: Pick<IssueSummary, 'provider' | 'key' | 'onBoardTaskId'>,
  request: HandOffRequest,
): HandOffStep[] {
  const steps: HandOffStep[] = [];

  if (issue.onBoardTaskId === null) {
    steps.push({ kind: 'import', provider: issue.provider, key: issue.key });
  }

  if (request.action === 'hand') {
    const notes = request.prompt.trim();
    steps.push({
      kind: 'assign',
      assign: { ...request.assign, notes: notes.length ? notes : null },
      start: true,
    });
  }

  return steps;
}

/** What {@link executeHandOffSteps} settles to. */
export interface HandOffResult {
  /** The card's id — the one `issues:import` returned, or the issue's own `onBoardTaskId`
   *  when it was already on the board and no import step ran. Null only if neither held,
   *  which `handOffSteps` itself never produces (an `assign` step with nothing to target). */
  taskId: string | null;
  /** Whether an `import` step actually ran — false for an issue already on the board. */
  imported: boolean;
  /** `addTaskSteps`'s own run vocabulary — an assign refusal means the same thing here as it
   *  does for Add. `'none'` is a plain `'add'` request, which never builds an assign step. */
  run: AddTaskRun;
}

/**
 * Run `steps` against `invoke`, pure over the injected transport call.
 *
 * The `import` step, when present, is always first and is awaited OUTSIDE any try — a throw
 * here propagates straight to the caller, because nothing was written and the screen's
 * existing inline error is still exactly right; `assign` is never reached. The `assign` step,
 * when present, is awaited inside its OWN try: a caught throw sets `run` via
 * {@link runFromAssignError} and keeps the imported (or already-on-board) `taskId` — nothing
 * here ever calls `task:delete`.
 */
export async function executeHandOffSteps(
  steps: readonly HandOffStep[],
  issue: Pick<IssueSummary, 'onBoardTaskId'>,
  invoke: TransportInvoke,
): Promise<HandOffResult> {
  let taskId = issue.onBoardTaskId;
  let imported = false;

  const importStep = steps.find((s) => s.kind === 'import');
  if (importStep) {
    const task = await invoke('issues:import', importStep.provider, importStep.key);
    taskId = task.id;
    imported = true;
  }

  let run: AddTaskRun = 'none';
  const assignStep = steps.find((s) => s.kind === 'assign');
  if (assignStep && taskId) {
    try {
      const task = await invoke('task:assignAgent', taskId, {
        agentProjectId: assignStep.assign.agentProjectId,
        mode: assignStep.assign.mode ?? undefined,
        model: assignStep.assign.model ?? undefined,
        notes: assignStep.assign.notes ?? undefined,
        start: assignStep.start,
      });
      run = runFromAssign(task, assignStep.start);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      run = runFromAssignError(message);
    }
  }

  return { taskId, imported, run };
}

/**
 * The one banner the screen shows after a hand-off, in place of the screen inlining its own
 * wording. Unlike `addTaskSteps`'s `outcomeMessage` — which returns `null` for a boring
 * success because the Add dialog just closes — this never returns `null`: the Issues screen
 * stays open, so a plain `'add'`/`'started'` success needs its own confirmation too (the toast
 * and inline `MessageBar` `IssuesScreen.tsx` renders from it).
 *
 * A `parked` run reads as success: the engine is doing exactly what "Hand to agent" promised,
 * not failing to. A `not-started` run names the reason verbatim, which for a known refusal
 * already names the fix (`RUN_REFUSAL_MESSAGE['no-project']` says to assign an agent project).
 * `request` decides the happy-path wording up front, since a plain `'add'` never builds an
 * `assign` step and so always settles at `run: 'none'`.
 */
export function handOffMessage(
  result: HandOffResult,
  request: HandOffRequest,
): { tone: 'success' | 'warning'; text: string } {
  if (request.action === 'add') return { tone: 'success', text: 'Added to the board.' };

  const { run } = result;
  if (typeof run !== 'string') {
    if (run.kind === 'parked') {
      return {
        tone: 'success',
        text: `On the board and queued — ${RUN_REFUSAL_MESSAGE[run.refusal]}`,
      };
    }
    return { tone: 'warning', text: `On the board, but not started: ${run.reason}` };
  }
  if (run === 'started') {
    return { tone: 'success', text: 'Handed to the agent — the run has started.' };
  }
  // 'none' (no assign step reached — should not happen for a 'hand' request) and 'assigned'
  // (an assign that ran with `start: false` — {@link executeHandOffSteps} never passes that)
  // both still read as a card on the board.
  return { tone: 'success', text: 'Added to the board.' };
}
