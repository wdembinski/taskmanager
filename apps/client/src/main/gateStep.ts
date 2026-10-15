/**
 * Dispatching a **gate** step of a card's chain — running its command and acting on the
 * outcome (F8.6). `gateRunner.ts` only knows how to run one command honestly; this module
 * is the engine that decides what a gate's result means for the chain: pass, loop an
 * earlier agent step back for another attempt, or fail and hand the human an inbox item.
 *
 * Deps-injected the same way `chainRunner.ts` and `automationRunner.ts` are — every effect
 * on the world (the store, the timeline, the exec host, the scheduler's own "step
 * finished"/"step failed" machinery) is a thunk on {@link GateStepDeps} rather than a direct
 * call, so the whole loop is testable with fakes and without a running `Scheduler`. The
 * scheduler owns one {@link GateStepRunner} and calls into it the way it calls into
 * `ChainRunner` — this file never reaches back into `scheduler.ts` itself.
 */
import type { Task } from '@shared/model';
import {
  boundOutputTail,
  decideGateOutcome,
  GATE_FAILURE_NOTE_TAIL_BYTES,
  isGateStep,
  type GateFailReason,
  type GateStep,
  type ResolvedGateOnFail,
} from '@shared/workflow';
import type { GateRun, GateRunnerDeps, GateRunnerResult, GateRunRequest } from './gateRunner';
import { startGate as runGateCommand } from './gateRunner';
import type { ExecHost } from './exec/types';

/** A gate step's own `stepSpec`, narrowed from `Task.stepSpec`'s looser `WorkflowStep | null`.
 *  Every gate task's snapshot is actually written from `instantiateWorkflow`'s `StepSpec`,
 *  whose `onFail` (when present) is a {@link ResolvedGateOnFail} carrying `retryFromIndex` —
 *  a field `GateStep.onFail`'s own type doesn't declare, hence the cast. */
type GateSpec = GateStep & { onFail?: ResolvedGateOnFail };

function gateSpec(task: Task): GateSpec | undefined {
  const spec = task.stepSpec;
  if (!spec || !isGateStep(spec)) return undefined;
  return spec as GateSpec;
}

function gateCommand(task: Task): string {
  return gateSpec(task)?.command ?? '';
}

/** Appends a bounded output tail to a sentence, or leaves it alone when there is none. */
function withOutputTail(sentence: string, output: string): string {
  return output ? `${sentence}\n\n${output}` : sentence;
}

/** This gate's siblings instantiated from the SAME workflow application — the group
 *  `onFail.retryFromIndex` is a position within, and the group a retry's reset range is
 *  drawn from. Ordered the way steps always run: by `order`. */
function stepsInRound(siblings: readonly Task[], gate: Task): Task[] {
  return siblings
    .filter((t) => t.workflowId === gate.workflowId && t.planRound === gate.planRound)
    .sort((a, b) => a.order - b.order);
}

export type RetryTargetResult = { ok: true; resetIds: string[] } | { ok: false; reason: string };

/**
 * Where a failed gate's retry loop lands, and which steps a reset has to touch to replay
 * it — pure, so it can be exercised without a runner. `resetIds` runs from the target
 * through the gate itself, in sibling order: the gate is always its own range's last entry,
 * because resetting it back to `pending` is what lets the chain run it again once the
 * agent step ahead of it has redone its work.
 *
 * Fails named, not just tagged (`missing-target`/`target-after-gate` in the design, said as
 * sentences here) because a workflow can be edited or its steps reordered after a card was
 * already applied from it — the two ways `onFail.retryFromIndex` can stop pointing at a
 * real, earlier step.
 */
export function resolveRetryTarget(siblings: readonly Task[], gate: Task): RetryTargetResult {
  const onFail = gateSpec(gate)?.onFail;
  const round = stepsInRound(siblings, gate);
  const gateIndex = round.findIndex((t) => t.id === gate.id);
  const target = onFail ? round[onFail.retryFromIndex] : undefined;
  if (!target) {
    return {
      ok: false,
      reason:
        `Gate step "${gate.title}" could not find the step to retry — it may have been ` +
        `removed since this workflow was applied.`,
    };
  }
  const targetIndex = round.indexOf(target);
  if (gateIndex === -1 || targetIndex >= gateIndex) {
    return {
      ok: false,
      reason:
        `Gate step "${gate.title}" cannot retry "${target.title}" — it now comes after ` +
        `the gate, not before it.`,
    };
  }
  return { ok: true, resetIds: round.slice(targetIndex, gateIndex + 1).map((t) => t.id) };
}

/** A sentence for a `fail` outcome's reason, said once here rather than re-derived by
 *  every caller of `raiseFailure`. */
function failReasonSentence(reason: GateFailReason, task: Task, exitCode: number | null): string {
  switch (reason) {
    case 'no-on-fail':
      return 'The command failed and this gate has no retry configured.';
    case 'timeout':
      return 'The command timed out.';
    case 'no-exit-code':
      return 'The command never produced an exit code.';
    case 'non-retryable-code':
      return `Exit code ${exitCode} is not one of the codes this gate retries on.`;
    case 'attempts-exhausted':
      return `All ${gateSpec(task)?.onFail?.maxAttempts ?? 0} retry attempts have been used.`;
  }
}

/** What `raiseFailure` is told about a gate step that is failing outright. `landing` is
 *  whatever `prepare` had already resolved before the failure, when there was any — carried
 *  through so a human resolution raised on it (the inbox's "Skip gate") can still land the
 *  chain's branch the same way a passing gate would have. */
export interface GateFailureInfo<Landing = unknown> {
  task: Task;
  reason: string;
  command: string;
  exitCode: number | null;
  output: string;
  landing?: Landing;
}

/** What `prepare` hands back for a gate ready to run, or the reason it is not. `Landing` is
 *  opaque to this module — whatever the scheduler's own "step done" ending needs, carried
 *  through unread from `prepare` to `finishStep`. */
export type GatePrepResult<Landing> =
  { cwd: string; host: ExecHost; landing?: Landing } | { error: string };

/** Everything {@link GateStepRunner} needs from the running app. */
export interface GateStepDeps<Landing = unknown> {
  getTask(id: string): Task | undefined;
  getSubtasks(parentId: string): Task[];
  setStatus(id: string, status: Task['status']): void;
  /** The one writer of `Task.gateAttempts` — see `store.setTaskGateAttempts`. */
  setGateAttempts(id: string, attempts: number): void;
  /** Queues the context the step's next run resumes with — see `fixNotes`/`FAILURE_ACTION.aiFix`. */
  setFailureNote(id: string, note: string): void;
  /** Files a note on the card's own timeline. */
  note(task: Task, text: string): void;
  /** Resolve the worktree/host a gate's command runs through, or why it cannot — async, like
   *  `WorktreeManager.prepare` itself, which is what the scheduler's own thunk calls. */
  prepare(task: Task): Promise<GatePrepResult<Landing>>;
  /** Defaults to `gateRunner.startGate`; overridden in tests with a fake `GateRun`. */
  startGate?: (host: ExecHost, req: GateRunRequest, deps?: GateRunnerDeps) => GateRun;
  /** Park this gate step in the inbox as a failure the human must resolve. */
  raiseFailure(info: GateFailureInfo<Landing>): void;
  /** Start the next pending step of this chain — `Scheduler.advanceSubtasks`. */
  advance(parentId: string): void;
  /** The chain's "this card's steps are all done" ending — `Scheduler.finishParentChain`. */
  finishStep(task: Task, landing?: Landing): void;
}

/**
 * Owns every in-flight gate command, the way the scheduler owns one `ChainRunner` — a
 * single instance per app, called into whenever a gate step starts, stops, or needs
 * reconciling after a restart.
 *
 * The running set is in-memory only, deliberately: it exists solely to refuse a double
 * `start()` and to answer `isRunning`, not to survive a restart — a gate found `running` in
 * the DB with nothing in this map is exactly what {@link GateStepRunner.reconcile} is for.
 */
export class GateStepRunner<Landing = unknown> {
  /**
   * `'starting'` reserves a slot for the span of the (async) `prepare()` call, before there
   * is any `GateRun` to hold — so `isRunning`/a second `start()` sees this step as already
   * running for the WHOLE window, not just once its command has actually spawned. Without
   * this, two calls arriving before the first's `prepare()` resolves (the outer scheduler's
   * own guards are keyed off `isRunning`) would both pass the check below and spawn the
   * command twice.
   */
  private readonly running = new Map<string, GateRun | 'starting'>();

  constructor(private readonly deps: GateStepDeps<Landing>) {}

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  /** Run a gate step's command. A no-op if it is already running — the guard that keeps a
   *  second `advanceSubtasks`/reconcile pass from spawning the command twice. */
  async start(task: Task): Promise<void> {
    if (this.running.has(task.id)) return;
    this.running.set(task.id, 'starting');
    this.deps.setStatus(task.id, 'running');

    const prep = await this.deps.prepare(task);
    // `stop()` may have landed while `prepare()` was still in flight — there was no
    // `GateRun` yet for it to terminate, so it dropped the reservation instead (see `stop`).
    // Honour that now rather than spawning a command nobody wants anymore.
    if (!this.running.has(task.id)) return;
    if ('error' in prep) {
      this.running.delete(task.id);
      this.deps.setStatus(task.id, 'failed');
      this.deps.raiseFailure({
        task,
        reason: prep.error,
        command: gateCommand(task),
        exitCode: null,
        output: '',
      });
      return;
    }

    const startGate = this.deps.startGate ?? runGateCommand;
    const run = startGate(prep.host, { command: gateCommand(task), cwd: prep.cwd });
    this.running.set(task.id, run);
    void run.result.then((result) => {
      this.running.delete(task.id);
      this.settle(task, result, prep.landing);
    });
  }

  /** Stop a running gate's command. A no-op if nothing is running for this id. */
  stop(id: string): void {
    const run = this.running.get(id);
    if (run === undefined) return;
    if (run === 'starting') {
      // Nothing spawned yet to terminate — drop the reservation; `start` checks for exactly
      // that once its `prepare()` resolves, and writes the status itself since no `GateRun`
      // will ever settle to do it.
      this.running.delete(id);
      this.deps.setStatus(id, 'stopped');
      return;
    }
    run.stop();
  }

  /**
   * The gate's half of boot reconcile: found `running` with nothing in this map, which
   * means the app closed mid-run. A gate is a check with no state of its own to have lost,
   * so re-running it is always safe — unlike an agent step, which keeps today's "leave it
   * for the human" behaviour.
   */
  reconcile(task: Task): void {
    this.deps.note(task, 'the app closed while this gate was running — running it again');
    void this.start(task);
  }

  /** The inbox's **Send back to agent** on a gate that has already failed — see the
   *  module-level {@link sendBack} this delegates to. A method (rather than the scheduler
   *  importing the free function itself) so `Scheduler` only ever reaches the gate through
   *  this one object, the same way it only ever reaches `ChainRunner` through `this.chain`. */
  sendBack(task: Task): void {
    sendBack(this.deps, task);
  }

  /** What a settled run means for the chain — every branch writes a status, per
   *  `a-step-that-never-stops-running`. */
  private settle(task: Task, result: GateRunnerResult, landing?: Landing): void {
    if (result.stopped) {
      this.deps.setStatus(task.id, 'stopped');
      return;
    }

    const command = gateCommand(task);

    if (result.error) {
      this.deps.setStatus(task.id, 'failed');
      this.deps.raiseFailure({
        task,
        reason: result.error.message,
        command,
        exitCode: result.exitCode,
        output: result.output,
        landing,
      });
      return;
    }

    const outcome = decideGateOutcome({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      attemptsUsed: task.gateAttempts ?? 0,
      onFail: gateSpec(task)?.onFail,
    });

    if (outcome.kind === 'pass') {
      this.deps.setStatus(task.id, 'done');
      const parentId = task.parentTaskId;
      const siblings = parentId ? this.deps.getSubtasks(parentId) : [];
      const hasPendingSibling = siblings.some((s) => s.id !== task.id && s.status === 'pending');
      if (parentId && hasPendingSibling) this.deps.advance(parentId);
      else this.deps.finishStep(task, landing);
      return;
    }

    if (outcome.kind === 'retry') {
      const parentId = task.parentTaskId;
      const siblings = parentId ? this.deps.getSubtasks(parentId) : [];
      const resolved = resolveRetryTarget(siblings, task);
      if (!resolved.ok) {
        this.deps.setStatus(task.id, 'failed');
        this.deps.raiseFailure({
          task,
          reason: resolved.reason,
          command,
          exitCode: result.exitCode,
          output: result.output,
          landing,
        });
        return;
      }
      this.deps.setGateAttempts(task.id, (task.gateAttempts ?? 0) + 1);
      for (const id of resolved.resetIds) this.deps.setStatus(id, 'pending');
      const targetId = resolved.resetIds[0];
      this.deps.setFailureNote(
        targetId,
        boundOutputTail(result.output, GATE_FAILURE_NOTE_TAIL_BYTES),
      );
      const stepNumber = stepsInRound(siblings, task).findIndex((t) => t.id === targetId) + 1;
      this.deps.note(
        task,
        withOutputTail(
          `"${command}" failed (exit ${result.exitCode}) — sending step ${stepNumber} back ` +
            `(attempt ${outcome.attempt}/${outcome.maxAttempts}).`,
          result.output,
        ),
      );
      if (parentId) this.deps.advance(parentId);
      return;
    }

    // outcome.kind === 'fail' — the chain's existing contract: siblings stay pending until
    // the human resolves the inbox item `raiseFailure` raises.
    this.deps.setStatus(task.id, 'failed');
    this.deps.raiseFailure({
      task,
      reason: failReasonSentence(outcome.reason, task, result.exitCode),
      command,
      exitCode: result.exitCode,
      output: result.output,
      landing,
    });
  }
}

/**
 * Loop one more time past a gate's own attempt budget — the inbox's **Send back to agent**
 * action on a gate that has already failed. Deliberately outside `GateStepRunner`: nothing
 * here runs a command or touches `running`, it only resets the same range a retry would and
 * says so, with no `decideGateOutcome` in the way to refuse it for being over budget.
 */
export function sendBack<Landing>(deps: GateStepDeps<Landing>, task: Task): void {
  const parentId = task.parentTaskId;
  if (!parentId) return;
  const siblings = deps.getSubtasks(parentId);
  const resolved = resolveRetryTarget(siblings, task);
  if (!resolved.ok) {
    deps.setStatus(task.id, 'failed');
    deps.raiseFailure({
      task,
      reason: resolved.reason,
      command: gateCommand(task),
      exitCode: null,
      output: '',
    });
    return;
  }
  for (const id of resolved.resetIds) deps.setStatus(id, 'pending');
  const targetId = resolved.resetIds[0];
  const stepNumber = stepsInRound(siblings, task).findIndex((t) => t.id === targetId) + 1;
  deps.note(task, `Sent back to step ${stepNumber} by hand for one more attempt.`);
  deps.advance(parentId);
}
