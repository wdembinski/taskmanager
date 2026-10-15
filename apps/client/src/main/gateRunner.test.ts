/**
 * Unit tests for `gateRunner`, against a fake `ExecHost` whose child is a plain
 * `EventEmitter` with `PassThrough` stdin/stdout/stderr — the same seam
 * `claudeSession.test.ts`'s `fakeHost` (search "session isolation") uses to drive a
 * CLI run without spawning anything real.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { decideGateOutcome } from '@shared/workflow';
import { gateShell, runGate, startGate } from './gateRunner';
import type { ExecHost, ExecOptions, ExecTarget, SpawnedProcess } from './exec/types';
import { LOCAL_TARGET } from './exec/types';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

interface SpawnCall {
  cwd: string;
  file: string;
  args: string[];
  opts?: ExecOptions;
}

/**
 * `terminate` mirrors a real process by default: calling it eventually produces the
 * child's own `close` event (`null`, `'SIGTERM'`), exactly like a killed process would —
 * so a test driving `stop()` or a timeout doesn't also have to hand-emit `close`. The
 * spawn-error-via-`error`-event test below passes a plain `vi.fn()` instead, since there
 * `terminate` firing `close` synchronously (before the real process ever would) would
 * race the handler's own `settle()` call.
 */
function fakeHost(
  opts: {
    target?: ExecTarget;
    terminate?: ReturnType<typeof vi.fn>;
    spawnError?: Error;
  } = {},
): {
  host: ExecHost;
  child: FakeChild;
  terminate: ReturnType<typeof vi.fn>;
  spawnCalls: SpawnCall[];
} {
  const child = makeFakeChild();
  const terminate = opts.terminate ?? vi.fn(() => child.emit('close', null, 'SIGTERM'));
  const spawnCalls: SpawnCall[] = [];
  const host: ExecHost = {
    target: opts.target ?? LOCAL_TARGET,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (cwd: string, file: string, args: string[], spawnOpts?: ExecOptions): SpawnedProcess => {
      spawnCalls.push({ cwd, file, args, opts: spawnOpts });
      if (opts.spawnError) throw opts.spawnError;
      return { child: child as unknown as ChildProcessWithoutNullStreams, terminate };
    },
    toNative: (p: string) => p,
    toApp: (p: string) => p,
    relaySpec: () => ({ command: '', args: [], env: {} }),
    homeDir: async () => '/home/test',
  };
  return { host, child, terminate, spawnCalls };
}

/** The worktree-existence check isn't under test in most of these cases, so they
 *  short-circuit it rather than relying on `/work` existing on the real filesystem. */
const okDeps = { exists: () => true };

describe('runGate', () => {
  it('resolves exitCode 0 with no error, capturing output from both streams', async () => {
    const { host, child } = fakeHost();
    const promise = runGate(host, { command: 'echo ok', cwd: '/work' }, okDeps);
    child.stdout.emit('data', 'out\n');
    child.stderr.emit('data', 'err\n');
    child.emit('close', 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');

    expect(
      decideGateOutcome({ exitCode: result.exitCode, timedOut: result.timedOut, attemptsUsed: 0 }),
    ).toEqual({ kind: 'pass' });
  });

  it('passes exit code 1 through, and decideGateOutcome retries it when the gate allows', async () => {
    const { host, child } = fakeHost();
    const promise = runGate(host, { command: 'fail', cwd: '/work' }, okDeps);
    child.emit('close', 1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeNull();

    const outcome = decideGateOutcome({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      attemptsUsed: 0,
      onFail: { retryFrom: 'step-a', maxAttempts: 2 },
    });
    expect(outcome).toEqual({ kind: 'retry', retryFrom: 'step-a', attempt: 1, maxAttempts: 2 });
  });

  it('passes exit code 2 through, and decideGateOutcome retries it when that code is listed', async () => {
    const { host, child } = fakeHost();
    const promise = runGate(host, { command: 'fail', cwd: '/work' }, okDeps);
    child.emit('close', 2);

    const result = await promise;
    expect(result.exitCode).toBe(2);
    expect(result.error).toBeNull();

    const outcome = decideGateOutcome({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      attemptsUsed: 0,
      onFail: { retryFrom: 'step-a', maxAttempts: 2, retryOn: [2] },
    });
    expect(outcome).toEqual({ kind: 'retry', retryFrom: 'step-a', attempt: 1, maxAttempts: 2 });
  });

  it('terminates once and settles timedOut with exitCode null on a timeout', async () => {
    vi.useFakeTimers();
    try {
      const { host, terminate } = fakeHost();
      const promise = runGate(
        host,
        { command: 'sleep 999', cwd: '/work', timeoutMs: 5000 },
        okDeps,
      );

      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;

      expect(terminate).toHaveBeenCalledTimes(1);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() terminates once and settles stopped with exitCode null; a later stop() is a no-op', async () => {
    const { host, terminate } = fakeHost();
    const run = startGate(host, { command: 'sleep 999', cwd: '/work' }, okDeps);

    run.stop();
    const result = await run.result;

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.error).toBeNull();

    run.stop();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('resolves missing-cwd without spawning, checking existence via host.toApp', async () => {
    const { host, spawnCalls } = fakeHost();
    host.toApp = (p: string) => `APP:${p}`;
    const exists = vi.fn().mockReturnValue(false);

    const result = await runGate(host, { command: 'echo hi', cwd: '/work' }, { exists });

    expect(exists).toHaveBeenCalledWith('APP:/work');
    expect(result.error).toEqual({
      kind: 'missing-cwd',
      message: expect.stringContaining('/work'),
    });
    expect(result.exitCode).toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  it('resolves spawn-error when host.spawn throws, without a child ever existing', async () => {
    const { host, spawnCalls } = fakeHost({ spawnError: new Error('ENOENT') });

    const result = await runGate(host, { command: 'echo hi', cwd: '/work' }, okDeps);

    expect(result.error).toEqual({ kind: 'spawn-error', message: 'ENOENT' });
    expect(result.exitCode).toBeNull();
    expect(spawnCalls).toHaveLength(1);
  });

  it('settles exactly one spawn-error result when the child emits error then close', async () => {
    const terminate = vi.fn();
    const { host, child } = fakeHost({ terminate });
    const promise = runGate(host, { command: 'echo hi', cwd: '/work' }, okDeps);

    child.emit('error', new Error('boom'));
    child.emit('close', 1);

    const result = await promise;
    expect(result.error).toEqual({ kind: 'spawn-error', message: 'boom' });
    expect(result.exitCode).toBeNull();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('bounds huge output to the tail budget, keeping the last bytes and stripping ORCH_PID', async () => {
    const { host, child } = fakeHost();
    const promise = runGate(host, { command: 'noisy', cwd: '/work' }, okDeps);

    const chunk = `ORCH_PID:4242\n${'a'.repeat(40_000)}TAIL_MARKER_END`;
    child.stdout.emit('data', chunk);
    child.emit('close', 0);

    const result = await promise;
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(result.output).not.toContain('ORCH_PID');
    expect(result.output.endsWith('TAIL_MARKER_END')).toBe(true);
  });

  it('forwards stripped chunks to onOutput as they arrive', async () => {
    const chunks: string[] = [];
    const { host, child } = fakeHost();
    const promise = runGate(
      host,
      {
        command: 'echo',
        cwd: '/work',
        onOutput: (chunk) => chunks.push(chunk),
      },
      okDeps,
    );

    child.stdout.emit('data', 'ORCH_PID:999\nhello\n');
    child.stderr.emit('data', 'world\n');
    child.emit('close', 0);
    await promise;

    expect(chunks).toEqual(['hello\n', 'world\n']);
  });
});

describe('gateShell', () => {
  it('wsl targets always run through a login shell', () => {
    const shell = gateShell({ kind: 'wsl', distro: 'Ubuntu' }, 'npm test');
    expect(shell).toEqual({ file: 'bash', args: ['-lc', 'npm test'], resolveViaShell: false });
  });

  it('local win32 runs the command as a bare file, resolved via the shell', () => {
    const shell = gateShell(LOCAL_TARGET, 'npm test', 'win32');
    expect(shell).toEqual({ file: 'npm test', args: [], resolveViaShell: true });
  });

  it('local linux runs through a login shell', () => {
    const shell = gateShell(LOCAL_TARGET, 'npm test', 'linux');
    expect(shell).toEqual({ file: 'bash', args: ['-lc', 'npm test'], resolveViaShell: false });
  });
});
