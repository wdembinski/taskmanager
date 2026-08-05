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
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logMain } from './log';

/** Where the CLI keeps the subscription credential it rewrites on a successful login. */
export function credentialsPath(home: string = homedir()): string {
  return join(home, '.claude', '.credentials.json');
}

/**
 * The terminal invocation that opens an interactive `claude` on this platform.
 *
 * Pure and exported so the table is testable without spawning anything — the shapes are
 * fiddly (`start`'s first quoted argument is the window TITLE, not the command, and
 * omitting the empty one silently swallows the real command) and worth pinning.
 */
export function signInCommand(platform: NodeJS.Platform): { file: string; args: string[] } | null {
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
 * Open an interactive `claude` for the user to sign in with. Resolves false when no
 * terminal could be opened — a headless box, an unusual desktop, a project that executes
 * on another host — which is the banner's cue to show the command rather than claim the
 * button worked.
 *
 * Note what this deliberately does NOT do: run the sign-in on a project's exec host. A
 * WSL or remote target has its own credential, and its own terminal that this process
 * cannot put on screen; pretending otherwise would open a window signing in to the wrong
 * machine. The banner names the command so that case stays solvable by hand.
 */
export async function openInteractiveSignIn(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const first = signInCommand(platform);
  if (first && (await trySpawn(first.file, first.args))) return true;
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
