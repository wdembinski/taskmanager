/**
 * Unit tests for `gateStep` — every dependency is a fake per `GateStepDeps`, and a gate's
 * command run is a fake `GateRun` whose `result` promise is resolved by hand, so none of
 * this touches a real `ExecHost` or spawns anything (that seam is `gateRunner.test.ts`'s).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/model';
import type { GateOnFail } from '@shared/workflow';
import type { GateRun, GateRunnerResult } from './gateRunner';
import {
  GateStepRunner,
  resolveRetryTarget,
  sendBack,
  type GateFailureInfo,
  type GateStepDeps,
} from './gateStep';

const PARENT_ID = 'card-1';

/** A gate's stored `onFail`, with `retryFromIndex` — the field `instantiateWorkflow`
 *  resolves it to, which `GateOnFail`'s own declared type doesn't carry (see `gateStep.ts`'s
 *  `GateSpec`). Fixtures go through this rather than a bare literal so the extra field isn't
 *  flagged as excess on a `Task['stepSpec']`-typed object literal. */
function resolvedOnFail(fields: {
  retryFrom: string;
  maxAttempts: number;
  retryOn?: number[];
  retryFromIndex: number;
}): GateOnFail {
  return fields as unknown as GateOnFail;
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'step',
    projectId: 'proj-1',
    phase: '',
    title: 'Step',
    status: 'pending',
    sessionId: null,
    order: 0,
    source: 'adhoc',
    dependsOn: [],
    isContract: false,
    isScaffold: false,
    parentTaskId: PARENT_ID,
    workflowId: 'wf-1',
    planRound: 1,
    ...overrides,
  };
}

/** The agent step a gate's `onFail` retries from — `stepSpec.id` is the workflow's own
 *  step id ('a1'), matched by `onFail.retryFrom` (unused by `resolveRetryTarget` itself,
 *  which goes by `retryFromIndex`, but kept for a faithful fixture). */
function agentStepTask(overrides: Partial<Task> = {}): Task {
  return baseTask({
    id: 'agent-1',
    title: 'Implement',
    order: 0,
    status: 'done',
    stepSpec: { id: 'a1', kind: 'agent', title: 'Implement', brief: 'Do the thing.' },
    ...overrides,
  });
}

function gateStepTask(overrides: Partial<Task> = {}): Task {
  return baseTask({
    id: 'gate-1',
    title: 'Run tests',
    order: 1,
    status: 'running',
    gateAttempts: 0,
    stepSpec: {
      id: 'g1',
      kind: 'gate',
      title: 'Run tests',
      command: 'pnpm test',
      onFail: resolvedOnFail({ retryFrom: 'a1', maxAttempts: 3, retryFromIndex: 0 }),
    },
    ...overrides,
  });
}

function gateResult(overrides: Partial<GateRunnerResult> = {}): GateRunnerResult {
  return {
    exitCode: 0,
    timedOut: false,
    stopped: false,
    error: null,
    output: '',
    durationMs: 10,
    ...overrides,
  };
}

interface Calls {
  setStatus: Array<{ id: string; status: Task['status'] }>;
  setGateAttempts: Array<{ id: string; attempts: number }>;
  setFailureNote: Array<{ id: string; note: string }>;
  note: Array<{ taskId: string; text: string }>;
  raiseFailure: GateFailureInfo[];
  advance: string[];
  finishStep: Array<{ taskId: string; landing: unknown }>;
}

function makeDeps(
  opts: {
    siblings?: Task[];
    prepLanding?: unknown;
    prepError?: string;
  } = {},
): { deps: GateStepDeps; calls: Calls } {
  const siblings = opts.siblings ?? [];
  const calls: Calls = {
    setStatus: [],
    setGateAttempts: [],
    setFailureNote: [],
    note: [],
    raiseFailure: [],
    advance: [],
    finishStep: [],
  };
  const deps: GateStepDeps = {
    getTask: (id) => siblings.find((t) => t.id === id),
    getSubtasks: () => siblings,
    setStatus: (id, status) => calls.setStatus.push({ id, status }),
    setGateAttempts: (id, attempts) => calls.setGateAttempts.push({ id, attempts }),
    setFailureNote: (id, note) => calls.setFailureNote.push({ id, note }),
    note: (task, text) => calls.note.push({ taskId: task.id, text }),
    prepare: () =>
      Promise.resolve(
        opts.prepError !== undefined
          ? { error: opts.prepError }
          : { cwd: '/work', host: {} as never, landing: opts.prepLanding },
      ),
    raiseFailure: (info) => calls.raiseFailure.push(info),
    advance: (parentId) => calls.advance.push(parentId),
    finishStep: (task, landing) => calls.finishStep.push({ taskId: task.id, landing }),
  };
  return { deps, calls };
}

/** Starts the gate, hands back the `GateRun` the fake `startGate` produced, and resolves
 *  it with `result` — awaiting `start()` first guarantees `settle` is already `.then`'d onto
 *  `run.result` (attached synchronously inside `start`, once its own `await prepare()` has
 *  resolved), so the SECOND await here, of the same already-resolved promise, always runs
 *  after it: two handlers on one promise fire in the order they were attached. */
async function runToSettled(
  deps: GateStepDeps,
  task: Task,
  result: GateRunnerResult,
): Promise<{ runner: GateStepRunner; startGate: ReturnType<typeof vi.fn> }> {
  const run: GateRun = { result: Promise.resolve(result), stop: vi.fn() };
  const startGate = vi.fn(() => run);
  deps.startGate = startGate;
  const runner = new GateStepRunner(deps);
  await runner.start(task);
  await run.result;
  return { runner, startGate };
}

describe('GateStepRunner.start → pass', () => {
  it('advances the chain when a sibling is still pending', async () => {
    const siblings = [
      agentStepTask(),
      gateStepTask(),
      baseTask({ id: 'agent-2', title: 'Review', order: 2, status: 'pending' }),
    ];
    const { deps, calls } = makeDeps({ siblings });
    await runToSettled(deps, gateStepTask(), gateResult({ exitCode: 0 }));

    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'running' });
    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'done' });
    expect(calls.advance).toEqual([PARENT_ID]);
    expect(calls.finishStep).toEqual([]);
  });

  it('finishes the step with the landing prepare produced, as the last step', async () => {
    const siblings = [agentStepTask(), gateStepTask()];
    const landing = { branch: 'feat/x', base: 'main' };
    const { deps, calls } = makeDeps({ siblings, prepLanding: landing });
    await runToSettled(deps, gateStepTask(), gateResult({ exitCode: 0 }));

    expect(calls.advance).toEqual([]);
    expect(calls.finishStep).toEqual([{ taskId: 'gate-1', landing }]);
  });
});

describe('GateStepRunner.start → retry', () => {
  it('bumps gateAttempts, resets the target through the gate, bounds the note, and advances', async () => {
    const siblings = [agentStepTask(), gateStepTask()];
    const { deps, calls } = makeDeps({ siblings });
    await runToSettled(
      deps,
      gateStepTask(),
      gateResult({ exitCode: 1, output: 'FAIL: 2 tests failed' }),
    );

    expect(calls.setGateAttempts).toEqual([{ id: 'gate-1', attempts: 1 }]);
    expect(calls.setStatus).toContainEqual({ id: 'agent-1', status: 'pending' });
    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'pending' });
    expect(calls.setFailureNote).toEqual([{ id: 'agent-1', note: 'FAIL: 2 tests failed' }]);
    expect(calls.note).toHaveLength(1);
    expect(calls.note[0].text).toContain('"pnpm test" failed (exit 1)');
    expect(calls.note[0].text).toContain('sending step 1 back (attempt 1/3)');
    expect(calls.note[0].text).toContain('FAIL: 2 tests failed');
    expect(calls.advance).toEqual([PARENT_ID]);
    expect(calls.raiseFailure).toEqual([]);
  });

  it('fails the gate instead of retrying when the resolved target is missing', async () => {
    const brokenGate = gateStepTask({
      stepSpec: {
        id: 'g1',
        kind: 'gate',
        title: 'Run tests',
        command: 'pnpm test',
        onFail: resolvedOnFail({ retryFrom: 'a1', maxAttempts: 3, retryFromIndex: 9 }),
      },
    });
    const siblings = [agentStepTask(), brokenGate];
    const { deps, calls } = makeDeps({ siblings });
    await runToSettled(deps, brokenGate, gateResult({ exitCode: 1 }));

    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'failed' });
    expect(calls.raiseFailure).toHaveLength(1);
    expect(calls.raiseFailure[0].reason).toContain('could not find the step to retry');
    expect(calls.setGateAttempts).toEqual([]);
    expect(calls.advance).toEqual([]);
  });
});

describe('GateStepRunner.start → fail', () => {
  it('fails with "no-on-fail" when the gate has no retry configured', async () => {
    const gate = gateStepTask({
      stepSpec: { id: 'g1', kind: 'gate', title: 'Run tests', command: 'pnpm test' },
    });
    const { deps, calls } = makeDeps({ siblings: [gate] });
    await runToSettled(deps, gate, gateResult({ exitCode: 1 }));

    expect(calls.raiseFailure[0]).toMatchObject({
      reason: 'The command failed and this gate has no retry configured.',
      command: 'pnpm test',
      exitCode: 1,
    });
  });

  it('fails with "attempts-exhausted" once the budget is spent', async () => {
    const gate = gateStepTask({
      gateAttempts: 2,
      stepSpec: {
        id: 'g1',
        kind: 'gate',
        title: 'Run tests',
        command: 'pnpm test',
        onFail: resolvedOnFail({ retryFrom: 'a1', maxAttempts: 2, retryFromIndex: 0 }),
      },
    });
    const { deps, calls } = makeDeps({ siblings: [agentStepTask(), gate] });
    await runToSettled(deps, gate, gateResult({ exitCode: 1 }));

    expect(calls.raiseFailure[0].reason).toBe('All 2 retry attempts have been used.');
  });

  it('fails with "non-retryable-code" when the exit code is not listed', async () => {
    const gate = gateStepTask({
      stepSpec: {
        id: 'g1',
        kind: 'gate',
        title: 'Run tests',
        command: 'pnpm test',
        onFail: resolvedOnFail({
          retryFrom: 'a1',
          maxAttempts: 3,
          retryOn: [2],
          retryFromIndex: 0,
        }),
      },
    });
    const { deps, calls } = makeDeps({ siblings: [agentStepTask(), gate] });
    await runToSettled(deps, gate, gateResult({ exitCode: 1 }));

    expect(calls.raiseFailure[0].reason).toBe(
      'Exit code 1 is not one of the codes this gate retries on.',
    );
  });

  it('fails with "timeout" regardless of exit code', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({ siblings: [agentStepTask(), gate] });
    await runToSettled(deps, gate, gateResult({ exitCode: 0, timedOut: true }));

    expect(calls.raiseFailure[0].reason).toBe('The command timed out.');
  });
});

describe('GateStepRunner.start → stopped and prep/run errors', () => {
  it('writes "stopped" with no failure raised', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({ siblings: [gate] });
    await runToSettled(deps, gate, gateResult({ stopped: true, exitCode: null }));

    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'stopped' });
    expect(calls.raiseFailure).toEqual([]);
  });

  it('fails on a missing-cwd error from the run', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({ siblings: [gate] });
    await runToSettled(
      deps,
      gate,
      gateResult({
        exitCode: null,
        error: { kind: 'missing-cwd', message: "the card's worktree no longer exists: /work" },
      }),
    );

    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'failed' });
    expect(calls.raiseFailure[0].reason).toBe("the card's worktree no longer exists: /work");
  });

  it('fails on a spawn-error from the run', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({ siblings: [gate] });
    await runToSettled(
      deps,
      gate,
      gateResult({ exitCode: null, error: { kind: 'spawn-error', message: 'ENOENT' } }),
    );

    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'failed' });
    expect(calls.raiseFailure[0].reason).toBe('ENOENT');
  });

  it('fails when prepare itself refuses, without ever starting a run', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({
      siblings: [gate],
      prepError: 'no exec host for this project',
    });
    const startGate = vi.fn();
    deps.startGate = startGate;
    const runner = new GateStepRunner(deps);
    await runner.start(gate);

    expect(startGate).not.toHaveBeenCalled();
    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'failed' });
    expect(calls.raiseFailure[0].reason).toBe('no exec host for this project');
  });
});

describe('GateStepRunner — stop, double-start, reconcile', () => {
  function pendingGateRun(): { run: GateRun; startGate: ReturnType<typeof vi.fn> } {
    const run: GateRun = { result: new Promise(() => {}), stop: vi.fn() };
    const startGate = vi.fn(() => run);
    return { run, startGate };
  }

  it('isRunning is true for the whole async prepare window, before any GateRun exists', () => {
    const gate = gateStepTask();
    const { deps } = makeDeps({ siblings: [gate] });
    const { startGate } = pendingGateRun();
    deps.startGate = startGate;
    const runner = new GateStepRunner(deps);

    void runner.start(gate); // fire-and-forget — `prepare()` has not resolved yet
    expect(runner.isRunning(gate.id)).toBe(true);
    expect(startGate).not.toHaveBeenCalled(); // confirms we're still in the 'starting' window
  });

  it('stop() calls the live GateRun.stop()', async () => {
    const gate = gateStepTask();
    const { deps } = makeDeps({ siblings: [gate] });
    const { run, startGate } = pendingGateRun();
    deps.startGate = startGate;
    const runner = new GateStepRunner(deps);

    await runner.start(gate);
    expect(runner.isRunning(gate.id)).toBe(true);
    runner.stop(gate.id);

    expect(run.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() during the prepare window drops the reservation and writes "stopped" directly', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({ siblings: [gate] });
    const { startGate } = pendingGateRun();
    deps.startGate = startGate;
    const runner = new GateStepRunner(deps);

    const started = runner.start(gate); // still awaiting `prepare()` — nothing spawned yet
    runner.stop(gate.id);
    await started;

    expect(runner.isRunning(gate.id)).toBe(false);
    expect(startGate).not.toHaveBeenCalled(); // the stop beat `prepare()` — never spawned
    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'stopped' });
  });

  it('refuses a second start while the first is still running', async () => {
    const gate = gateStepTask();
    const { deps } = makeDeps({ siblings: [gate] });
    const { startGate } = pendingGateRun();
    deps.startGate = startGate;
    const runner = new GateStepRunner(deps);

    const first = runner.start(gate);
    runner.start(gate); // synchronously reserved already — a true no-op
    await first;

    expect(startGate).toHaveBeenCalledTimes(1);
  });

  it('reconcile notes that it is re-running the gate, then starts it', async () => {
    const gate = gateStepTask();
    const { deps, calls } = makeDeps({ siblings: [gate] });
    const { startGate } = pendingGateRun();
    deps.startGate = startGate;
    const runner = new GateStepRunner(deps);

    runner.reconcile(gate);
    await Promise.resolve(); // let `start`'s internal `await prepare()` resolve

    expect(calls.note).toEqual([
      { taskId: 'gate-1', text: 'the app closed while this gate was running — running it again' },
    ]);
    expect(startGate).toHaveBeenCalledTimes(1);
  });
});

describe('resolveRetryTarget', () => {
  it('resolves the target and the reset range through the gate, in sibling order', () => {
    const siblings = [agentStepTask(), gateStepTask()];
    const result = resolveRetryTarget(siblings, gateStepTask());
    expect(result).toEqual({ ok: true, resetIds: ['agent-1', 'gate-1'] });
  });

  it('reports a missing target by name when retryFromIndex no longer resolves', () => {
    const gate = gateStepTask({
      stepSpec: {
        id: 'g1',
        kind: 'gate',
        title: 'Run tests',
        command: 'pnpm test',
        onFail: resolvedOnFail({ retryFrom: 'a1', maxAttempts: 3, retryFromIndex: 9 }),
      },
    });
    const result = resolveRetryTarget([agentStepTask(), gate], gate);
    expect(result).toEqual({
      ok: false,
      reason:
        'Gate step "Run tests" could not find the step to retry — it may have been removed ' +
        'since this workflow was applied.',
    });
  });

  it('reports the target now sits after the gate when steps were reordered', () => {
    const reorderedGate = gateStepTask({
      order: 0,
      stepSpec: {
        id: 'g1',
        kind: 'gate',
        title: 'Run tests',
        command: 'pnpm test',
        onFail: resolvedOnFail({ retryFrom: 'a1', maxAttempts: 3, retryFromIndex: 1 }),
      },
    });
    const reorderedAgent = agentStepTask({ order: 1 });
    const result = resolveRetryTarget([reorderedGate, reorderedAgent], reorderedGate);
    expect(result).toEqual({
      ok: false,
      reason:
        'Gate step "Run tests" cannot retry "Implement" — it now comes after the gate, not before it.',
    });
  });
});

describe('sendBack', () => {
  it('resets the target through the gate and notes it, ignoring an already-spent budget', () => {
    const gate = gateStepTask({
      status: 'failed',
      gateAttempts: 5,
      stepSpec: {
        id: 'g1',
        kind: 'gate',
        title: 'Run tests',
        command: 'pnpm test',
        onFail: resolvedOnFail({ retryFrom: 'a1', maxAttempts: 3, retryFromIndex: 0 }),
      },
    });
    const siblings = [agentStepTask(), gate];
    const { deps, calls } = makeDeps({ siblings });

    sendBack(deps, gate);

    expect(calls.setStatus).toContainEqual({ id: 'agent-1', status: 'pending' });
    expect(calls.setStatus).toContainEqual({ id: 'gate-1', status: 'pending' });
    expect(calls.note).toEqual([
      { taskId: 'gate-1', text: 'Sent back to step 1 by hand for one more attempt.' },
    ]);
    expect(calls.advance).toEqual([PARENT_ID]);
    expect(calls.setGateAttempts).toEqual([]);
  });
});
