/**
 * Where a project's work actually runs (Phase: WSL execution target).
 *
 * WHY THIS EXISTS
 * ---------------
 * The app has always assumed one machine: `claude`, `git` and the project files
 * all live wherever the GUI runs. That breaks for Linux-only work — Yocto/bitbake,
 * services built for a Linux image — which you want to drive from a native Windows
 * window while everything *executes* inside WSL.
 *
 * Rather than sprinkle `if (wsl)` through the scheduler, every outbound command and
 * every path translation goes through an `ExecHost`. There are two implementations:
 * `LocalExecHost` (today's behavior, byte for byte) and `WslExecHost`. A project
 * carries its target, so a Windows repo and a WSL repo can sit side by side.
 *
 * The interface is deliberately small: run a command and wait, spawn a long-lived
 * command, translate a path in each direction, and describe how the Claude CLI
 * should spawn our permission relay.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LOCAL_TARGET, type ExecTarget } from '@shared/execTarget';

// The target itself is shared with the renderer (it renders the picker); the host
// that acts on it is main-process only.
export { LOCAL_TARGET, type ExecTarget };

/** A finished command. A non-zero exit is data, not an exception (see `git.ts`). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /**
   * Resolve the command through a shell. On Windows this is the only way to find
   * `claude.cmd` — a PATH shim rather than a real `.exe` — the way a terminal does.
   * Hosts that always run through a login shell (WSL) ignore this.
   */
  resolveViaShell?: boolean;
  /** Kill the command after this long. Undefined = wait indefinitely. */
  timeoutMs?: number;
  /** Max captured output before the command is killed. */
  maxBuffer?: number;
  /**
   * Extra environment variables for this one command, ADDED to the ones this process
   * already has rather than replacing them — a command run with a hand-built environment
   * would lose `PATH`, `HOME` and everything else `git` needs to work at all.
   *
   * It exists for the push: a `git push` that cannot find a credential must FAIL rather
   * than prompt, and the switches that say so (`GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`,
   * `SSH_ASKPASS`) are environment variables with no `-c` equivalent. A prompt in the main
   * process has no window to answer it, so it would hang the app rather than ask anybody.
   *
   * The WSL host has to do real work to honour this — see `WslExecHost.exec` — because
   * variables do NOT cross the Windows→Linux boundary by themselves.
   */
  env?: Record<string, string>;
}

/**
 * A running command plus a way to end it *including its descendants*.
 *
 * Tree termination is the whole reason this wrapper exists. Locally the child is a
 * `cmd.exe` wrapper whose descendants outlive `child.kill()`; under WSL the child is
 * `wsl.exe` on the Windows side, and killing it does not reliably reap the Linux
 * process tree underneath — which matters when a task left a build running.
 * Each host knows how to do this properly for its own platform.
 */
export interface SpawnedProcess {
  /** The underlying process. Callers own its streams exactly as before. */
  readonly child: ChildProcessWithoutNullStreams;
  /** Terminate the command and everything it spawned. */
  terminate(): void;
}

/** How the Claude CLI should spawn our MCP permission relay for one session. */
export interface RelaySpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What the relay needs to phone home to the in-app broker. */
export interface RelaySpecInput {
  brokerUrl: string;
  token: string;
  runId: string;
  /** Path (as this process sees it) to the materialized `permission-server.cjs`. */
  serverScriptPath: string;
}

export interface ExecHost {
  readonly target: ExecTarget;

  /** Run one command to completion in `cwd`, capturing output and the exit code. */
  exec(cwd: string, file: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Start a long-lived command in `cwd` (the Claude session). */
  spawn(cwd: string, file: string, args: string[], opts?: ExecOptions): SpawnedProcess;

  /**
   * A path as this process sees it -> the same path as the HOST sees it.
   * Local: unchanged. WSL: `C:\x` -> `/mnt/c/x`.
   */
  toNative(path: string): string;

  /**
   * A path as the HOST sees it -> a path this process can hand to `fs`.
   * Local: unchanged. WSL: `/home/u/x` -> `\\wsl.localhost\<distro>\home\u\x`.
   */
  toApp(path: string): string;

  /** How the CLI should spawn the permission relay when running on this host. */
  relaySpec(input: RelaySpecInput): RelaySpec;

  /** The user's home directory on this host, used to site data we own. */
  homeDir(): Promise<string>;
}
