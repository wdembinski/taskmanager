/**
 * The parts of the sign-in helper that can be checked without opening a window: where the
 * credential lives, and the exact shape of each platform's terminal invocation.
 *
 * The Windows one is the reason this file exists. `start` reads its first quoted argument
 * as the window TITLE, so `cmd /c start "cmd /k claude"` opens an empty console named
 * after the command — a button that appears to work and signs nobody in.
 */
import { describe, expect, it } from 'vitest';
import { credentialsPath, signInCommand } from './signIn';

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
});

describe('credentialsPath', () => {
  it('points at the file the CLI rewrites on a successful login', () => {
    expect(credentialsPath('/home/w').replace(/\\/g, '/')).toBe(
      '/home/w/.claude/.credentials.json',
    );
  });
});
