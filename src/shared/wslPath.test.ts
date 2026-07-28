/**
 * Path translation is pure string work on every path in every command, so it is
 * tested against the edge cases that actually bite: drive roots, mixed separators,
 * the legacy `\\wsl$` prefix, and round-tripping.
 */
import { describe, expect, it } from 'vitest';
import { distroFromWindowsPath, isDistroPath, linuxToWindows, windowsToLinux } from './wslPath';

const DISTRO = 'Ubuntu-20.04';

describe('linuxToWindows', () => {
  it('maps the distro filesystem onto the UNC share', () => {
    expect(linuxToWindows('/home/you/repo', DISTRO)).toBe(
      '\\\\wsl.localhost\\Ubuntu-20.04\\home\\you\\repo',
    );
  });

  it('sends a mounted Windows drive back to its drive letter, not the share', () => {
    expect(linuxToWindows('/mnt/c/Repositories/foo', DISTRO)).toBe('C:\\Repositories\\foo');
  });

  it('handles a drive root', () => {
    expect(linuxToWindows('/mnt/c', DISTRO)).toBe('C:\\');
    expect(linuxToWindows('/mnt/d/', DISTRO)).toBe('D:\\');
  });

  it('handles the distro root', () => {
    expect(linuxToWindows('/', DISTRO)).toBe('\\\\wsl.localhost\\Ubuntu-20.04');
  });

  it('leaves a relative path alone', () => {
    expect(linuxToWindows('src/main', DISTRO)).toBe('src/main');
  });
});

describe('windowsToLinux', () => {
  it('maps a drive path under /mnt', () => {
    expect(windowsToLinux('C:\\Repositories\\foo')).toBe('/mnt/c/Repositories/foo');
  });

  it('accepts forward slashes and a bare drive', () => {
    expect(windowsToLinux('C:/Repositories/foo')).toBe('/mnt/c/Repositories/foo');
    expect(windowsToLinux('C:')).toBe('/mnt/c');
    expect(windowsToLinux('C:\\')).toBe('/mnt/c');
  });

  it('unwraps the UNC share back to a distro path', () => {
    expect(windowsToLinux('\\\\wsl.localhost\\Ubuntu-20.04\\home\\you\\repo')).toBe(
      '/home/you/repo',
    );
  });

  it('accepts the legacy \\\\wsl$ prefix the picker may still produce', () => {
    expect(windowsToLinux('\\\\wsl$\\Ubuntu-20.04\\home\\you')).toBe('/home/you');
  });

  it('is idempotent on a path that is already Linux', () => {
    expect(windowsToLinux('/home/you/repo')).toBe('/home/you/repo');
  });
});

describe('round trips', () => {
  it('survives distro -> windows -> distro', () => {
    for (const p of ['/home/you/repo', '/opt/yocto/poky', '/']) {
      expect(windowsToLinux(linuxToWindows(p, DISTRO))).toBe(p);
    }
  });

  it('survives windows -> distro -> windows', () => {
    for (const p of ['C:\\Repositories\\foo', 'D:\\a\\b']) {
      expect(linuxToWindows(windowsToLinux(p), DISTRO)).toBe(p);
    }
  });
});

describe('distroFromWindowsPath', () => {
  it('names the distro a picked folder belongs to', () => {
    expect(distroFromWindowsPath('\\\\wsl.localhost\\Ubuntu-20.04\\home\\you')).toBe(
      'Ubuntu-20.04',
    );
    expect(distroFromWindowsPath('\\\\wsl$\\Debian\\srv')).toBe('Debian');
  });

  it('is null for an ordinary Windows path', () => {
    expect(distroFromWindowsPath('C:\\Repositories\\foo')).toBeNull();
  });
});

describe('isDistroPath', () => {
  it('separates the distro filesystem from mounted Windows drives', () => {
    expect(isDistroPath('/home/you/repo')).toBe(true);
    expect(isDistroPath('/mnt/c/Repositories/foo')).toBe(false);
    expect(isDistroPath('C:\\Repositories\\foo')).toBe(false);
  });
});
