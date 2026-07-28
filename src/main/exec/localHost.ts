/**
 * Running commands on the machine the GUI runs on — the way this app always has.
 *
 * This is a faithful extraction, not a rewrite: the spawn options, the `shell: true`
 * that lets Windows resolve `claude.cmd` from PATH, the `taskkill /t` tree kill, and
 * the "a non-zero exit is data, not an exception" contract are all exactly what
 * `claudeSession.ts`, `git.ts` and `claudeStatus.ts` did inline before. Any behavior
 * difference here is a bug.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type {
  ExecHost,
  ExecOptions,
  ExecResult,
  ExecTarget,
  RelaySpec,
  RelaySpecInput,
  SpawnedProcess,
} from './types';
import { LOCAL_TARGET } from './types';

const execFileAsync = promisify(execFile);

export class LocalExecHost implements ExecHost {
  readonly target: ExecTarget = LOCAL_TARGET;

  async exec(
    cwd: string,
    file: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd,
        windowsHide: true,
        shell: opts.resolveViaShell,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      // A failed command is an ordinary outcome (a dirty tree, a missing binary),
      // so the exit code is returned rather than thrown. `code` is a string like
      // 'ENOENT' when the process never started at all.
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
      };
    }
  }

  spawn(cwd: string, file: string, args: string[], opts: ExecOptions = {}): SpawnedProcess {
    const child = spawn(file, args, {
      cwd,
      shell: opts.resolveViaShell,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    return { child, terminate: () => terminateTree(child) };
  }

  /** Local paths need no translation — both names are the same name. */
  toNative(path: string): string {
    return path;
  }

  toApp(path: string): string {
    return path;
  }

  /**
   * The relay runs under Electron-as-Node, carrying the broker URL/token/runId in
   * its env so it can phone home over loopback.
   */
  relaySpec(input: RelaySpecInput): RelaySpec {
    return {
      command: process.execPath,
      args: [input.serverScriptPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ORCH_BROKER_URL: input.brokerUrl,
        ORCH_TOKEN: input.token,
        ORCH_RUN_ID: input.runId,
      },
    };
  }

  async homeDir(): Promise<string> {
    return homedir();
  }
}

/**
 * End a process and everything under it.
 *
 * With `shell: true` the child is the `cmd.exe` wrapper, and the real command (node,
 * and any subprocess an agent's own tool calls spawned) are its DESCENDANTS.
 * `child.kill()` signals only the shell and orphans that tree, so a stopped task keeps
 * running. `taskkill /t` kills the tree and `/f` forces it.
 */
function terminateTree(child: ChildProcessWithoutNullStreams): void {
  const { pid } = child;
  if (pid !== undefined && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
}
