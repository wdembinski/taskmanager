/**
 * The parts of the sign-in helper that can be checked without opening a window: where the
 * credential lives, and the exact shape of each platform's terminal invocation.
 *
 * The Windows one is the reason this file exists. `start` reads its first quoted argument
 * as the window TITLE, so `cmd /c start "cmd /k claude"` opens an empty console named
 * after the command — a button that appears to work and signs nobody in.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecHost } from './exec';
import { credentialsPath, credentialsStamp, signInCommand } from './signIn';

describe('signInCommand', () => {
  it('passes an empty title on Windows so the command is not eaten by start', () => {
    const cmd = signInCommand('win32');
    expect(cmd).toEqual({ file: 'cmd', args: ['/c', 'start', '', 'cmd', '/k', 'claude'] });
    // The empty string must come BEFORE the shell that runs claude, or it is the title.
    expect(cmd?.args.indexOf('')).toBeLessThan(cmd?.args.indexOf('claude') ?? 0);
  });

  it('drives Terminal.app through osascript on macOS', () => {
    const cmd = signInCommand('darwin');
    expect(cmd?.file).toBe('osascript');
    expect(cmd?.args.join(' ')).toContain('do script "claude"');
  });

  it('starts from the Debian alternatives entry on Linux', () => {
    expect(signInCommand('linux')).toEqual({ file: 'x-terminal-emulator', args: ['-e', 'claude'] });
  });

  /** The same empty-title trap, plus wslHost's rule: positional arguments, never a script. */
  it('opens the distro through wsl.exe on Windows', () => {
    const cmd = signInCommand('win32', { kind: 'wsl', distro: 'Ubuntu-24.04' });
    expect(cmd).toEqual({
      file: 'cmd',
      args: ['/c', 'start', '', 'wsl.exe', '-d', 'Ubuntu-24.04', '-e', 'bash', '-lc', 'claude'],
    });
    expect(cmd?.args.indexOf('')).toBeLessThan(cmd?.args.indexOf('wsl.exe') ?? 0);
  });

  /** This process has no window to put a distro's terminal in outside Windows. */
  it('has no recipe for a WSL target off Windows', () => {
    expect(signInCommand('darwin', { kind: 'wsl', distro: 'Ubuntu-24.04' })).toBeNull();
    expect(signInCommand('linux', { kind: 'wsl', distro: 'Ubuntu-24.04' })).toBeNull();
  });
});

describe('credentialsPath', () => {
  it('points at the file the CLI rewrites on a successful login', () => {
    expect(credentialsPath('/home/w').replace(/\\/g, '/')).toBe(
      '/home/w/.claude/.credentials.json',
    );
  });
});

describe('credentialsStamp', () => {
  function fakeHost(exec: ExecHost['exec']): ExecHost {
    return {
      target: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      exec,
      spawn: vi.fn(),
      toNative: (p: string) => p,
      toApp: (p: string) => p,
      relaySpec: vi.fn(),
      homeDir: () => Promise.resolve('/home/w'),
    };
  }

  it('reads a WSL host through its own stat, converted to epoch ms', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '1700000000\n', stderr: '' });
    const stamp = await credentialsStamp(fakeHost(exec));
    expect(stamp).toBe(1_700_000_000_000);
    // The same $HOME-inside-the-distro idiom the readiness probe uses for this file.
    expect(exec).toHaveBeenCalledWith('/', 'sh', [
      '-c',
      'stat -c %Y "$HOME/.claude/.credentials.json"',
    ]);
  });

  it('is null, not a throw, when the WSL host has no credential to stat', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'No such file' });
    expect(await credentialsStamp(fakeHost(exec))).toBeNull();
  });

  it('is null when the host answers with something that is not a number', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'not-a-number\n', stderr: '' });
    expect(await credentialsStamp(fakeHost(exec))).toBeNull();
  });
});
