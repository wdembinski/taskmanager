/**
 * The two halves of getting a human signed back in to the `claude` CLI: opening the
 * terminal that can do it, and noticing when they have.
 *
 * The CLI's login is an interactive OAuth flow — a browser, a code, a prompt. There is no
 * headless form of it, and the app holds no credential of its own to refresh, so it cannot
 * *perform* the sign-in. What it can do is remove every other step: put the right window
 * in front of the user, then detect success without asking them to come back and tell us.
 */
import { spawn } from 'node:child_process';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_TARGET, type ExecTarget } from '@shared/execTarget';
import type { AuthState } from '@shared/auth';
import { hostFor, type ExecHost } from './exec';
import { logMain } from './log';

/** Where the CLI keeps the subscription credential it rewrites on a successful login. */
export function credentialsPath(home: string = homedir()): string {
  return join(home, '.claude', '.credentials.json');
}

/**
 * The terminal invocation that opens an interactive `claude` on this platform, for
 * `target`'s host.
 *
 * Pure and exported so the table is testable without spawning anything — the shapes are
 * fiddly (`start`'s first quoted argument is the window TITLE, not the command, and
 * omitting the empty one silently swallows the real command) and worth pinning.
 *
 * `target` defaults to local so every existing caller (and the pinned tests below) keeps
 * asking for exactly what it always has. A WSL target only has a recipe on Windows — the
 * GUI's own terminal is the only one this process can put on screen, and from Linux or
 * macOS there is no window to hand a distro's login to.
 */
export function signInCommand(
  platform: NodeJS.Platform,
  target: ExecTarget = LOCAL_TARGET,
): { file: string; args: string[] } | null {
  if (target.kind === 'wsl') {
    if (platform !== 'win32') return null;
    // Same empty-title trap as the local case below, plus `wslHost.ts`'s rule: the
    // distro name and the command arrive as separate ARGUMENTS, never interpolated into
    // one script string.
    return {
      file: 'cmd',
      args: ['/c', 'start', '', 'wsl.exe', '-d', target.distro, '-e', 'bash', '-lc', 'claude'],
    };
  }
  switch (platform) {
    case 'win32':
      // `start ""` — the empty title is required: with a quoted command and no title,
      // cmd reads the command AS the title and opens an empty window.
      return { file: 'cmd', args: ['/c', 'start', '', 'cmd', '/k', 'claude'] };
    case 'darwin':
      return {
        file: 'osascript',
        args: [
          '-e',
          'tell application "Terminal" to do script "claude"',
          '-e',
          'tell application "Terminal" to activate',
        ],
      };
    default:
      // One of these exists on most desktop Linux; `x-terminal-emulator` is the Debian
      // alternatives entry and covers the majority without guessing at a desktop.
      return { file: 'x-terminal-emulator', args: ['-e', 'claude'] };
  }
}

/** Terminals to try in order on Linux, where there is no single right answer. */
const LINUX_FALLBACKS: ReadonlyArray<{ file: string; args: string[] }> = [
  { file: 'gnome-terminal', args: ['--', 'claude'] },
  { file: 'konsole', args: ['-e', 'claude'] },
  { file: 'xfce4-terminal', args: ['-e', 'claude'] },
  { file: 'xterm', args: ['-e', 'claude'] },
];

/** Spawn one detached terminal; resolves true once it is actually running. */
function trySpawn(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore' });
      // `spawn` and `error` are exclusive and exactly one always fires, so this settles.
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Open an interactive `claude` for the user to sign in with, on the gate's own failing
 * host. Resolves false when no terminal could be opened — a headless box, an unusual
 * desktop, or a target this process has no recipe for at all (a WSL distro reached from
 * anywhere but Windows) — which is the banner's cue to show the command rather than
 * claim the button worked.
 *
 * The Linux terminal ladder only ever applies to `target`'s OWN host: falling through it
 * for a WSL target whose `signInCommand` failed would open a window signing a DIFFERENT
 * machine's `claude` in, which is worse than doing nothing.
 */
export async function openInteractiveSignIn(
  target: ExecTarget = LOCAL_TARGET,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const first = signInCommand(platform, target);
  if (first && (await trySpawn(first.file, first.args))) return true;
  if (target.kind !== 'local') return false;
  if (platform === 'win32' || platform === 'darwin') return false;
  for (const fallback of LINUX_FALLBACKS) {
    if (await trySpawn(fallback.file, fallback.args)) return true;
  }
  return false;
}

/**
 * Call `onSignIn` when the CLI rewrites its credentials file — which is what a successful
 * login does, and the one signal that arrives without the human having to tell us.
 *
 * Watches the DIRECTORY, not the file: a credential is replaced atomically (write a temp,
 * rename over the top), which destroys the inode a file watch is bound to — so watching
 * the file itself sees the first login and then goes deaf. Watching `~/.claude` costs one
 * more callback per unrelated write there and never goes stale.
 *
 * Returns a disposer. Never throws: a missing `~/.claude` just means nothing to watch yet,
 * and the banner's button still works.
 */
export function watchForSignIn(onSignIn: () => void, home: string = homedir()): () => void {
  const dir = join(home, '.claude');
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && String(filename).includes('.credentials.json')) onSignIn();
    });
  } catch (err) {
    logMain('Could not watch for a Claude sign-in; the banner button still works', err);
    return () => undefined;
  }
  watcher.on('error', (err) => logMain('Sign-in watcher stopped', err));
  return () => watcher.close();
}

/** The shell idiom `probeWslTarget` already uses to find this file inside a distro. */
const STAT_CREDENTIALS_SCRIPT = 'stat -c %Y "$HOME/.claude/.credentials.json"';

/**
 * The credential's mtime (epoch ms), or null when it is absent. Never throws.
 *
 * Local reads the file directly. A non-local host has no filesystem this process can
 * touch, so it asks the host to `stat` it in its own login shell — the same
 * `$HOME`-inside-the-distro idiom `probeWslTarget` uses for the same file, so a readiness
 * check and this poll can never disagree about where it lives.
 */
export async function credentialsStamp(host: ExecHost): Promise<number | null> {
  if (host.target.kind === 'local') {
    try {
      return statSync(credentialsPath()).mtimeMs;
    } catch {
      return null;
    }
  }
  const result = await host.exec('/', 'sh', ['-c', STAT_CREDENTIALS_SCRIPT]);
  if (result.code !== 0) return null;
  const seconds = Number(result.stdout.trim());
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** How often {@link SignInProbe} re-checks a gate's host when nothing else has told it. */
export const SIGN_IN_POLL_MS = 20_000;

export interface SignInProbeDeps {
  /** The credential looks good again: lift the gate. */
  onSignIn(): void;
  /** Overridable for tests; production leaves this at {@link SIGN_IN_POLL_MS}. */
  pollMs?: number;
}

/**
 * The host-agnostic half of noticing a sign-in — alive only while a gate is up, and the
 * only path that can see a WSL distro's credential at all (the local `fs.watch` in
 * `watchForSignIn` only ever watches the machine the GUI runs on).
 *
 * `start` checks once immediately, which is what fixes the restored gate too: called the
 * moment a gate engages OR is restored, a sign-in that happened while the app was closed
 * is seen before the first poll interval even elapses. Every check afterwards is on a
 * modest timer — one `wsl.exe` call, no tokens, no turns — which also covers a local
 * watcher that died or never armed.
 */
export class SignInProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped on every start/stop so a check already in flight cannot fire against a gate
   *  it was not looking at (the human signed in, then a NEW failure raised the gate again
   *  before the old check's `host.exec` came back). */
  private generation = 0;

  constructor(private readonly deps: SignInProbeDeps) {}

  /** Watch the host `state` names, replacing whatever this was watching before. */
  start(state: AuthState): void {
    this.stop();
    const mine = ++this.generation;
    const host = hostFor(state.target);
    const since = state.since;
    const check = async (): Promise<void> => {
      const stamp = await credentialsStamp(host);
      if (mine !== this.generation) return; // superseded while the stat was in flight
      if (stamp !== null && stamp > since) this.deps.onSignIn();
    };
    void check();
    this.timer = setInterval(() => void check(), this.deps.pollMs ?? SIGN_IN_POLL_MS);
  }

  /** No gate is up: stop polling. */
  stop(): void {
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
