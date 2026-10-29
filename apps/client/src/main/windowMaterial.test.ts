import { describe, expect, it } from 'vitest';
import { WINDOW_CANVAS } from '@shared/canvas';
import {
  backdropChangeFor,
  isRemoteSession,
  windowBackdropFor,
  windowMaterialFor,
  windowsBuildOf,
} from './windowMaterial';

const noEnv = { remoteSession: false, reducedTransparency: false, highContrast: false };

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

  it('refuses under full too when the OS reports reduced transparency — full no longer overrides it', () => {
    expect(
      windowMaterialFor(
        'win32',
        26200,
        { transparency: 'full' },
        { ...noEnv, reducedTransparency: true },
      ),
    ).toBe('none');
  });

  it('refuses under high contrast, even under full', () => {
    expect(
      windowMaterialFor('win32', 26200, { transparency: 'full' }, { ...noEnv, highContrast: true }),
    ).toBe('none');
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

describe('windowBackdropFor', () => {
  // scheme (light / dark / system × OS dark) × OS transparency × setting × high contrast.
  const schemes = [
    { appearance: 'light', prefersDark: false, scheme: 'light' },
    { appearance: 'light', prefersDark: true, scheme: 'light' },
    { appearance: 'dark', prefersDark: false, scheme: 'dark' },
    { appearance: 'dark', prefersDark: true, scheme: 'dark' },
    { appearance: 'system', prefersDark: false, scheme: 'light' },
    { appearance: 'system', prefersDark: true, scheme: 'dark' },
  ] as const;
  const settings: { transparency: unknown; refuses: boolean }[] = [
    { transparency: 'system', refuses: false },
    { transparency: 'full', refuses: false },
    { transparency: 'reduced', refuses: true },
    { transparency: 'neon', refuses: false },
  ];

  const cases = schemes.flatMap((s) =>
    [false, true].flatMap((osTransparencyOff) =>
      settings.flatMap((setting) =>
        [false, true].map((highContrast) => {
          const granted = !osTransparencyOff && !setting.refuses && !highContrast;
          return {
            name:
              `${s.appearance}${s.appearance === 'system' ? ` (OS ${s.prefersDark ? 'dark' : 'light'})` : ''}` +
              `, OS transparency ${osTransparencyOff ? 'off' : 'on'}` +
              `, setting ${String(setting.transparency)}` +
              `${highContrast ? ', high contrast' : ''}`,
            appearance: s.appearance,
            transparency: setting.transparency,
            env: {
              remoteSession: false,
              reducedTransparency: osTransparencyOff,
              highContrast,
              prefersDark: s.prefersDark,
            },
            expected: granted
              ? { material: 'mica', backgroundColor: '#00000000' }
              : { material: 'none', backgroundColor: WINDOW_CANVAS[s.scheme] },
          };
        }),
      ),
    ),
  );

  it.each(cases)('$name', ({ appearance, transparency, env, expected }) => {
    expect(windowBackdropFor('win32', 26200, { appearance, transparency }, env)).toEqual(expected);
  });

  it('paints the dark canvas, not the light fallback, for Dark + Full with OS transparency off', () => {
    expect(
      windowBackdropFor(
        'win32',
        26200,
        { appearance: 'dark', transparency: 'full' },
        { remoteSession: false, reducedTransparency: true, highContrast: false, prefersDark: true },
      ),
    ).toEqual({ material: 'none', backgroundColor: WINDOW_CANVAS.dark });
  });

  it('paints the scheme canvas wherever the platform refuses the material', () => {
    const env = {
      remoteSession: false,
      reducedTransparency: false,
      highContrast: false,
      prefersDark: true,
    };
    expect(
      windowBackdropFor('linux', 26200, { appearance: 'system', transparency: 'full' }, env),
    ).toEqual({ material: 'none', backgroundColor: WINDOW_CANVAS.dark });
    expect(
      windowBackdropFor('win32', 19045, { appearance: 'light', transparency: 'full' }, env),
    ).toEqual({ material: 'none', backgroundColor: WINDOW_CANVAS.light });
    expect(
      windowBackdropFor(
        'win32',
        26200,
        { appearance: 'dark', transparency: 'full' },
        { ...env, remoteSession: true },
      ),
    ).toEqual({ material: 'none', backgroundColor: WINDOW_CANVAS.dark });
  });
});

describe('backdropChangeFor', () => {
  const mica = { material: 'mica', backgroundColor: '#00000000' } as const;
  const darkCanvas = { material: 'none', backgroundColor: WINDOW_CANVAS.dark } as const;
  const lightCanvas = { material: 'none', backgroundColor: WINDOW_CANVAS.light } as const;

  it('does nothing when the backdrop is unchanged', () => {
    expect(backdropChangeFor(mica, mica)).toEqual({
      material: null,
      backgroundColor: null,
      notify: false,
      nativeMaterial: 'mica',
    });
    expect(backdropChangeFor(darkCanvas, darkCanvas)).toEqual({
      material: null,
      backgroundColor: null,
      notify: false,
      nativeMaterial: null,
    });
  });

  it('switches mica off with the scheme canvas and tells the renderer null', () => {
    // The OS "Transparency effects" switch turned off under an open Mica window.
    expect(backdropChangeFor(mica, darkCanvas)).toEqual({
      material: 'none',
      backgroundColor: WINDOW_CANVAS.dark,
      notify: true,
      nativeMaterial: null,
    });
  });

  it('switches mica on with a transparent colour and tells the renderer mica', () => {
    expect(backdropChangeFor(lightCanvas, mica)).toEqual({
      material: 'mica',
      backgroundColor: '#00000000',
      notify: true,
      nativeMaterial: 'mica',
    });
  });

  it('repaints only the colour when the scheme changes with no material', () => {
    expect(backdropChangeFor(darkCanvas, lightCanvas)).toEqual({
      material: null,
      backgroundColor: WINDOW_CANVAS.light,
      notify: false,
      nativeMaterial: null,
    });
  });

  it('follows the resolver through a live OS transparency change', () => {
    const settings = { appearance: 'dark', transparency: 'full' };
    const env = { ...noEnv, prefersDark: true };
    const before = windowBackdropFor('win32', 26200, settings, env);
    const after = windowBackdropFor('win32', 26200, settings, {
      ...env,
      reducedTransparency: true,
    });
    expect(backdropChangeFor(before, after)).toMatchObject({ material: 'none', notify: true });
    expect(backdropChangeFor(after, before)).toMatchObject({ material: 'mica', notify: true });
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
