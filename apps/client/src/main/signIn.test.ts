/**
 * The parts of the sign-in helper that can be checked without opening a window: where the
 * credential lives, and the exact shape of each platform's terminal invocation.
 *
 * The Windows one is the reason this file exists. `start` reads its first quoted argument
 * as the window TITLE, so `cmd /c start "cmd /k claude"` opens an empty console named
 * after the command — a button that appears to work and signs nobody in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import type { ExecHost } from './exec';
import { credentialsPath, credentialsStamp, signInCommand, SignInProbe } from './signIn';

/**
 * `SignInProbe` resolves its host through `./exec`'s `hostFor`, not a constructor
 * argument, so the seam under test is that function rather than the class itself —
 * mocked here to a controllable `ExecHost` instead of touching a real filesystem or a
 * real WSL distro.
 */
const hostForMock = vi.hoisted(() => vi.fn());
vi.mock('./exec', () => ({ hostFor: hostForMock }));

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

/**
 * The one comparison the whole probe exists to make: a credential's stamp against the
 * gate's own `since`. Restoring a stale gate must not clear on a credential that has sat
 * there, untouched, since before the failure — only a stamp strictly NEWER than `since`
 * is a login that happened after the gate went up.
 */
describe('SignInProbe', () => {
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

  function gate(since: number): AuthState {
    return {
      since,
      reason: 'OAuth session expired',
      source: 'run',
      parkedTaskIds: [],
      target: { kind: 'wsl', distro: 'Ubuntu-24.04' },
    };
  }

  afterEach(() => {
    hostForMock.mockReset();
  });

  it('does not lift a gate whose credential stamp is no newer than `since`', async () => {
    // Stat reports seconds; 1000s === the gate's own `since` in ms, so this is the SAME
    // moment, not a later one.
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '1000\n', stderr: '' });
    hostForMock.mockReturnValue(fakeHost(exec));
    const onSignIn = vi.fn();
    const probe = new SignInProbe({ onSignIn, pollMs: 1_000_000 });
    probe.start(gate(1_000_000));
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());
    // Give the async check a beat to run past its await — there is nothing else to wait on.
    await new Promise((r) => setTimeout(r, 20));
    expect(onSignIn).not.toHaveBeenCalled();
    probe.stop();
  });

  it('lifts the gate once the credential stamp is strictly newer than `since`', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '1001\n', stderr: '' }); // 1_001_000ms
    hostForMock.mockReturnValue(fakeHost(exec));
    const onSignIn = vi.fn();
    const probe = new SignInProbe({ onSignIn, pollMs: 1_000_000 });
    probe.start(gate(1_000_000));
    await vi.waitFor(() => expect(onSignIn).toHaveBeenCalledTimes(1));
    probe.stop();
  });

  it('does not lift on a host with no credential to stat at all', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'No such file' });
    hostForMock.mockReturnValue(fakeHost(exec));
    const onSignIn = vi.fn();
    const probe = new SignInProbe({ onSignIn, pollMs: 1_000_000 });
    probe.start(gate(1_000_000));
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(onSignIn).not.toHaveBeenCalled();
    probe.stop();
  });

  it('checks immediately on start, catching a sign-in that happened while the app was closed', () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '1001\n', stderr: '' });
    hostForMock.mockReturnValue(fakeHost(exec));
    const probe = new SignInProbe({ onSignIn: vi.fn(), pollMs: 1_000_000 });
    probe.start(gate(1_000_000));
    // Called synchronously by `start`, well before the (huge) poll interval could fire.
    expect(exec).toHaveBeenCalledTimes(1);
    probe.stop();
  });

  it('a check already in flight cannot fire once stopped — no dangling onSignIn', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '1001\n', stderr: '' });
    hostForMock.mockReturnValue(fakeHost(exec));
    const onSignIn = vi.fn();
    const probe = new SignInProbe({ onSignIn, pollMs: 1_000_000 });
    probe.start(gate(1_000_000));
    probe.stop(); // stopped before the in-flight `exec` above resolves
    await new Promise((r) => setTimeout(r, 20));
    expect(onSignIn).not.toHaveBeenCalled();
  });
});
