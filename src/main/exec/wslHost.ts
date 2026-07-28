/**
 * Running a project's work inside a WSL distro while the GUI stays on Windows.
 *
 * Three decisions here are load-bearing, and each was made against a measured
 * failure rather than a guess:
 *
 * **A login shell, always.** `claude` is commonly installed to `~/.local/bin`, which
 * a non-login shell does not have on PATH — `wsl -e sh -c 'command -v claude'` finds
 * nothing while `bash -lc` finds it. A login shell is also what puts the user's own
 * environment (toolchains, build wrappers) in place, which is the point of running
 * the work in Linux at all.
 *
 * **Arguments as positional parameters, never interpolated.** Wrapping a command in
 * `bash -lc "git commit -m $msg"` would reintroduce exactly the shell-quoting bugs
 * `git.ts` avoids by passing an argv array. Instead the script is a fixed string and
 * the real command arrives as `$1, $2, …`:
 *
 *     wsl.exe -d <distro> -e bash -lc '<script>' orch <cwd> git commit -m 'a message'
 *
 * so there is no escaping to get wrong and no injection surface. `cd` is done inside
 * the script rather than with `--cd`, which not every WSL build supports.
 *
 * **The permission relay stays a Windows process.** The CLI runs in Linux but spawns
 * our relay through WSL interop as the Windows binary, so it reaches the broker on
 * Windows loopback with no networking configuration at all — no mirrored-mode
 * `.wslconfig`, no firewall rule, and no Node required inside the distro. That in
 * turn depends on `WSLENV`: environment variables do NOT cross the WSL→Windows
 * boundary on their own, and without forwarding them Electron never sees
 * `ELECTRON_RUN_AS_NODE`, starts as a GUI app, and the session hangs.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { linuxToWindows, windowsToLinux } from '@shared/wslPath';
import type {
  ExecHost,
  ExecOptions,
  ExecResult,
  ExecTarget,
  RelaySpec,
  RelaySpecInput,
  SpawnedProcess,
} from './types';

/**
 * Put the directories user-level tools install into on PATH.
 *
 * A LOGIN shell has the user's profile, but not `.bashrc` — which returns early when
 * non-interactive, and is exactly where nvm (and friends) install themselves. So a
 * `claude` installed through npm/nvm works perfectly in the user's terminal and is
 * invisible to us, which looks like "the CLI isn't installed" and also makes sessions
 * fail to launch, not just the readiness check.
 *
 * Appended rather than prepended, so a system tool of the same name still wins.
 */
const AUGMENT_PATH = [
  'for d in "$HOME/.local/bin" "$HOME/bin"; do',
  '  [ -d "$d" ] && PATH="$PATH:$d"',
  'done',
  // Newest nvm-installed Node last, so it takes precedence over older ones.
  'for d in "$HOME"/.nvm/versions/node/*/bin; do',
  '  [ -d "$d" ] && PATH="$PATH:$d"',
  'done',
  'export PATH',
  // Joined with NEWLINES, not `;` — a semicolon after `do` is a bash syntax error,
  // which would break every command rather than just the PATH augmentation.
].join('\n');

/**
 * `cd` into the working directory, then replace the shell with the real command.
 * `exec` matters: it keeps the process id we printed, so the id we use to kill the
 * tree later is the command's own, not a wrapper's that has already exited.
 */
const RUN_SCRIPT = `${AUGMENT_PATH}\ncd "$1" || exit 1; shift; exec "$@"`;

/**
 * The same, but announcing the pid first. Stopping a run has to kill the whole
 * process GROUP — an agent that started a long build has descendants, and signalling
 * only what we hold orphans them to keep running after Stop.
 */
const RUN_SCRIPT_ANNOUNCE_PID = `echo "${'ORCH_PID'}:$$" 1>&2; ${RUN_SCRIPT}`;

/** Shared with the readiness probe so a check and a real run resolve tools identically. */
export const WSL_PATH_PRELUDE = AUGMENT_PATH;

/** Marker the spawn wrapper prints on stderr so we can learn the Linux-side pid. */
const PID_MARKER = /^ORCH_PID:(\d+)$/m;

/** How long a stopped process group gets to exit on TERM before it is killed. */
const KILL_GRACE_MS = 3_000;

export class WslExecHost implements ExecHost {
  readonly target: ExecTarget;
  private readonly distro: string;
  private cachedHome: string | null = null;

  constructor(distro: string) {
    this.distro = distro;
    this.target = { kind: 'wsl', distro };
  }

  /** `wsl.exe` argv that runs `file args…` in `cwd` through a login shell. */
  private argv(cwd: string, file: string, args: string[], script = RUN_SCRIPT): string[] {
    // `bash -lc SCRIPT NAME ARG1 …` sets $0=NAME and $1=ARG1, so the command and its
    // arguments arrive as data. 'orch' is only ever $0 (what errors are labelled with).
    return ['-d', this.distro, '-e', 'bash', '-lc', script, 'orch', cwd, file, ...args];
  }

  async exec(
    cwd: string,
    file: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        'wsl.exe',
        this.argv(cwd, file, args),
        {
          windowsHide: true,
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          // Command output is UTF-8. It is never sniffed for UTF-16, because
          // `git -z` output can legitimately carry a NUL in the second byte.
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          const e = err as { code?: number | string } | null;
          const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  }

  spawn(cwd: string, file: string, args: string[]): SpawnedProcess {
    const child = spawn('wsl.exe', this.argv(cwd, file, args, RUN_SCRIPT_ANNOUNCE_PID), {
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    // Learn the Linux-side pid from the wrapper's first stderr line. Watching without
    // consuming: the caller still receives every stderr chunk, including this one.
    let linuxPid: number | null = null;
    const watchForPid = (chunk: Buffer | string): void => {
      if (linuxPid !== null) return;
      const match = PID_MARKER.exec(String(chunk));
      if (match) {
        linuxPid = Number(match[1]);
        child.stderr.off('data', watchForPid);
      }
    };
    child.stderr.on('data', watchForPid);

    return {
      child,
      terminate: () => {
        // Kill the Linux process GROUP, not just `wsl.exe`: ending the Windows side
        // does not reliably reap the tree underneath, which is how a stopped task
        // leaves a build still running.
        if (linuxPid !== null) this.killGroup(linuxPid);
        child.kill();
      },
    };
  }

  /** TERM the process group, then KILL anything still alive after a grace period. */
  private killGroup(pid: number): void {
    const signal = (sig: string): void => {
      // `ps -o pgid=` resolves the group; killing a NEGATIVE pgid signals every
      // member, which is what reaches an agent's own subprocesses.
      const script =
        'pgid=$(ps -o pgid= -p "$1" 2>/dev/null | tr -d " "); ' +
        `[ -n "$pgid" ] && kill -${sig} -"$pgid" 2>/dev/null; exit 0`;
      try {
        spawn('wsl.exe', ['-d', this.distro, '-e', 'bash', '-lc', script, 'orch', String(pid)], {
          windowsHide: true,
        });
      } catch {
        // Nothing to do — the distro may already be gone, which is also "stopped".
      }
    };
    signal('TERM');
    setTimeout(() => signal('KILL'), KILL_GRACE_MS).unref();
  }

  /** A Windows path as the distro sees it: `C:\x` -> `/mnt/c/x`. */
  toNative(path: string): string {
    return windowsToLinux(path);
  }

  /** A distro path Windows `fs` can open: `/home/u/x` -> `\\wsl.localhost\<distro>\home\u\x`. */
  toApp(path: string): string {
    return linuxToWindows(path, this.distro);
  }

  /**
   * The CLI runs in Linux, but the relay it spawns is the WINDOWS binary, reached
   * through interop — so the relay can talk to the broker over plain loopback.
   *
   * Note the deliberate asymmetry between `command` and `args`, which is NOT a
   * mistake and breaks confusingly if "corrected":
   *
   *   - `command` is a LINUX path (`/mnt/c/…/app.exe`), because it is WSL's loader
   *     that has to find and exec the binary.
   *   - `args[0]` is a WINDOWS path (`C:\…\permission-server.cjs`), because arguments
   *     are handed to the Windows process verbatim — no translation happens. Passed a
   *     Linux path, the process resolves `/mnt/c/…` against its own working directory
   *     (a `\\wsl.localhost\…` UNC when the session runs on the distro's filesystem)
   *     and fails with "Cannot find module \\wsl.localhost\<distro>\mnt\c\…".
   *
   * `WSLENV` is not optional either. Environment variables do not cross the boundary
   * by themselves; without listing them here Electron never sees
   * `ELECTRON_RUN_AS_NODE`, launches as a GUI application instead of Node, and the
   * session hangs with no error at all.
   */
  relaySpec(input: RelaySpecInput): RelaySpec {
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      ORCH_BROKER_URL: input.brokerUrl,
      ORCH_TOKEN: input.token,
      ORCH_RUN_ID: input.runId,
    };
    return {
      command: this.toNative(process.execPath),
      args: [input.serverScriptPath],
      // Names only (no `/p` flag): these are values, not paths, and must cross verbatim.
      env: { ...env, WSLENV: Object.keys(env).join(':') },
    };
  }

  async homeDir(): Promise<string> {
    if (this.cachedHome) return this.cachedHome;
    const { code, stdout } = await this.exec('/', 'sh', ['-c', 'echo "$HOME"']);
    const home = stdout.trim();
    // Fall back to the conventional location rather than failing: a missing $HOME
    // should not stop the app from siting its own data.
    this.cachedHome = code === 0 && home.startsWith('/') ? home : '/root';
    return this.cachedHome;
  }
}
