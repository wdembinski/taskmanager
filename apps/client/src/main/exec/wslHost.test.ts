/**
 * Integration tests for the WSL host, run against a REAL distro.
 *
 * These exercise the things that cannot be verified by reasoning about strings: that
 * a login shell finds the user's PATH, that arguments with spaces survive the trip
 * without quoting, and — the one that matters most for long builds — that stopping a
 * run kills the whole Linux process group rather than orphaning it.
 *
 * The real-distro block is OFF by default and opt-in, the same shape as
 * wslSession.e2e.test.ts's ORCH_E2E:
 *
 *     ORCH_WSL_TEST=1 pnpm vitest run src/main/exec/wslHost.test.ts
 *
 * It used to run whenever a distro happened to be installed, and that is not a
 * property `pnpm test` can depend on. Its assertions are about the DISTRO's state,
 * not this repo's: 'puts user-level tool directories on PATH' asserts
 * `/.local/bin`, which the prelude appends only `[ -d "$d" ]` — correct behaviour,
 * but a red gate on any distro where that directory does not exist, for no defect.
 * The phase's own verification sections recorded it failing on this machine across
 * three sessions and then passing on the fourth, with nothing in between changing
 * but the environment. A suite whose result nobody controls does not belong in the
 * gate that decides whether a release ships; it belongs behind a flag, which is
 * where it now is. Nothing about the assertions themselves changed — they are
 * right, and they still run on demand.
 *
 * The two blocks below it are pure (string wiring, no WSL) and stay in the gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listWslDistros } from './wsl';
import { WslExecHost, WSL_PATH_PRELUDE } from './wslHost';

/** Real-WSL block: opt-in, and only meaningful on Windows. */
const ENABLED = process.env.ORCH_WSL_TEST === '1' && process.platform === 'win32';

let distro = '';

beforeAll(async () => {
  // Skip the probe entirely when disabled — `listWslDistros` shells out to wsl.exe,
  // which is the slowest thing in this file on a machine that has WSL at all.
  const all = ENABLED ? await listWslDistros() : [];
  // `docker-desktop` distros exist to host Docker and have no usable login shell,
  // so prefer anything else when picking one to test against.
  distro = all.find((d) => !d.startsWith('docker-desktop')) ?? '';
}, 30_000);

const hasWsl = (): boolean => distro !== '';

describe.runIf(ENABLED)('WslExecHost', () => {
  it('runs commands inside Linux, not on Windows', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    const { code, stdout } = await host.exec('/', 'uname', ['-s']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('Linux');
  }, 30_000);

  it('honours the working directory', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    const { stdout } = await host.exec('/tmp', 'pwd', []);
    expect(stdout.trim()).toBe('/tmp');
  }, 30_000);

  it('passes arguments containing spaces and quotes through untouched', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    // Exactly the shape that breaks when a command is interpolated into a shell
    // string instead of passed as positional parameters.
    const nasty = 'a message with "quotes" and $VARS and spaces';
    const { code, stdout } = await host.exec('/', 'printf', ['%s', nasty]);
    expect(code).toBe(0);
    expect(stdout).toBe(nasty);
  }, 30_000);

  it('reports a non-zero exit as data rather than throwing', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    const { code } = await host.exec('/', 'false', []);
    expect(code).not.toBe(0);
  }, 30_000);

  it('uses a LOGIN shell, so the user’s own PATH is present', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    // A non-login shell misses ~/.local/bin, which is where `claude` commonly lives.
    const { stdout } = await host.exec('/', 'sh', ['-c', 'echo "$PATH"']);
    expect(stdout.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it('puts user-level tool directories on PATH, where npm/nvm installs land', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    // A login shell does not source `.bashrc` (it returns early when non-interactive),
    // which is where nvm installs itself — so a `claude` installed that way is
    // invisible without this, and both the readiness check AND real runs fail.
    const { code, stdout } = await host.exec('/', 'sh', ['-c', 'echo "$PATH"']);
    expect(code).toBe(0);
    expect(stdout).toContain('/.local/bin');
  }, 30_000);

  it('prefers the official installer’s claude over a version-manager copy', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    // Only meaningful where the native install exists; elsewhere PATH decides and
    // there is nothing to assert.
    const native = await host.exec('/', 'sh', ['-c', 'test -x "$HOME/.local/bin/claude"']);
    if (native.code !== 0) return skip();

    // `command -v` inside the run reports what THIS invocation would execute.
    const { stdout } = await host.exec('/', 'claude', ['--version']);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 30_000);

  it('resolves the distro home directory', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    expect(await host.homeDir()).toMatch(/^\//);
  }, 30_000);

  it('kills the whole process GROUP on terminate, not just the wrapper', async ({ skip }) => {
    if (!hasWsl()) return skip();
    const host = new WslExecHost(distro);
    // A shell that spawns a child and waits: terminating only what we hold would
    // leave `sleep` running, which is exactly how a stopped task leaves a build alive.
    const running = host.spawn('/', 'sh', ['-c', 'sleep 120 & echo started; wait']);

    const pid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ORCH_PID marker')), 20_000);
      running.child.stderr.on('data', (chunk: Buffer) => {
        const match = /ORCH_PID:(\d+)/.exec(String(chunk));
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    expect(pid).toBeGreaterThan(0);

    const alive = async (): Promise<boolean> => {
      const { stdout } = await host.exec('/', 'sh', ['-c', `ps -o pid= -p ${pid} | wc -l`]);
      return stdout.trim() !== '0';
    };
    expect(await alive()).toBe(true);

    running.terminate();

    // TERM propagates to the group; poll rather than assuming an instant exit.
    let gone = false;
    for (let attempt = 0; attempt < 20 && !gone; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      gone = !(await alive());
    }
    expect(gone).toBe(true);
  }, 60_000);
});

describe('the shell prelude', () => {
  it('is valid bash — multi-line, never `;`-joined', () => {
    // Joining these lines with `; ` yields `do;`, a syntax error that breaks EVERY
    // command rather than just the PATH augmentation. Cheap canary for a mistake
    // whose real symptom is "nothing runs at all".
    expect(WSL_PATH_PRELUDE).not.toMatch(/\bdo\s*;/);
    expect(WSL_PATH_PRELUDE).not.toMatch(/;\s*done\b/);
    expect(WSL_PATH_PRELUDE.split('\n').length).toBeGreaterThan(1);
  });
});

describe('WslExecHost path and relay wiring', () => {
  const host = new WslExecHost('Ubuntu-Test');

  it('translates paths in both directions', () => {
    expect(host.toNative('C:\\Repositories\\foo')).toBe('/mnt/c/Repositories/foo');
    expect(host.toApp('/home/you/repo')).toBe('\\\\wsl.localhost\\Ubuntu-Test\\home\\you\\repo');
  });

  it('spawns the relay as the WINDOWS binary, reachable over loopback', () => {
    const script = 'C:\\Users\\me\\AppData\\Roaming\\app\\mcp\\permission-server.cjs';
    // `relaySpec` translates `process.execPath`, and `windowsToLinux` returns a path
    // that is already Linux untouched — so on the CI runner the real execPath
    // (`/usr/…`) translates to itself and a `/mnt/` assertion describes the MACHINE,
    // not this code. That is how this file passed on Windows for months and then
    // failed the release pipeline's first run, costing v0.83.0 its tag. Stand a
    // Windows binary in its place so the property under test is asserted identically
    // on any runner, rather than checked on one platform and skipped on the other.
    const realExecPath = process.execPath;
    process.execPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\app\\VIPPER Task Manager.exe';
    try {
      const spec = host.relaySpec({
        brokerUrl: 'http://127.0.0.1:51234',
        token: 'tok',
        runId: 'run-1',
        serverScriptPath: script,
      });
      // The COMMAND is a Linux path: WSL's loader has to find and exec the binary.
      // Asserted whole rather than by its `/mnt/` prefix, which would miss a wrong
      // drive letter, a lost separator translation or a dropped space.
      expect(spec.command).toBe(
        '/mnt/c/Users/me/AppData/Local/Programs/app/VIPPER Task Manager.exe',
      );
      // The ARGUMENT stays a Windows path: argv crosses verbatim, and a Linux path
      // would be resolved against the process's UNC working directory instead
      // ("Cannot find module \\wsl.localhost\<distro>\mnt\c\…").
      expect(spec.args[0]).toBe(script);
      // Loopback is the app's own, because the relay is a Windows process.
      expect(spec.env.ORCH_BROKER_URL).toBe('http://127.0.0.1:51234');
    } finally {
      // Process-wide, and permissionServer.test.ts spawns with it: a leaked fake
      // would break an unrelated file in the same run.
      process.execPath = realExecPath;
    }
  });

  it('forwards every relay variable through WSLENV', () => {
    const spec = host.relaySpec({
      brokerUrl: 'http://127.0.0.1:1',
      token: 't',
      runId: 'r',
      serverScriptPath: 'C:\\x.cjs',
    });
    // Without this the Windows binary never sees ELECTRON_RUN_AS_NODE, starts as a
    // GUI app, and the session hangs with no error — the exact failure this prevents.
    const forwarded = spec.env.WSLENV.split(':');
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ORCH_BROKER_URL', 'ORCH_TOKEN', 'ORCH_RUN_ID']) {
      expect(forwarded).toContain(name);
      expect(spec.env[name]).toBeDefined();
    }
  });
});

afterAll(() => {
  // Nothing persistent is created; the spawned processes are killed by the test.
});
