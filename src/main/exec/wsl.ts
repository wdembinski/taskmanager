/**
 * Talking to WSL itself: which distros exist, and whether one can run our work.
 *
 * Two details here are easy to get wrong and expensive to debug, so they are handled
 * once, here, rather than at each call site:
 *
 * 1. `wsl.exe` writes its LISTING output as UTF-16LE, not UTF-8. Decoded as UTF-8 it
 *    comes back as `U b u n t u` with NULs between every letter, which then fails to
 *    match any distro name. Anything that parses `wsl.exe` output must decode it.
 *
 * 2. Commands must run through a LOGIN shell (`bash -lc`). `claude` is commonly
 *    installed to `~/.local/bin`, which a non-login shell does not have on PATH —
 *    `wsl -e sh -c 'command -v claude'` finds nothing while `bash -lc` finds it. A
 *    login shell is also what makes a user's own environment (toolchain setup, build
 *    wrappers) present, which is the entire point of running the work in WSL.
 */
import { execFile } from 'node:child_process';
import type { ReadinessCheck, TargetReadiness } from '@shared/execTarget';
import { WSL_PATH_PRELUDE } from './wslHost';

/**
 * Decode `wsl.exe`'s OWN output (`-l -q`), which is UTF-16LE — decoded as UTF-8 it
 * yields `U\0b\0u\0…`, a distro list where every name silently fails to match.
 *
 * Sniffing a NUL in the second byte identifies it, because in UTF-16LE every ASCII
 * character is a byte followed by 0x00. That heuristic is only safe HERE, where the
 * content is a list of distro names: it must never be applied to the stdout of a
 * command run inside a distro, since `git ls-files -z` legitimately emits NUL
 * separators and a one-character filename would put one in exactly that position.
 * Command output is always decoded as UTF-8.
 */
export function decodeWslListing(buf: Buffer): string {
  const utf16 = buf.length > 1 && buf[1] === 0;
  return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/\0/g, '');
}

/** Distro names from `wsl -l -q` output, blank lines and stray whitespace removed. */
export function parseDistroList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Run `wsl.exe` and decode its output. Never throws.
 *
 * `listing` selects the encoding: `wsl.exe`'s own messages are UTF-16LE, while the
 * stdout of a command it ran is UTF-8. This is a parameter rather than a guess
 * because guessing is unsafe for command output (see `decodeWslListing`).
 */
function runWsl(
  args: string[],
  { listing = false, timeoutMs = 15_000 } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      args,
      { encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        const text = listing ? decodeWslListing(buf) : buf.toString('utf8');
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, stdout: text });
      },
    );
  });
}

/**
 * Every installed distro, in `wsl -l -q` order (the default distro first).
 * Returns an empty list when WSL is not installed at all.
 */
export async function listWslDistros(): Promise<string[]> {
  const { code, stdout } = await runWsl(['-l', '-q'], { listing: true });
  return code === 0 ? parseDistroList(stdout) : [];
}

/**
 * Run one command inside a distro through a login shell, capturing its output.
 *
 * Uses the SAME PATH prelude a real run uses, so the check can never disagree with
 * what a task would actually find — a readiness panel that says "installed" while
 * sessions fail to launch is worse than no panel at all.
 */
async function inDistro(distro: string, script: string): Promise<{ code: number; stdout: string }> {
  return runWsl(['-d', distro, '-e', 'bash', '-lc', `${WSL_PATH_PRELUDE}\n${script}`]);
}

/**
 * Check that a distro can actually run tasks: it responds, it has `claude`, that
 * `claude` is logged in, and Windows interop is available (which is how the
 * permission relay reaches the in-app broker — see `wslHost.relaySpec`).
 */
export async function probeWslTarget(distro: string): Promise<TargetReadiness> {
  const target = { kind: 'wsl', distro } as const;
  const checks: ReadinessCheck[] = [];

  const reachable = await inDistro(distro, 'echo ok');
  checks.push({
    id: 'distro',
    label: 'Distro responds',
    ok: reachable.code === 0,
    detail: reachable.code === 0 ? distro : reachable.stdout.trim() || 'no response',
    fix: reachable.code === 0 ? undefined : `Check that "${distro}" is installed and starts.`,
  });

  if (reachable.code !== 0) return { target, ok: false, checks };

  // Report WHERE it was found, not just that it was: when this fails on a machine we
  // cannot inspect, "not on PATH" alone gives nobody anything to act on.
  const version = await inDistro(distro, 'command -v claude && claude --version');
  const versionOk = version.code === 0;
  const foundAt = version.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const versionText = version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? '';
  checks.push({
    id: 'claude',
    label: 'Claude CLI found',
    ok: versionOk,
    detail: versionOk
      ? `${versionText || 'installed'} at ${foundAt}`
      : `not found. Searched PATH plus ~/.local/bin, ~/bin and ~/.nvm/versions/node/*/bin`,
    fix: versionOk
      ? undefined
      : `Install Claude Code inside ${distro}, or run \`command -v claude\` there and tell us where it lives.`,
  });

  const auth = await inDistro(distro, 'test -f "$HOME/.claude/.credentials.json" && echo yes');
  const authOk = auth.code === 0 && auth.stdout.includes('yes');
  checks.push({
    id: 'auth',
    label: 'Logged in',
    ok: authOk,
    detail: authOk ? 'subscription credentials present' : 'no credentials file',
    fix: authOk ? undefined : `Run \`claude\` once inside ${distro} and sign in.`,
  });

  // Interop lets the CLI (running in Linux) launch our relay as a WINDOWS process, so
  // it can reach the broker on Windows loopback. Without it, tool-use approval has no
  // transport and every gated run would be denied.
  const interop = await inDistro(distro, 'grep -q enabled /proc/sys/fs/binfmt_misc/WSLInterop*');
  checks.push({
    id: 'interop',
    label: 'Windows interop enabled',
    ok: interop.code === 0,
    detail: interop.code === 0 ? 'enabled' : 'disabled',
    fix:
      interop.code === 0
        ? undefined
        : 'Enable interop (`[interop] enabled=true` in /etc/wsl.conf) — the tool-approval relay needs it.',
  });

  return { target, ok: checks.every((c) => c.ok), checks };
}
