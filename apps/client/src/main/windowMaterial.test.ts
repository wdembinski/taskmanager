import { describe, expect, it } from 'vitest';
import { isRemoteSession, windowMaterialFor, windowsBuildOf } from './windowMaterial';

const noEnv = { remoteSession: false, reducedTransparency: false };

describe('windowMaterialFor', () => {
  it('gives mica on win32 at build 22621 and above', () => {
    expect(windowMaterialFor('win32', 22621, { transparency: 'system' }, noEnv)).toBe('mica');
    expect(windowMaterialFor('win32', 26200, { transparency: 'system' }, noEnv)).toBe('mica');
  });

  it('refuses below 22621, including Win11 21H2 and Win10', () => {
    expect(windowMaterialFor('win32', 22000, { transparency: 'system' }, noEnv)).toBe('none');
    expect(windowMaterialFor('win32', 19045, { transparency: 'system' }, noEnv)).toBe('none');
  });

  it('refuses on Linux (including WSL) and darwin regardless of build', () => {
    expect(windowMaterialFor('linux', 26200, { transparency: 'full' }, noEnv)).toBe('none');
    expect(windowMaterialFor('darwin', 26200, { transparency: 'full' }, noEnv)).toBe('none');
  });

  it('refuses when transparency is reduced, even when the OS would otherwise allow it', () => {
    expect(windowMaterialFor('win32', 26200, { transparency: 'reduced' }, noEnv)).toBe('none');
  });

  it('refuses under system when the OS reports reduced transparency', () => {
    expect(
      windowMaterialFor(
        'win32',
        26200,
        { transparency: 'system' },
        { ...noEnv, reducedTransparency: true },
      ),
    ).toBe('none');
  });

  it('allows mica under full even when the OS reports reduced transparency', () => {
    expect(
      windowMaterialFor(
        'win32',
        26200,
        { transparency: 'full' },
        { ...noEnv, reducedTransparency: true },
      ),
    ).toBe('mica');
  });

  it('refuses over a remote session, even under full', () => {
    expect(
      windowMaterialFor(
        'win32',
        26200,
        { transparency: 'full' },
        { ...noEnv, remoteSession: true },
      ),
    ).toBe('none');
  });

  it('treats a junk transparency value as system', () => {
    expect(windowMaterialFor('win32', 26200, { transparency: 42 }, noEnv)).toBe('mica');
    expect(
      windowMaterialFor(
        'win32',
        26200,
        { transparency: 'neon' },
        { ...noEnv, reducedTransparency: true },
      ),
    ).toBe('none');
  });
});

describe('windowsBuildOf', () => {
  it('parses the build out of a release string', () => {
    expect(windowsBuildOf('10.0.26200')).toBe(26200);
    expect(windowsBuildOf('6.1.7601')).toBe(7601);
  });

  it('falls back to 0 for junk', () => {
    expect(windowsBuildOf('')).toBe(0);
    expect(windowsBuildOf('garbage')).toBe(0);
  });
});

describe('isRemoteSession', () => {
  it('is true for an RDP session name', () => {
    expect(isRemoteSession({ SESSIONNAME: 'RDP-Tcp#3' })).toBe(true);
  });

  it('is false for a console session', () => {
    expect(isRemoteSession({ SESSIONNAME: 'Console' })).toBe(false);
  });

  it('is false when unset', () => {
    expect(isRemoteSession({})).toBe(false);
  });
});
