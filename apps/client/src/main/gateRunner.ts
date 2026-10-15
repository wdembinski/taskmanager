/**
 * Running a workflow gate's command in a card's worktree, through the exec host so it
 * works identically whether the card runs locally or in WSL (Phase: F8.5).
 *
 * `decideGateOutcome` (see `@shared/workflow`) already knows what a `GateRunResult`
 * means for the workflow — this module's only job is producing that result honestly:
 * spawn the command, capture its output, and resolve exactly once no matter which of
 * "exited", "timed out", "stopped" or "never started" actually happened.
 */
import { existsSync } from 'node:fs';
import { boundOutputTail, GATE_TIMELINE_TAIL_BYTES } from '@shared/workflow';
import type { ExecHost, ExecTarget, SpawnedProcess } from './exec/types';

/** A gate with no `timeoutMs` of its own waits this long before being killed as hung. */
export const GATE_DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * The WSL spawn wrapper announces the Linux-side pid on stderr (see `wslHost.ts`'s
 * `RUN_SCRIPT_ANNOUNCE_PID`) so it can kill the right process group later. That line is
 * plumbing, not gate output, so it never reaches a timeline or an `onOutput` callback.
 */
const ORCH_PID_LINE = /^ORCH_PID:\d+\r?\n/m;

/** Keep the rolling buffer from growing without bound on a long, chatty command —
 *  trimmed back down to the tail budget once it gets this far past it. */
const GATE_BUFFER_TRIM_BYTES = GATE_TIMELINE_TAIL_BYTES * 2;

/**
 * Which shell runs a gate's command on this host.
 *
 * WSL always goes through a login shell on the Linux side (`host.spawn` itself handles
 * `cd` into `cwd` and announcing the pid — see `wslHost.ts`). Local Windows needs
 * `resolveViaShell` because a bare command string is the only way `cmd.exe` resolves a
 * PATH shim such as a `.cmd`/`.ps1` wrapper the way a terminal would; local elsewhere
 * runs through `bash -lc` for the same reason `wsl` does — PATH entries like nvm's
 * live in a login shell's profile, not in this process' own environment.
 */
export function gateShell(
  target: ExecTarget,
  command: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; resolveViaShell: boolean } {
  if (target.kind === 'wsl')
    return { file: 'bash', args: ['-lc', command], resolveViaShell: false };
  if (platform === 'win32') return { file: command, args: [], resolveViaShell: true };
  return { file: 'bash', args: ['-lc', command], resolveViaShell: false };
}

export interface GateRunRequest {
  /** The gate's own command, exactly as the workflow step stores it. */
  command: string;
  /** The card's worktree, as the HOST sees it (see `ExecHost.toApp`/`toNative`). */
  cwd: string;
  /** Kill the command after this long. Defaults to {@link GATE_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Live output for the timeline, one already-stripped chunk at a time. */
  onOutput?: (chunk: string) => void;
}

export type GateRunError =
  { kind: 'missing-cwd'; message: string } | { kind: 'spawn-error'; message: string };

export interface GateRunnerResult {
  /** `null` means the command never got an exit code — killed, or never started. */
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  error: GateRunError | null;
  /** `boundOutputTail(combined stdout+stderr, GATE_TIMELINE_TAIL_BYTES)`. Callers that
   *  need the shorter failure-note budget trim this further themselves. */
  output: string;
  durationMs: number;
}

export interface GateRun {
  result: Promise<GateRunnerResult>;
  /** Stop the command early. Idempotent; a stop after the run has settled is a no-op. */
  stop(): void;
}

export interface GateRunnerDeps {
  /** Checks the worktree exists before spawning. Default: `existsSync`. */
  exists?: (appPath: string) => boolean;
  /** Clock used for `durationMs`. Default: `Date.now`. */
  now?: () => number;
  /** Overrides `gateShell`'s platform detection (tests only). Default: `process.platform`. */
  platform?: NodeJS.Platform;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

/** A result that settles before anything was ever spawned — `missing-cwd`, or a
 *  `spawn-error` from a `host.spawn` call that threw instead of returning. */
function startedResult(
  now: () => number,
  startedAt: number,
  error: GateRunError,
): GateRunnerResult {
  return {
    exitCode: null,
    timedOut: false,
    stopped: false,
    error,
    output: '',
    durationMs: now() - startedAt,
  };
}

/**
 * Start a gate's command and return a handle to it immediately — `result` settles
 * exactly once, on a timeout, an explicit `stop()`, or the command actually finishing.
 */
export function startGate(host: ExecHost, req: GateRunRequest, deps: GateRunnerDeps = {}): GateRun {
  const exists = deps.exists ?? existsSync;
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  const startedAt = now();
  const timeoutMs = req.timeoutMs ?? GATE_DEFAULT_TIMEOUT_MS;

  if (!exists(host.toApp(req.cwd))) {
    return {
      result: Promise.resolve(
        startedResult(now, startedAt, {
          kind: 'missing-cwd',
          message: `the card's worktree no longer exists: ${req.cwd}`,
        }),
      ),
      stop: () => {},
    };
  }

  const shell = gateShell(host.target, req.command, platform);

  let spawned: SpawnedProcess;
  try {
    spawned = host.spawn(req.cwd, shell.file, shell.args, {
      resolveViaShell: shell.resolveViaShell,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: Promise.resolve(startedResult(now, startedAt, { kind: 'spawn-error', message })),
      stop: () => {},
    };
  }

  const { child, terminate } = spawned;
  child.stdin.end();

  let buffer = '';
  let settled = false;
  let stopped = false;
  let timedOut = false;

  const appendChunk = (chunk: string): void => {
    const stripped = chunk.replace(ORCH_PID_LINE, '');
    if (!stripped) return;
    buffer += stripped;
    if (Buffer.byteLength(buffer, 'utf8') > GATE_BUFFER_TRIM_BYTES) {
      buffer = boundOutputTail(buffer, GATE_TIMELINE_TAIL_BYTES);
    }
    req.onOutput?.(stripped);
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', appendChunk);
  child.stderr.on('data', appendChunk);

  let resolveResult!: (r: GateRunnerResult) => void;
  const result = new Promise<GateRunnerResult>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (exitCode: number | null, error: GateRunError | null): void => {
    if (settled) return;
    settled = true;
    clearTimer(timer);
    resolveResult({
      exitCode,
      timedOut,
      stopped,
      error,
      output: boundOutputTail(buffer, GATE_TIMELINE_TAIL_BYTES),
      durationMs: now() - startedAt,
    });
  };

  const timer = setTimer(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  child.on('error', (err) => {
    // Nothing should still be running after a spawn-time error, but terminate()
    // regardless in case anything (e.g. a partially-started WSL wrapper) was.
    terminate();
    settle(null, { kind: 'spawn-error', message: err.message });
  });

  child.on('close', (code) => settle(code, null));

  return {
    result,
    stop: () => {
      if (settled) return;
      stopped = true;
      terminate();
    },
  };
}

/** `startGate(...).result`, for callers that don't need early `stop()` access. */
export function runGate(
  host: ExecHost,
  req: GateRunRequest,
  deps?: GateRunnerDeps,
): Promise<GateRunnerResult> {
  return startGate(host, req, deps).result;
}
